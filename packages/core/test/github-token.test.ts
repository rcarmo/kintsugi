import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clearGitHubToken, discoverGitHubToken, gitHubCredentialHelperShellBody, hasGitHubToken, setGitHubToken } from "../src/github-token.ts";

async function runCredentialHelper(input: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", gitHubCredentialHelperShellBody, "kintsugi-git-credential", "get"], {
    env: { ...process.env, GH_TOKEN: "secret-token" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

let previousDataDir: string | undefined;
let previousGitHubToken: string | undefined;
let dataDir: string;

describe("GitHub token discovery", () => {
  beforeEach(async () => {
    previousDataDir = process.env.KINTSUGI_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    dataDir = await mkdtemp(join(tmpdir(), "kintsugi-github-token-"));
    process.env.KINTSUGI_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    clearGitHubToken();
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses stored token before environment token", () => {
    process.env.GH_TOKEN = "env-token";
    setGitHubToken("stored-token");

    expect(discoverGitHubToken()).toBe("stored-token");
    expect(hasGitHubToken()).toBe(true);
  });

  test("falls back to GH_TOKEN when no token is stored", () => {
    process.env.GH_TOKEN = " env-token ";

    expect(discoverGitHubToken()).toBe("env-token");
    expect(hasGitHubToken()).toBe(true);
  });

  test("disconnect suppresses a discovered GH_TOKEN until a token is connected again", () => {
    process.env.GH_TOKEN = "env-token";

    clearGitHubToken();
    expect(discoverGitHubToken()).toBeUndefined();
    expect(hasGitHubToken()).toBe(false);

    setGitHubToken("reconnected-token");
    expect(discoverGitHubToken()).toBe("reconnected-token");
    expect(hasGitHubToken()).toBe(true);
  });

  test("falls back to GH_TOKEN when stored token file is blank", async () => {
    const tokenPath = join(dataDir, "workspace", "github-token");
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, "\n");
    process.env.GH_TOKEN = "env-token";

    expect(discoverGitHubToken()).toBe("env-token");
  });

  test("treats blank GH_TOKEN as missing", () => {
    process.env.GH_TOKEN = "  ";

    expect(discoverGitHubToken()).toBeUndefined();
    expect(hasGitHubToken()).toBe(false);
  });

  test("credential helper supplies the token only to GitHub HTTPS remotes", async () => {
    expect(await runCredentialHelper("protocol=https\nhost=github.com\n\n")).toBe("username=x-access-token\npassword=secret-token\n");
    expect(await runCredentialHelper("protocol=https\nhost=github.com:443\n\n")).toBe("username=x-access-token\npassword=secret-token\n");
    expect(await runCredentialHelper("protocol=https\nhost=example.com\n\n")).toBe("");
    expect(await runCredentialHelper("protocol=ssh\nhost=github.com\n\n")).toBe("");
  });
});
