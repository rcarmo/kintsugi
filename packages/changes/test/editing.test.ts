import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { localRepository } from "../../workspace/test/support/local-repository.ts";
import { createChangesEditStore } from "../src/server/editing.ts";
import { captureChanges, captureHistory, workingTree, stagedChanges } from "../src/server/snapshot.ts";
import { canEditFile, maxChangesTextBytes, maxChangesTextLines, diskContents, editLineEnding, editorContents } from "../src/editing.ts";
import { moveCommentRanges } from "../src/editing-ranges.ts";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(contents = "original\n") {
  const root = await mkdtemp(join(tmpdir(), "changes-edit-")); directories.push(root);
  const repo = localRepository(root);
  for (const args of [["init", "-b", "main"], ["config", "user.name", "Fixture"], ["config", "user.email", "fixture@example.invalid"]]) await repo.gitResult(args);
  await writeFile(join(root, "file.ts"), contents);
  await repo.gitResult(["add", "."]); await repo.gitResult(["commit", "-m", "initial"]);
  await writeFile(join(root, "file.ts"), contents + "change\n");
  const snapshot = await captureChanges(repo);
  return { root, repo, snapshot, store: createChangesEditStore() };
}

test("working-tree saves preserve baseline, permissions, Git index, and pinned lease after a live refresh", async () => {
  const { root, repo, store } = await fixture();
  await chmod(join(root, "file.ts"), 0o755);
  await repo.gitResult(["add", "file.ts"]);
  await writeFile(join(root, "file.ts"), "original\nstaged\nworking\n");
  const snapshot = await captureChanges(repo, { target: workingTree, base: stagedChanges });
  const index = await readFile(join(root, ".git/index"));
  const model = await store.begin("workspace", repo, snapshot, "file.ts");
  await captureChanges(repo); // A new live snapshot must not invalidate the edit lease.
  const saved = await store.save("workspace", repo, model.token, "original\nstaged\nedited\n", [], () => {});
  expect(await readFile(join(root, "file.ts"), "utf8")).toBe("original\nstaged\nedited\n");
  expect((await stat(join(root, "file.ts"))).mode & 0o777).toBe(0o755);
  expect(await readFile(join(root, ".git/index"))).toEqual(index);
  expect(saved.base).toBe(snapshot.base);
  expect(saved.endpoints).toEqual(snapshot.endpoints);
  expect(saved.files.get("file.ts")!.newContents).toBe("original\nstaged\nedited\n");
});

test("saving captures a fresh history: Working tree counts and commits made while editing", async () => {
  const { root, repo, store, snapshot } = await fixture();
  const model = await store.begin("workspace", repo, snapshot, "file.ts");
  await writeFile(join(root, "other.ts"), "other\n");
  await repo.gitResult(["add", "other.ts"]); await repo.gitResult(["commit", "-m", "committed while editing"]);
  const saved = await store.save("workspace", repo, model.token, "original\nchange\nmore\nlines\n", [], () => {});
  expect(saved.history.id).not.toBe(snapshot.history.id);
  expect(saved.history.commits[1]!.subject).toBe("committed while editing");
  expect(saved.history.commits[0]!.stats).toEqual({ files: 1, additions: 3, deletions: 0 });
});

test("stale edits, mode changes, deletes, and symlink replacements never overwrite newer workspace changes", async () => {
  const { root, repo, store, snapshot } = await fixture();
  const model = await store.begin("workspace", repo, snapshot, "file.ts");
  await writeFile(join(root, "file.ts"), "agent changed this\n");
  await expect(store.save("workspace", repo, model.token, "my draft\n", [], () => {})).rejects.toThrow("changed while");
  expect(await readFile(join(root, "file.ts"), "utf8")).toBe("agent changed this\n");
  await writeFile(join(root, "file.ts"), model.contents);
  await chmod(join(root, "file.ts"), 0o755);
  await expect(store.save("workspace", repo, model.token, "my draft\n", [], () => {})).rejects.toThrow("changed while");
  await rm(join(root, "file.ts"));
  await expect(store.save("workspace", repo, model.token, "my draft\n", [], () => {})).rejects.toThrow("changed while");
  await writeFile(join(root, "outside"), "untouched\n");
  await symlink("outside", join(root, "file.ts"));
  await expect(store.save("workspace", repo, model.token, "my draft\n", [], () => {})).rejects.toThrow("regular file");
  expect(await readFile(join(root, "outside"), "utf8")).toBe("untouched\n");
});

test("only supported regular working-tree files can start edits; empty additions are real editable contents", async () => {
  const { root, repo, store, snapshot } = await fixture();
  const historical = await captureChanges(repo, { target: snapshot.history.head! }, snapshot.history);
  await expect(store.begin("workspace", repo, historical, "file.ts")).rejects.toThrow("read-only");
  await repo.gitResult(["add", "."]);
  const staged = await captureChanges(repo, { target: stagedChanges }, await captureHistory(repo));
  await expect(store.begin("workspace", repo, staged, "file.ts")).rejects.toThrow("read-only");
  await writeFile(join(root, "empty.ts"), "");
  await writeFile(join(root, "mixed.ts"), "a\r\nb\n");
  await symlink("file.ts", join(root, "link"));
  const next = await captureChanges(repo);
  expect(canEditFile(next.files.get("empty.ts")!)).toBe(true);
  expect(canEditFile(next.files.get("mixed.ts")!)).toBe(false);
  expect(canEditFile(next.files.get("link")!)).toBe(false);
  const model = await store.begin("workspace", repo, next, "empty.ts");
  await store.save("workspace", repo, model.token, "new file\n", [], () => {});
  expect(await readFile(join(root, "empty.ts"), "utf8")).toBe("new file\n");
});

test("Cancel releases the lease without writing; stale begin and oversized or invalid saves are rejected", async () => {
  const { root, repo, store, snapshot } = await fixture();
  const model = await store.begin("workspace", repo, snapshot, "file.ts");
  for (const contents of ["\0", "\uD800", "x".repeat(1_000_001), "\n".repeat(5001)]) {
    await expect(store.save("workspace", repo, model.token, contents, [], () => {})).rejects.toThrow();
  }
  store.cancel("workspace", model.token);
  expect(await readFile(join(root, "file.ts"), "utf8")).toBe(model.contents);
  await expect(store.save("workspace", repo, model.token, "draft", [], () => {})).rejects.toThrow("session ended");
  await writeFile(join(root, "file.ts"), "newer\n");
  await expect(store.begin("workspace", repo, snapshot, "file.ts")).rejects.toThrow("changed");
});

test("LF, CRLF, Unicode, empty files and final newlines round-trip unchanged", async () => {
  for (const contents of ["", "one", "one\n", "one\r\n", "a\r\nb", "\ufeffhello 🌍\r\n"]) {
    const ending = editLineEnding(contents)!;
    expect(diskContents(editorContents(contents), ending)).toBe(contents);
    const { root, repo, store } = await fixture(contents);
    await writeFile(join(root, "file.ts"), contents);
    await chmod(join(root, "file.ts"), 0o755); // A mode-only change is still a genuine text file.
    const snapshot = await captureChanges(repo);
    const model = await store.begin("workspace", repo, snapshot, "file.ts");
    await store.save("workspace", repo, model.token, editorContents(contents), [], () => {});
    expect(await readFile(join(root, "file.ts"), "utf8")).toBe(contents);
  }
  expect(editLineEnding("one\rtwo")).toBeUndefined();
  expect(editLineEnding("one\r\ntwo\n")).toBeUndefined();
});

test("conditional writes reject path escapes, Git metadata, and symlink ancestors", async () => {
  const { root, repo } = await fixture();
  const bytes = await readFile(join(root, "file.ts"));
  const expected = { hash: createHash("sha256").update(bytes).digest("hex"), mode: "100644" };
  for (const path of ["../file.ts", "/file.ts", ".git/config", "a/../file.ts", "file.ts\0bad"]) expect(await repo.writeWorkingFile(path, expected, "unsafe")).toBe("unsupported");
  await mkdir(join(root, "nested")); await writeFile(join(root, "nested/file.ts"), bytes);
  await symlink("nested", join(root, "linked"));
  expect(await repo.writeWorkingFile("linked/file.ts", expected, "unsafe")).toBe("unsupported");
  expect(await readFile(join(root, "nested/file.ts"))).toEqual(bytes);
});

test("multiline review ranges follow insertions, replacements and deletions", () => {
  const ranges = [{ id: "comment", revision: 1, start: 4, end: 6 }];
  const change = (start: number, end: number, text: string) => ({ range: { start: { line: start }, end: { line: end } }, text });
  expect(moveCommentRanges(ranges, [change(0, 0, "prefix\n")])).toEqual([{ ...ranges[0]!, start: 5, end: 7 }]);
  expect(moveCommentRanges(ranges, [change(3, 5, "replacement")])).toEqual([{ ...ranges[0]!, start: 4, end: 4 }]);
  expect(moveCommentRanges(ranges, [change(0, 1, "")])).toEqual([{ ...ranges[0]!, start: 3, end: 5 }]);
});

test("saving back to the baseline removes the file from the comparison; duplicate in-flight saves are rejected", async () => {
  const { root, repo, store, snapshot } = await fixture();
  const model = await store.begin("workspace", repo, snapshot, "file.ts");
  const save = store.save("workspace", repo, model.token, "original\n", [], () => {});
  await expect(store.save("workspace", repo, model.token, "second\n", [], () => {})).rejects.toThrow("already saving");
  const next = await save;
  expect(next.files.has("file.ts")).toBe(false);
  expect(next.stats).toEqual([]);
  expect(await readFile(join(root, "file.ts"), "utf8")).toBe("original\n");
});

test("review ranges distinguish a prefix inserted at column zero from a split in the middle of the same line", () => {
  const ranges = [{ id: "comment", revision: 1, start: 1, end: 1 }];
  const insert = (character: number) => ({ range: { start: { line: 0, character }, end: { line: 0, character } }, text: "prefix\n" });
  expect(moveCommentRanges(ranges, [insert(0)])).toEqual([{ ...ranges[0]!, start: 2, end: 2 }]);
  expect(moveCommentRanges(ranges, [insert(5)])).toEqual([{ ...ranges[0]!, start: 1, end: 2 }]);
});

test("capture and editing share text limits; unsupported UTF-8 and large files stay read-only", async () => {
  const { root, repo, store } = await fixture();
  await writeFile(join(root, "large.ts"), "x".repeat(maxChangesTextBytes + 1));
  await writeFile(join(root, "long.ts"), "\n".repeat(maxChangesTextLines));
  await writeFile(join(root, "invalid.ts"), Buffer.from([0xc3, 0x28]));
  const snapshot = await captureChanges(repo);
  for (const path of ["large.ts", "long.ts", "invalid.ts"]) {
    const file = snapshot.files.get(path)!;
    expect(file.kind).toBe(path === "invalid.ts" ? "binary" : "large");
    expect(canEditFile(file)).toBe(false);
    await expect(store.begin("workspace", repo, snapshot, path)).rejects.toThrow("read-only");
  }
});
