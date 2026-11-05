import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHostingProvider } from "@kintsugi/git-hosting";
import { shouldSearchRepositories } from "@kintsugi/shared";
import { searchRepositories } from "../src/server/repository-search.ts";

const originalFetch = globalThis.fetch;
let previousDataDir: string | undefined;
let previousToken: string | undefined;
let dataDir: string;
let requests: URL[];

beforeEach(async () => {
  previousDataDir = process.env.KINTSUGI_DATA_DIR;
  previousToken = process.env.GH_TOKEN;
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-repository-search-"));
  process.env.KINTSUGI_DATA_DIR = dataDir;
  delete process.env.GH_TOKEN;
  requests = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    requests.push(url);
    if (url.host === "api.github.com" && url.pathname === "/user") return Response.json({ login: "me" });
    if (url.host === "api.github.com" && url.pathname === "/user/orgs") return Response.json([]);
    if (url.host === "api.github.com") return Response.json({ items: [{ full_name: `octo/${url.searchParams.get("q")!.split(" ")[0]}`, description: null, private: false, clone_url: "https://github.com/octo/widget.git" }] });
    if (url.host === "gitlab.com") return new Response("", { status: 429, headers: { "retry-after": "9" } });
    if (url.host === "api.bitbucket.org" && url.pathname === "/2.0/user/workspaces") return Response.json({ values: [{ workspace: { slug: "team" } }] });
    if (url.host === "api.bitbucket.org" && url.pathname === "/2.0/repositories/team") return Response.json({ values: [{ full_name: "team/widget", is_private: true }] });
    throw new Error(`unexpected fetch ${url.href}`);
  }, { preconnect: originalFetch.preconnect });
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previousDataDir;
  if (previousToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = previousToken;
  await rm(dataDir, { recursive: true, force: true });
});

test("explicit provider URLs bypass search while repository names remain searchable", () => {
  expect(shouldSearchRepositories("github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchRepositories(" GitHub.com/octocat/Hello-World.git#main ")).toBe(false);
  expect(shouldSearchRepositories("gitlab.com/group/project")).toBe(false);
  expect(shouldSearchRepositories("bitbucket.org/workspace/repo")).toBe(false);
  expect(shouldSearchRepositories("https://github.com/octocat/Hello-World")).toBe(false);
  expect(shouldSearchRepositories("Hello-World")).toBe(true);
});

test("without connections only public GitHub is searched", async () => {
  const searches = await searchRepositories("widget");
  expect(searches.map((search) => search.provider.id)).toEqual(["github"]);
  expect(requests.every((url) => url.host === "api.github.com")).toBe(true);
});

test("searches every connected provider and keeps one provider's rate limit to itself", async () => {
  gitHostingProvider("gitlab").saveCredential({ token: "gitlab-token" });
  gitHostingProvider("bitbucket").saveCredential({ token: "bitbucket-token", account: "me@example.com" });

  const searches = await searchRepositories("gadget");
  expect(searches.map((search) => search.provider.id)).toEqual(["github", "gitlab", "bitbucket"]);
  expect(searches[1]!.notice).toBe("GitLab search is rate limited. Try again in 9 seconds.");
});

test("a configured Gitea instance is searched without sending its credential to other providers", async () => {
  gitHostingProvider("gitea").saveCredential({ serverUrl: "https://git.example.test:8443/forge", account: "alice", token: "gitea-search-secret" });
  const githubFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "git.example.test:8443") {
      expect(url.pathname).toBe("/forge/api/v1/repos/search");
      expect(new Headers(init?.headers).get("authorization")).toBe("token gitea-search-secret");
      return Response.json({ data: [{ full_name: "alice/private", private: true, clone_url: "https://git.example.test:8443/forge/alice/private.git" }] });
    }
    expect(new Headers(init?.headers).get("authorization") ?? "").not.toContain("gitea-search-secret");
    return githubFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  const results = await searchRepositories("private");
  expect(results.map(result => result.provider.id)).toEqual(["github", "gitea"]);
  expect(results[1]!.repositories[0]).toMatchObject({ fullName: "alice/private", private: true });
});

test("results are cached per provider, credential and normalized query", async () => {
  await searchRepositories("cached");
  const count = requests.length;
  await searchRepositories(" CACHED ");
  expect(requests).toHaveLength(count);
  process.env.GH_TOKEN = "another-token";
  await searchRepositories("cached");
  expect(requests.length).toBeGreaterThan(count);
});
