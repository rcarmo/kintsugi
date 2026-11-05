import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { giteaProvider, validateGiteaCredential, searchGiteaRepositories } from "@kintsugi/gitea";
import { gitHostingGitConfiguration } from "../src/index.ts";

test("self-signed Gitea needs explicit opt-in for API/search/Git and never follows redirects or disables TLS elsewhere", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gitea-self-signed-")), previous = process.env.KINTSUGI_DATA_DIR;
  process.env.KINTSUGI_DATA_DIR = dir;
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  const openssl = Bun.spawn(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"], { stdout: "pipe", stderr: "pipe" });
  if (await openssl.exited !== 0) throw Error(await new Response(openssl.stderr).text());
  let redirect = false, leaked = 0, authenticatedGitRequests = 0;
  const token = "fixture-gitea-token";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: await readFile(key), cert: await readFile(cert) }, fetch(request): Response {
    const url = new URL(request.url);
    if (url.pathname === "/leak") { leaked++; return new Response("must not follow"); }
    if (url.pathname.endsWith("/api/v1/user")) {
      if (redirect) return Response.redirect(`${new URL(serverUrl).origin}/leak`, 302);
      return Response.json({ id: 1, login: "alice", full_name: "Alice", email: "alice@example.test" });
    }
    if (url.pathname.endsWith("/api/v1/repos/search")) return Response.json({ data: [{ full_name: "alice/repo", clone_url: `${serverUrl}/alice/repo.git`, private: true }] });
    if (url.pathname.endsWith("/info/refs")) {
      if (request.headers.get("authorization") !== `Basic ${btoa(`alice:${token}`)}`) return new Response("Authenticate", { status: 401, headers: { "www-authenticate": 'Basic realm="Gitea"' } });
      authenticatedGitRequests++;
      const service = "# service=git-upload-pack\n";
      return new Response(`${(service.length + 4).toString(16).padStart(4, "0")}${service}00000000`, { headers: { "content-type": "application/x-git-upload-pack-advertisement" } });
    }
    return new Response("not found", { status: 404 });
  } });
  const serverUrl = `https://localhost:${server.port}/forge`;
  const credential = { serverUrl, token, account: "alice" };
  async function git(args: string[]) {
    const config = gitHostingGitConfiguration();
    const child = Bun.spawn(["git", "-c", "http.sslVerify=true", "-c", `credential.helper=${config.command}`, ...config.configArgs, ...args], { env: { ...process.env, ...config.environment, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", NO_PROXY: "localhost,127.0.0.1" }, stdout: "pipe", stderr: "pipe" });
    return { code: await child.exited, output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() };
  }
  try {
    expect((await validateGiteaCredential(credential)).ok).toBe(false);
    const accepted = await validateGiteaCredential({ ...credential, allowUntrustedCertificate: true });
    expect(accepted).toMatchObject({ ok: true, credential: { allowUntrustedCertificate: true, serverUrl } });
    giteaProvider.saveCredential({ ...credential, allowUntrustedCertificate: true });
    expect(giteaProvider.credential()?.allowUntrustedCertificate).toBe(true);
    expect((await searchGiteaRepositories("repo", giteaProvider.credential())).repositories).toHaveLength(1);
    expect((await git(["ls-remote", `${serverUrl}/alice/repo.git`])).code).toBe(0);
    expect(authenticatedGitRequests).toBeGreaterThan(0);
    expect((await git(["config", "--get-urlmatch", "http.sslVerify", `${serverUrl}/alice/repo.git`])).output.trim()).toBe("false");
    expect((await git(["config", "--get-urlmatch", "http.followRedirects", serverUrl])).output.trim()).toBe("false");
    for (const other of ["https://example.test/repo", "https://localhost:443/repo", `https://localhost:${server.port! + 1}/repo`]) expect((await git(["config", "--get-urlmatch", "http.sslVerify", other])).output.trim()).toBe("true");
    redirect = true;
    expect((await validateGiteaCredential({ ...credential, allowUntrustedCertificate: true })).ok).toBe(false);
    expect(leaked).toBe(0);
    redirect = false;
    expect((await validateGiteaCredential(credential)).ok).toBe(false);
    giteaProvider.saveCredential(credential);
    expect(gitHostingGitConfiguration().configArgs).toEqual([]);
    expect((await git(["ls-remote", `${serverUrl}/alice/repo.git`])).code).not.toBe(0);
  } finally {
    await server.stop(true);
    if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR; else process.env.KINTSUGI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
