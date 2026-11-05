import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bitbucketProvider, searchBitbucketRepositories, validateBitbucketCredential } from "../src/index.ts";

const originalFetch = globalThis.fetch;
const credential = { token: "ATATT-test", account: "me@example.com" };

function stubFetch(handler: (url: URL, headers: Headers) => Response): URL[] {
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    return handler(url, new Headers(init?.headers));
  }, { preconnect: originalFetch.preconnect });
  return requests;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Bitbucket credential validation", () => {
  test("authenticates with the account email and token", async () => {
    let authorization = "";
    stubFetch((url, headers) => {
      authorization = headers.get("authorization") ?? "";
      expect(url.href).toBe("https://api.bitbucket.org/2.0/user");
      return Response.json({ display_name: "Bit Bucket", nickname: "bb" });
    });

    expect(await validateBitbucketCredential({ token: " ATATT-test ", account: " me@example.com " })).toEqual({ ok: true, identity: { name: "Bit Bucket", email: "me@example.com" } });
    expect(authorization).toBe(`Basic ${btoa("me@example.com:ATATT-test")}`);
  });

  test("asks for the email and token before calling Bitbucket", async () => {
    stubFetch(() => {
      throw new Error("unexpected fetch");
    });
    expect(await validateBitbucketCredential({ token: "token" })).toMatchObject({ ok: false, message: expect.stringContaining("email") });
    expect(await validateBitbucketCredential({ token: " ", account: "me@example.com" })).toMatchObject({ ok: false, message: expect.stringContaining("token") });
  });

  test("explains rejected credentials", async () => {
    stubFetch(() => new Response("", { status: 401 }));
    expect(await validateBitbucketCredential(credential)).toMatchObject({ ok: false, message: expect.stringContaining("rejected") });
  });
});

describe("Bitbucket repository search", () => {
  test("searches every workspace you belong to by repository name", async () => {
    const requests = stubFetch((url) => {
      if (url.pathname === "/2.0/user/workspaces" && !url.searchParams.has("page")) return Response.json({ values: [{ workspace: { slug: "team" } }], next: "https://api.bitbucket.org/2.0/user/workspaces?pagelen=100&page=2" });
      if (url.pathname === "/2.0/user/workspaces") return Response.json({ values: [{ workspace: { slug: "side project" } }] });
      if (url.pathname === "/2.0/repositories/team") return Response.json({ values: [{ full_name: "team/widget", description: "", is_private: true }] });
      if (url.pathname === "/2.0/repositories/side%20project") return Response.json({ values: [{ full_name: "side-project/widget", is_private: false }] });
      throw new Error(`unexpected fetch ${url.href}`);
    });

    const results = await searchBitbucketRepositories(' wid"get ', { ...credential, token: "search-token" });
    expect(results.repositories).toEqual([
      { fullName: "team/widget", description: null, private: true, cloneUrl: "https://bitbucket.org/team/widget.git", personal: true },
      { fullName: "side-project/widget", description: null, private: false, cloneUrl: "https://bitbucket.org/side-project/widget.git", personal: true },
    ]);
    const searches = requests.filter((url) => url.pathname.startsWith("/2.0/repositories/"));
    expect(searches.map((url) => url.searchParams.get("q"))).toEqual(['name ~ "wid\\"get"', 'name ~ "wid\\"get"']);

    await searchBitbucketRepositories("other", { ...credential, token: "search-token" });
    expect(requests.filter((url) => url.pathname === "/2.0/user/workspaces")).toHaveLength(2);
  });

  test.each(["https://attacker.example/2.0/user/workspaces", "http://api.bitbucket.org/2.0/user/workspaces", "https://api.bitbucket.org:8443/2.0/user/workspaces", "https://attacker@api.bitbucket.org/2.0/user/workspaces", "https://api.bitbucket.org/not-api"])("rejects untrusted pagination URLs before sending credentials: %s", async (next) => {
    const requests = stubFetch(() => Response.json({ values: [], next }));
    await expect(searchBitbucketRepositories("pagination", { ...credential, token: `pagination-${next}` })).rejects.toThrow("Invalid Bitbucket API URL");
    expect(requests.map(url => url.href)).toEqual(["https://api.bitbucket.org/2.0/user/workspaces?pagelen=100"]);
  });

  test("authenticated API calls refuse redirects", async () => {
    globalThis.fetch = Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return Response.json({ values: [] });
    }, { preconnect: originalFetch.preconnect });
    expect((await searchBitbucketRepositories("redirects", { ...credential, token: "redirect-policy" })).repositories).toEqual([]);
  });

  test("explains when the connection cannot search", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    expect((await searchBitbucketRepositories("widget", { ...credential, token: "forbidden-token" })).notice).toContain("Check your Bitbucket connection");
  });
});

describe("Bitbucket credential", () => {
  let previousDataDir: string | undefined;
  let dataDir: string;

  beforeEach(async () => {
    previousDataDir = process.env.KINTSUGI_DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), "kintsugi-bitbucket-"));
    process.env.KINTSUGI_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("stores the email next to the token and exposes only the email to workspaces, also for bkt", () => {
    bitbucketProvider.saveCredential({ token: " ATATT-test ", account: " me@example.com " });
    expect(bitbucketProvider.credential()).toEqual(credential);
    expect(bitbucketProvider.workspaceEnv(credential)).toEqual({ BITBUCKET_EMAIL: "me@example.com", BKT_USERNAME: "me@example.com", BKT_HOST: "https://bitbucket.org" });
    bitbucketProvider.clearCredential();
    expect(bitbucketProvider.credential()).toBeUndefined();
  });
});
