import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { createDeletionReview } from "../src/server/deletion.ts";
import { command } from "./support/repository.ts";

const workspaceId = "de1e7e01";
let dataDir: string;
let previousDataDir: string | undefined;
const { clearDeletionReview, deletionReviewCommitResponse, deletionReviewFileResponse, changesDeletionReview } = createDeletionReview((id, path) => localRepository(join(dataDir, "workspaces", id, "work", path)));

beforeEach(async () => {
  previousDataDir = process.env.KINTSUGI_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-deletion-review-"));
  process.env.KINTSUGI_DATA_DIR = dataDir;
});

afterEach(async () => {
  clearDeletionReview(workspaceId);
  if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

async function workspaceRepository(): Promise<string> {
  const root = join(dataDir, "workspaces", workspaceId, "work");
  await mkdir(root, { recursive: true });
  await command(root, "git", "init", "-q");
  await command(root, "git", "config", "user.email", "review@example.test");
  await command(root, "git", "config", "user.name", "Review Test");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  await command(root, "git", "add", "tracked.txt");
  await command(root, "git", "commit", "-qm", "initial");
  await command(root, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
}

describe("Workspace deletion review", () => {
  test("blocks deletion for local commits without contacting the remote", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "remote", "add", "origin", "https://127.0.0.1:1/unreachable.git");
    await writeFile(join(root, "committed.txt"), "local commit\n");
    await command(root, "git", "add", "committed.txt");
    await command(root, "git", "commit", "-qm", "local commit");

    expect(await changesDeletionReview.inspect(workspaceId)).toMatchObject({
      status: "blocked",
      details: { repositories: [{ relativePath: "", uncommitted: [], unpushedCommits: [{ hash: expect.any(String), subject: "local commit" }] }] },
    });
  });

  test("clears the assessment once commits are on a known remote branch", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "commit", "--allow-empty", "-qm", "local commit");
    expect((await changesDeletionReview.inspect(workspaceId)).status).toBe("blocked");
    await command(root, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(await changesDeletionReview.inspect(workspaceId)).toEqual({ status: "clear" });
  });

  test("includes commits on other local branches and detached HEAD", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "checkout", "-qb", "unpublished");
    await command(root, "git", "commit", "--allow-empty", "-qm", "other branch");
    await command(root, "git", "checkout", "--detach", "refs/remotes/origin/main");
    await command(root, "git", "commit", "--allow-empty", "-qm", "detached commit");
    const assessment = await changesDeletionReview.inspect(workspaceId);
    expect(assessment).toMatchObject({
      status: "blocked",
      details: { repositories: [{ unpushedCommits: expect.arrayContaining([
        { hash: expect.any(String), subject: "other branch", branches: ["unpublished"] },
        { hash: expect.any(String), subject: "detached commit", branches: [] },
      ]) }] },
    });
  });

  test("reports every local branch containing an unpushed commit, including ancestors", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "checkout", "-qb", "unpublished");
    await command(root, "git", "commit", "--allow-empty", "-qm", "shared commit");
    await command(root, "git", "branch", "another-branch");
    await command(root, "git", "commit", "--allow-empty", "-qm", "later commit");
    const assessment = await changesDeletionReview.inspect(workspaceId);
    expect(assessment).toMatchObject({
      status: "blocked",
      details: { repositories: [{ unpushedCommits: expect.arrayContaining([
        { hash: expect.any(String), subject: "shared commit", branches: ["another-branch", "unpublished"] },
        { hash: expect.any(String), subject: "later commit", branches: ["unpublished"] },
      ]) }] },
    });
  });

  test("reports all commits when there are no remote branches", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "update-ref", "-d", "refs/remotes/origin/main");
    expect(await changesDeletionReview.inspect(workspaceId)).toMatchObject({
      status: "blocked",
      details: { repositories: [{ unpushedCommits: [{ hash: expect.any(String), subject: "initial" }] }] },
    });
  });

  test("handles an unborn HEAD", async () => {
    const root = join(dataDir, "workspaces", workspaceId, "work");
    await mkdir(root, { recursive: true });
    await command(root, "git", "init", "-q");
    expect(await changesDeletionReview.inspect(workspaceId)).toEqual({ status: "clear" });
    await writeFile(join(root, "new.txt"), "new file");
    expect(await changesDeletionReview.inspect(workspaceId)).toMatchObject({
      status: "blocked", details: { repositories: [{ unpushedCommits: [], uncommitted: [{ path: "new.txt" }] }] },
    });
  });

  test("reports unpushed commits in submodules", async () => {
    const root = await workspaceRepository();
    const source = join(dataDir, "submodule-source");
    await mkdir(source);
    await command(source, "git", "init", "-q");
    await command(source, "git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "submodule initial");
    await command(root, "git", "-c", "protocol.file.allow=always", "submodule", "add", source, "nested");
    await command(root, "git", "commit", "-qam", "add submodule");
    await command(root, "git", "update-ref", "refs/remotes/origin/main", "HEAD");
    expect(await changesDeletionReview.inspect(workspaceId)).toEqual({ status: "clear" });
    await command(join(root, "nested"), "git", "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "--allow-empty", "-qm", "submodule local");
    expect(await changesDeletionReview.inspect(workspaceId)).toMatchObject({
      status: "blocked",
      details: { repositories: expect.arrayContaining([
        expect.objectContaining({ relativePath: "nested", uncommitted: [], unpushedCommits: [expect.objectContaining({ hash: expect.any(String), subject: "submodule local", branches: expect.any(Array) })] }),
      ]) },
    });
  });

  test("changes the fingerprint when unpushed commits change", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "commit", "--allow-empty", "-qm", "first");
    const first = await changesDeletionReview.inspect(workspaceId);
    await command(root, "git", "commit", "--allow-empty", "-qm", "second");
    const second = await changesDeletionReview.inspect(workspaceId);
    if (first.status !== "blocked" || second.status !== "blocked") throw new Error("expected blocked assessments");
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });

  test("blocks deletion for uncommitted working-tree changes", async () => {
    const root = await workspaceRepository();
    await writeFile(join(root, "tracked.txt"), "changed\n");

    expect(await changesDeletionReview.inspect(workspaceId)).toMatchObject({
      status: "blocked",
      details: {
        repositories: [{
          relativePath: "",
          uncommitted: [{ path: "tracked.txt", change: "modified", additions: 1, deletions: 1 }],
        }],
      },
    });
  });

  test("only allows file requests belonging to the current assessment", async () => {
    const root = await workspaceRepository();
    await writeFile(join(root, "tracked.txt"), "changed\n");
    const first = await changesDeletionReview.inspect(workspaceId);
    if (first.status !== "blocked") throw new Error("expected blocked assessment");
    const url = new URL("http://test.local/changes/deletion/file");
    url.searchParams.set("fingerprint", first.fingerprint);
    url.searchParams.set("path", "../outside.txt");
    expect((await deletionReviewFileResponse(workspaceId, url)).status).toBe(404);
    url.searchParams.set("path", "tracked.txt");
    url.searchParams.set("repository", "../outside");
    expect((await deletionReviewFileResponse(workspaceId, url)).status).toBe(404);

    await writeFile(join(root, "tracked.txt"), "changed again\n");
    const second = await changesDeletionReview.inspect(workspaceId);
    if (second.status !== "blocked") throw new Error("expected blocked assessment");
    expect(second.fingerprint).not.toBe(first.fingerprint);
    url.searchParams.delete("repository");
    expect((await deletionReviewFileResponse(workspaceId, url)).status).toBe(409);
    url.searchParams.set("fingerprint", second.fingerprint);
    clearDeletionReview(workspaceId);
    expect((await deletionReviewFileResponse(workspaceId, url)).status).toBe(409);
  });

  test("commit review requests are restricted to the current assessment", async () => {
    const root = await workspaceRepository();
    await command(root, "git", "commit", "--allow-empty", "-qm", "local commit");
    const assessment = await changesDeletionReview.inspect(workspaceId);
    if (assessment.status !== "blocked") throw new Error("expected blocked assessment");
    const url = new URL(`http://test.local/changes/deletion/commit?${new URLSearchParams({ fingerprint: assessment.fingerprint, repository: "", commit: "HEAD" })}`);
    expect((await deletionReviewCommitResponse(workspaceId, url)).status).toBe(404);
    expect((await deletionReviewFileResponse(workspaceId, url)).status).toBe(404);
    url.searchParams.delete("commit");
    expect((await deletionReviewCommitResponse(workspaceId, url)).status).toBe(400);
    url.searchParams.set("fingerprint", "outdated");
    expect((await deletionReviewCommitResponse(workspaceId, url)).status).toBe(409);
  });

  test("a clean assessment invalidates previous file requests", async () => {
    const root = await workspaceRepository();
    await writeFile(join(root, "tracked.txt"), "changed\n");
    const assessment = await changesDeletionReview.inspect(workspaceId);
    if (assessment.status !== "blocked") throw new Error("expected blocked assessment");
    await command(root, "git", "checkout", "--", "tracked.txt");
    expect(await changesDeletionReview.inspect(workspaceId)).toEqual({ status: "clear" });
    const url = new URL(`http://test.local/changes/deletion/file?${new URLSearchParams({ fingerprint: assessment.fingerprint, path: "tracked.txt" })}`);
    expect((await deletionReviewFileResponse(workspaceId, url)).status).toBe(409);
  });
});

describe("Review comments in workspace deletion safety", () => {
  test("only uncopied comment revisions block deletion in a clean repository", async () => {
    const { createReviewCommentStore } = await import("../src/server/comments.ts");
    const { captureChanges } = await import("../src/server/snapshot.ts");
    const root = await workspaceRepository();
    const comments = createReviewCommentStore({ dataDir });
    const review = createDeletionReview((id, path) => localRepository(join(dataDir, "workspaces", id, "work", path)), comments);
    await writeFile(join(root, "tracked.txt"), "review this\n");
    const snapshot = await captureChanges(localRepository(root));
    const comment = comments.save(workspaceId, { id: "review", revision: 0, body: "Needs work", path: "tracked.txt", side: "additions", start: 1, end: 1 }, snapshot);
    await writeFile(join(root, "tracked.txt"), "initial\n");
    const uncopied = await review.changesDeletionReview.inspect(workspaceId);
    expect(uncopied).toMatchObject({ status: "blocked", details: { repositories: [], comments: [{ revision: 1, copiedRevision: 0 }] } });
    comments.markCopied(workspaceId, [{ id: comment.id, revision: 1 }]);
    const copied = await review.changesDeletionReview.inspect(workspaceId);
    expect(copied).toEqual({ status: "clear" });
    expect(comments.list(workspaceId)).toMatchObject([{ id: comment.id, revision: 1, copiedRevision: 1 }]);
    if (uncopied.status !== "blocked") throw new Error("Expected uncopied comments to block deletion");
    comments.save(workspaceId, { id: comment.id, revision: 1, body: "Changed review" }, snapshot);
    const changed = await review.changesDeletionReview.inspect(workspaceId);
    if (changed.status !== "blocked") throw new Error("Expected edited comment to block deletion");
    expect(changed.fingerprint).not.toBe(uncopied.fingerprint);
    expect(changed).toMatchObject({ details: { comments: [{ revision: 2, copiedRevision: 1 }] } });
    comments.remove(workspaceId, comment.id, 2);
    expect(await review.changesDeletionReview.inspect(workspaceId)).toEqual({ status: "clear" });
  });
});


test("copied comments are excluded without hiding other deletion risks", async () => {
  const { createReviewCommentStore } = await import("../src/server/comments.ts");
  const { captureChanges } = await import("../src/server/snapshot.ts");
  const root = await workspaceRepository();
  const comments = createReviewCommentStore({ dataDir });
  const review = createDeletionReview((id, path) => localRepository(join(dataDir, "workspaces", id, "work", path)), comments);
  await writeFile(join(root, "tracked.txt"), "review this\n");
  const snapshot = await captureChanges(localRepository(root));
  const copiedComment = comments.save(workspaceId, { id: "copied", revision: 0, body: "Already copied", path: "tracked.txt", side: "additions", start: 1, end: 1 }, snapshot);
  const uncopiedComment = comments.save(workspaceId, { id: "uncopied", revision: 0, body: "Still here", path: "tracked.txt", side: "additions", start: 1, end: 1 }, snapshot);
  comments.markCopied(workspaceId, [copiedComment]);
  expect(await review.changesDeletionReview.inspect(workspaceId)).toMatchObject({
    status: "blocked", details: { comments: [{ id: uncopiedComment.id }], repositories: [{ uncommitted: [{ path: "tracked.txt" }] }] },
  });
  comments.markCopied(workspaceId, [uncopiedComment]);
  const assessment = await review.changesDeletionReview.inspect(workspaceId);
  expect(assessment).toMatchObject({ status: "blocked", details: { repositories: [{ uncommitted: [{ path: "tracked.txt" }] }] } });
  if (assessment.status !== "blocked") throw new Error("Expected git changes to block deletion");
  expect(assessment.details).not.toHaveProperty("comments");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  expect(await review.changesDeletionReview.inspect(workspaceId)).toEqual({ status: "clear" });
});
