import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitHubProvider } from "../src/index.ts";
import { discoverGitHubToken, setGitHubToken } from "@kintsugi/core";

let previousDataDir: string | undefined;
let previousGitHubToken: string | undefined;
let dataDir: string;

function token(): string | undefined {
  return gitHubProvider.credential()?.token;
}

describe("GitHub credential", () => {
  beforeEach(async () => {
    previousDataDir = process.env.KINTSUGI_DATA_DIR;
    previousGitHubToken = process.env.GH_TOKEN;
    dataDir = await mkdtemp(join(tmpdir(), "kintsugi-github-token-"));
    process.env.KINTSUGI_DATA_DIR = dataDir;
    delete process.env.GH_TOKEN;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.KINTSUGI_DATA_DIR;
    else process.env.KINTSUGI_DATA_DIR = previousDataDir;
    if (previousGitHubToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHubToken;
    await rm(dataDir, { recursive: true, force: true });
  });

  test("uses the stored token before the environment token", () => {
    process.env.GH_TOKEN = "env-token";
    gitHubProvider.saveCredential({ token: " stored-token " });

    expect(token()).toBe("stored-token");
  });

  test("keeps reading tokens stored by older installations", async () => {
    const tokenPath = join(dataDir, "workspace", "github-token");
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, "legacy-token\n");

    expect(token()).toBe("legacy-token");
  });

  test("shares credentials and disconnect state with the release-notes reader and older installations", () => {
    process.env.GH_TOKEN = "inherited-token";
    setGitHubToken("previously-saved-token");
    expect(token()).toBe("previously-saved-token");
    gitHubProvider.saveCredential({ token: "provider-token" });
    expect(discoverGitHubToken()).toBe("provider-token");
    gitHubProvider.clearCredential();
    expect(discoverGitHubToken()).toBeUndefined();
    expect(token()).toBeUndefined();
  });

  test("falls back to GH_TOKEN when no token is stored", () => {
    process.env.GH_TOKEN = " env-token ";

    expect(token()).toBe("env-token");
  });

  test("disconnect suppresses a discovered GH_TOKEN until a token is connected again", () => {
    process.env.GH_TOKEN = "env-token";

    gitHubProvider.clearCredential();
    expect(gitHubProvider.credential()).toBeUndefined();

    gitHubProvider.saveCredential({ token: "reconnected-token" });
    expect(token()).toBe("reconnected-token");
  });

  test("falls back to GH_TOKEN when the stored token file is blank", async () => {
    const tokenPath = join(dataDir, "workspace", "github-token");
    await mkdir(dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, "\n");
    process.env.GH_TOKEN = "env-token";

    expect(token()).toBe("env-token");
  });

  test("treats a blank GH_TOKEN as missing", () => {
    process.env.GH_TOKEN = "  ";

    expect(gitHubProvider.credential()).toBeUndefined();
  });
});
