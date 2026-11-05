import { describe, expect, test } from "bun:test";
import { gitCredentialHelperShellBody, gitHostingGitConfiguration, gitHostingProvider, gitHostingShorthandUrl } from "../src/index.ts";

async function runCredentialHelper(input: string, env: Record<string, string> = { GH_TOKEN: "github-secret", GITLAB_TOKEN: "gitlab-secret", BITBUCKET_API_TOKEN: "bitbucket-secret" }): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", gitCredentialHelperShellBody(), "kintsugi-git-credential", "get"], {
    env: { PATH: process.env.PATH ?? "", ...env },
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

describe("git credential helper", () => {
  test("offers each token only to its own HTTPS host", async () => {
    expect(await runCredentialHelper("protocol=https\nhost=github.com\n\n")).toBe("username=x-access-token\npassword=github-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=github.com:443\n\n")).toBe("username=x-access-token\npassword=github-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=gitlab.com\n\n")).toBe("username=oauth2\npassword=gitlab-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=bitbucket.org\n\n")).toBe("username=x-bitbucket-api-token-auth\npassword=bitbucket-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=example.com\n\n")).toBe("");
    expect(await runCredentialHelper("protocol=https\nhost=gitlab.com.evil.test\n\n")).toBe("");
    expect(await runCredentialHelper("protocol=ssh\nhost=github.com\n\n")).toBe("");
  });

  test("stays quiet for hosts whose provider is not connected", async () => {
    expect(await runCredentialHelper("protocol=https\nhost=gitlab.com\n\n", { GH_TOKEN: "github-secret" })).toBe("");
  });

  test("ignores store and erase requests", async () => {
    // Ignored operations exit before reading stdin; do not race a write against that intentional exit.
    for (const operation of ["store", "erase"]) {
      const proc = Bun.spawn(["sh", "-c", gitCredentialHelperShellBody(), "kintsugi-git-credential", operation], { env: { GH_TOKEN: "github-secret" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
    }
  });
});

test("expands provider shorthand to HTTPS URLs", () => {
  expect(gitHostingShorthandUrl("github.com/org/repo")).toBe("https://github.com/org/repo");
  expect(gitHostingShorthandUrl("GitLab.com/group/sub/project")).toBe("https://GitLab.com/group/sub/project");
  expect(gitHostingShorthandUrl("bitbucket.org/workspace/repo#main")).toBe("https://bitbucket.org/workspace/repo#main");
  expect(gitHostingShorthandUrl("example.com/org/repo")).toBeUndefined();
  expect(gitHostingShorthandUrl("/work/local-repo")).toBeUndefined();
});

test("configurable helper captures the instance and token together and matches IPv6 authorities literally", async () => {
  const {mkdtemp,rm}=await import("node:fs/promises");const {tmpdir}=await import("node:os");const {join}=await import("node:path");
  const previous=process.env.KINTSUGI_DATA_DIR;const dir=await mkdtemp(join(tmpdir(),"kintsugi-gitea-helper-"));process.env.KINTSUGI_DATA_DIR=dir;
  try {
    const provider=gitHostingProvider("gitea");
    provider.saveCredential({serverUrl:"https://git.example.test:8443",account:"alice",token:"first-token"});
    const first=gitHostingGitConfiguration();
    provider.saveCredential({serverUrl:"https://[fd00::8]:9443",account:"bob",token:"second-token"});
    const second=gitHostingGitConfiguration();
    async function invoke(shell:string,environment:Record<string,string>,host:string){
      const proc=Bun.spawn(["sh","-c",shell,"fixture","get"],{env:{PATH:process.env.PATH??"",...environment},stdin:"pipe",stdout:"pipe",stderr:"pipe"});proc.stdin.write("protocol=https\nhost="+host+"\n\n");proc.stdin.end();
      const [out,err,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);expect(code).toBe(0);expect(err).toBe("");return out;
    }
    expect(await invoke(first.shellBody,first.environment,"git.example.test:8443")).toBe("username=alice\npassword=first-token\n");
    expect(await invoke(second.shellBody,second.environment,"git.example.test:8443")).toBe("");
    expect(await invoke(second.shellBody,second.environment,"[fd00::8]:9443")).toBe("username=bob\npassword=second-token\n");
    expect(await invoke(second.shellBody,second.environment,"[fd00::8]:443")).toBe("");
  } finally {if(previous===undefined)delete process.env.KINTSUGI_DATA_DIR;else process.env.KINTSUGI_DATA_DIR=previous;await rm(dir,{recursive:true,force:true});}
});
