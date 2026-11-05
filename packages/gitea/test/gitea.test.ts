import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHostingCache } from "@kintsugi/core";
import { giteaProvider, normalizeGiteaServerUrl, searchGiteaRepositories, validateGiteaCredential } from "../src/index.ts";

const originalFetch = globalThis.fetch;
const credential = { serverUrl: "https://git.example.test:8443/forge", account: "alice", token: "gitea-fixture-token" };
let previousDataDir: string | undefined;
let dataDir: string;
beforeEach(async () => {
  previousDataDir = process.env.KINTSUGI_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "kintsugi-gitea-"));
  process.env.KINTSUGI_DATA_DIR = dataDir;
});
afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
  else process.env.KINTSUGI_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});
function stub(handler: (url: URL, init: RequestInit) => Response) {
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(new URL(String(input)), init ?? {}), { preconnect: originalFetch.preconnect });
}

test("normalizes a configurable HTTPS instance, port and installation subpath", () => {
  expect(normalizeGiteaServerUrl(" https://GIT.example.test:443/forge/// ")).toBe("https://git.example.test/forge");
  expect(normalizeGiteaServerUrl("https://192.168.1.8:8443/")).toBe("https://192.168.1.8:8443");
  expect(normalizeGiteaServerUrl("https://[fd00::8]:8443/")).toBe("https://[fd00::8]:8443");
});
test.each(["", "https://*.example.test", "http://git.example.test", "ftp://git.example.test", "https://user:secret@git.example.test", "https://git.example.test/?token=secret", "https://git.example.test/#secret", "https://github.com", "https://api.github.com.", "https://gitlab.com:8443", "https://bitbucket.org", "https://api.bitbucket.org"])("refuses unsafe or conflicting instance input: %s", async serverUrl => {
  expect(() => normalizeGiteaServerUrl(serverUrl)).toThrow();
  stub(() => { throw Error("No network call expected"); });
  expect((await validateGiteaCredential({ ...credential, serverUrl })).ok).toBe(false);
});
test("validates the configured API and derives the Git username from the token owner", async () => {
  stub((url, init) => {
    expect(url.href).toBe(`${credential.serverUrl}/api/v1/user`);
    expect(new Headers(init.headers).get("authorization")).toBe(`token ${credential.token}`);
    expect(init.redirect).toBe("error");
    return Response.json({ id: 17, login: "alice", full_name: " Alice Example ", email: "alice@example.test" });
  });
  expect(await validateGiteaCredential({ serverUrl: credential.serverUrl + "/", token: ` ${credential.token} ` })).toEqual({ ok: true, identity: { name: "Alice Example", email: "alice@example.test" }, credential });
});
test("does not send blank tokens and explains rejected credentials or malformed responses", async () => {
  stub(() => { throw Error("No network call expected"); });
  expect((await validateGiteaCredential({ ...credential, token: " " })).ok).toBe(false);
  for (const status of [401, 403, 500]) {
    stub(() => new Response("private diagnostic", { status }));
    const result = await validateGiteaCredential(credential);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("private diagnostic");
  }
  stub(() => Response.json({ login: "alice" }));
  expect((await validateGiteaCredential(credential)).ok).toBe(false);
  stub(() => Response.json({ id: 1, login: "bad\nusername" }));
  expect((await validateGiteaCredential(credential)).ok).toBe(false);
});
test("reports network, certificate and redirect failures without following to a different server", async () => {
  stub((_url, init) => { expect(init.redirect).toBe("error"); throw Error("untrusted certificate"); });
  expect(await validateGiteaCredential(credential)).toMatchObject({ ok: false, message: expect.stringContaining("trusted HTTPS certificate") });
});
test("searches visible repositories, including private ones, on the configured API", async () => {
  stub((url, init) => {
    expect(url.origin + url.pathname).toBe(`${credential.serverUrl}/api/v1/repos/search`);
    expect(url.searchParams.get("q")).toBe("widget");
    expect(url.searchParams.get("private")).toBe("true");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(`token ${credential.token}`);
    return Response.json({ data: [{ full_name: "alice/widget", private: true, clone_url: `${credential.serverUrl}/alice/widget.git`, description: "Private fixture" }] });
  });
  expect((await searchGiteaRepositories(" widget ", credential)).repositories).toEqual([{ fullName: "alice/widget", private: true, cloneUrl: `${credential.serverUrl}/alice/widget.git`, description: "Private fixture", personal: true }]);
});
test.each(["https://evil.example/alice/repo.git", "http://git.example.test:8443/forge/alice/repo.git", "https://git.example.test/forge/alice/repo.git", "https://user:secret@git.example.test:8443/forge/alice/repo.git", "https://git.example.test:8443/elsewhere/repo.git", "https://git.example.test:8443/forge/repo.git?secret=1"])("rejects clone URLs outside the configured credential destination: %s", async clone_url => {
  stub(() => Response.json({ data: [{ full_name: "alice/repo", private: true, clone_url }] }));
  await expect(searchGiteaRepositories("repo", credential)).rejects.toThrow("outside the configured server");
});
test("searches isolate authentication failures and report rate limits", async () => {
  expect((await searchGiteaRepositories("repo", undefined)).notice).toContain("Connect Gitea");
  stub(() => new Response("", { status: 403 }));
  expect((await searchGiteaRepositories("repo", credential)).notice).toContain("permissions");
  stub(() => new Response("", { status: 429, headers: { "retry-after": "9" } }));
  await expect(searchGiteaRepositories("repo", credential)).rejects.toMatchObject({ retryAfterSeconds: 9 });
});
test("persists one instance privately and never adds automatic SSH trust or plain-token environment fields", async () => {
  giteaProvider.saveCredential(credential);
  expect(giteaProvider.credential()).toEqual(credential);
  expect(JSON.parse(await readFile(join(dataDir, "workspace", "gitea-credential.json"), "utf8"))).toEqual(credential);
  expect((await stat(join(dataDir, "workspace", "gitea-credential.json"))).mode & 0o777).toBe(0o600);
  expect(giteaProvider.workspaceEnv(credential)).toEqual({});
  expect(giteaProvider.sshKnownHosts).toBe("");
  expect(giteaProvider.connection!(credential)).toEqual({ gitHost: "git.example.test:8443", gitUsername: "alice", tokenHosts: ["git.example.test"], tokenOrigins: ["https://git.example.test:8443"] });
  giteaProvider.clearCredential();
  expect(giteaProvider.credential()).toBeUndefined();
});
test("provider caches cannot reuse results for a different server with the same account and token", async () => {
  const cache = createGitHostingCache<string>(60_000);
  expect(await cache(credential, "repos", async () => "first-server")).toBe("first-server");
  expect(await cache({ ...credential, serverUrl: "https://another.example" }, "repos", async () => "second-server")).toBe("second-server");
});

test("provider cache entries are isolated by the explicitly selected certificate policy", async () => {
  const cache = createGitHostingCache<string>(60000);
  expect(await cache(credential, "repos", async () => "strict")).toBe("strict");
  expect(await cache({ ...credential, allowUntrustedCertificate: true }, "repos", async () => "exception")).toBe("exception");
  expect(await cache(credential, "repos", async () => "must not change")).toBe("strict");
});
