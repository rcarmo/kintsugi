import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHostingRateLimitError } from "@kintsugi/core";
import { searchGitHubRepositories as searchWithToken } from "../src/repository-search.ts";

function searchGitHubRepositories(query: string) {
  return searchWithToken(query, process.env.GH_TOKEN);
}

const originalFetch = globalThis.fetch;
let previousDataDir: string | undefined;
let previousToken: string | undefined;
let dataDir: string;
let queries: string[];
let requests: URL[];

beforeEach(async () => {
  previousDataDir = process.env.KINTSUGI_DATA_DIR;
  previousToken = process.env.GH_TOKEN;
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-repo-search-"));
  process.env.KINTSUGI_DATA_DIR = dataDir;
  process.env.GH_TOKEN = crypto.randomUUID();
  queries = [];
  requests = [];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previousDataDir;
  if (previousToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = previousToken;
  await rm(dataDir, { recursive: true, force: true });
});

function repository(fullName: string, privateRepo = false) {
  return { full_name: fullName, description: null, private: privateRepo, clone_url: `https://github.com/${fullName}.git` };
}

function stubSearch(search: (query: string) => ReturnType<typeof repository>[], orgs: (page: number) => { login: string }[] = () => [{ login: "my-org" }]) {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    expect(new Headers(init?.headers).get("Authorization")).toBe(process.env.GH_TOKEN ? `Bearer ${process.env.GH_TOKEN}` : null);
    if (url.pathname === "/user") return Response.json({ login: "me" });
    if (url.pathname === "/user/orgs") {
      expect(url.searchParams.get("per_page")).toBe("100");
      return Response.json(orgs(Number(url.searchParams.get("page"))));
    }
    expect(url.searchParams.get("per_page")).toBe("25");
    expect(url.pathname).toBe("/search/repositories");
    const query = url.searchParams.get("q")!;
    queries.push(query);
    return Response.json({ items: search(query) });
  }, { preconnect: originalFetch.preconnect });
}

test("owner-scoped search puts personal and org repos first, including public ones, and deduplicates", async () => {
  stubSearch((q) => q.includes("user:") ? [repository("me/widget"), repository("my-org/widget", true)] : [
    ...Array.from({ length: 24 }, (_, index) => repository(`random/widget-${index}`)),
    repository("me/widget"),
  ]);
  const { repositories } = await searchGitHubRepositories("widget");
  expect(repositories).toHaveLength(26);
  expect(repositories.slice(0, 2).map((repo) => [repo.fullName, repo.personal])).toEqual([["me/widget", true], ["my-org/widget", true]]);
  expect(repositories.slice(2).every((repo) => !repo.personal)).toBe(true);
  expect(queries).toEqual(["widget is:public", "widget user:me user:my-org"]);
});

test("general search preserves GitHub relevance rather than filtering to name substrings", async () => {
  stubSearch((q) => q.includes("user:") ? [] : [repository("other/relevant-description"), repository("other/widget")]);
  const results = await searchGitHubRepositories("widget language:typescript");
  expect(results.repositories.map((repo) => repo.fullName)).toEqual(["other/relevant-description", "other/widget"]);
  expect(queries[0]).toBe("widget language:typescript is:public");
});

test("anonymous searches use one request and explain that account search is unavailable", async () => {
  delete process.env.GH_TOKEN;
  stubSearch(() => [repository("public/anonymous-widget")]);
  const results = await searchGitHubRepositories("anonymous-widget");
  expect(results.repositories).toHaveLength(1);
  expect(results.notice).toContain("Connect GitHub");
  expect(queries).toEqual(["anonymous-widget is:public"]);
  expect(requests).toHaveLength(1);
});

test("organization discovery follows pagination and is cached for the credential", async () => {
  stubSearch(() => [], (page) => page === 1 ? Array.from({ length: 100 }, (_, i) => ({ login: `org${i}` })) : [{ login: "last-org" }]);
  await searchGitHubRepositories("first");
  expect(queries[1]).toContain("user:last-org");
  await searchGitHubRepositories("second");
  expect(requests.filter((url) => url.pathname === "/user")).toHaveLength(1);
  expect(requests.filter((url) => url.pathname === "/user/orgs")).toHaveLength(2);
});

test("different credentials do not share cached owners", async () => {
  stubSearch((q) => q.includes("user:") ? [repository("me/private", true)] : []);
  await searchGitHubRepositories("private");
  process.env.GH_TOKEN = crypto.randomUUID();
  await searchGitHubRepositories("private");
  expect(queries).toHaveLength(4);
  expect(requests.filter((url) => url.pathname === "/user")).toHaveLength(2);
});

test("failed account discovery leaves public search usable with an explicit notice", async () => {
  stubSearch(() => [repository("public/widget")]);
  const searchFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    if (new URL(String(input)).pathname === "/user") return new Response("Bad credentials", { status: 401 });
    return searchFetch(input, init);
  }, { preconnect: originalFetch.preconnect });
  const results = await searchGitHubRepositories("widget");
  expect(results.repositories.map((repo) => repo.fullName)).toEqual(["public/widget"]);
  expect(results.notice).toContain("could not be searched");
});

test("rate limits remain explicit and preserve the retry delay", async () => {
  globalThis.fetch = Object.assign(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "30" } }), { preconnect: originalFetch.preconnect });
  try {
    await searchGitHubRepositories("limited");
    throw new Error("Expected rate limit");
  } catch (error) {
    expect(error).toBeInstanceOf(GitHostingRateLimitError);
    if (!(error instanceof GitHostingRateLimitError)) throw error;
    expect(error.retryAfterSeconds).toBe(30);
  }
});
