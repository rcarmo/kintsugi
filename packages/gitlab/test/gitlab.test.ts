import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHostingRateLimitError } from "@kintsugi/core";
import { gitLabProvider, searchGitLabProjects, validateGitLabToken } from "../src/index.ts";

const originalFetch = globalThis.fetch;

function stubFetch(handler: (url: URL, headers: Headers) => Response): URL[] {
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    return handler(url, new Headers(init?.headers));
  }, { preconnect: originalFetch.preconnect });
  return requests;
}

function project(path: string, visibility = "public") {
  return { path_with_namespace: path, description: null, visibility, http_url_to_repo: `https://gitlab.com/${path}.git` };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitLab token validation", () => {
  test("uses the commit email from the user API", async () => {
    let authorization = "";
    stubFetch((url, headers) => {
      authorization = headers.get("authorization") ?? "";
      expect(url.href).toBe("https://gitlab.com/api/v4/user");
      return Response.json({ id: 7, username: "tanuki", name: "Tanuki", email: "private@example.com", commit_email: "commits@example.com" });
    });

    expect(await validateGitLabToken(" glpat-test ")).toEqual({ ok: true, identity: { name: "Tanuki", email: "commits@example.com" } });
    expect(authorization).toBe("Bearer glpat-test");
  });

  test("falls back to the GitLab noreply email", async () => {
    stubFetch(() => Response.json({ id: 7, username: "tanuki", name: "" }));

    expect(await validateGitLabToken("token")).toEqual({ ok: true, identity: { name: "tanuki", email: "7-tanuki@users.noreply.gitlab.com" } });
  });

  test("explains rejected tokens and missing scopes", async () => {
    expect(await validateGitLabToken(" ")).toEqual({ ok: false, message: "Enter a GitLab token." });
    stubFetch(() => new Response("", { status: 401 }));
    expect(await validateGitLabToken("token")).toMatchObject({ ok: false, message: expect.stringContaining("rejected") });
    stubFetch(() => new Response("", { status: 403 }));
    expect(await validateGitLabToken("token")).toMatchObject({ ok: false, message: expect.stringContaining("api scope") });
  });
});

describe("GitLab project search", () => {
  test("puts your projects first and deduplicates public results", async () => {
    const requests = stubFetch((url) => url.searchParams.get("membership") === "true"
      ? Response.json([project("me/widget", "private"), project("team/widget")])
      : Response.json([project("team/widget"), project("other/widget")]));

    const results = await searchGitLabProjects(" widget ", "token");
    expect(results.repositories.map((repo) => [repo.fullName, repo.personal, repo.private])).toEqual([
      ["me/widget", true, true],
      ["team/widget", true, false],
      ["other/widget", false, false],
    ]);
    expect(requests.every((url) => url.searchParams.get("search") === "widget")).toBe(true);
    expect(requests.find((url) => !url.searchParams.has("membership"))?.searchParams.get("visibility")).toBe("public");
  });

  test("anonymous searches only query public projects", async () => {
    const requests = stubFetch(() => Response.json([project("other/widget")]));
    expect((await searchGitLabProjects("widget", undefined)).repositories).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  test("rate limits keep their retry delay", async () => {
    stubFetch(() => new Response("", { status: 429, headers: { "retry-after": "12" } }));
    try {
      await searchGitLabProjects("widget", "token");
      throw new Error("Expected rate limit");
    } catch (error) {
      if (!(error instanceof GitHostingRateLimitError)) throw error;
      expect(error.retryAfterSeconds).toBe(12);
    }
  });
});

describe("GitLab credential", () => {
  let previousDataDir: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    previousDataDir = process.env.KINTSUGI_DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), "kintsugi-gitlab-"));
    process.env.KINTSUGI_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("stores, reads and clears the token", () => {
    expect(gitLabProvider.credential()).toBeUndefined();
    gitLabProvider.saveCredential({ token: " glpat-test " });
    expect(gitLabProvider.credential()).toEqual({ token: "glpat-test" });
    gitLabProvider.clearCredential();
    expect(gitLabProvider.credential()).toBeUndefined();
  });
});
