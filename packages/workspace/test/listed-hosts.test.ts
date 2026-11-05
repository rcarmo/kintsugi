import { expect, test } from "bun:test";

// Isolate host/Docker boundary mocks from the other workspace tests.
async function scenario(version: number) {
  const source = new URL("../src/network.ts", import.meta.url).pathname;
  const script = `
    import { mock } from "bun:test";
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    const directory = await mkdtemp(join(tmpdir(), "listed-host-workspace-"));
    process.env.KINTSUGI_DATA_DIR = directory;
    const calls = [];
    let entries = [{host:"db.internal",port:5432}];
    mock.module("@kintsugi/host/control", () => ({ hostAvailable: () => true, readSystemVersion: async () => ${version}, hostRequest: async request => {
      calls.push(request);
      return {mode:request.mode,cidrs:[],dns:[],search:[],denied:[],destinations:request.mode === "hosts" ? request.destinations.map(d => ({...d,addresses:["10.199.254.250"]})) : undefined};
    }}));
    mock.module("@kintsugi/workspace-templates/private-network", () => ({ effectivePrivateNetworkAccess: async () => entries }));
    const workspace = await import("@kintsugi/workspace");
    mock.module("@kintsugi/workspace", () => ({...workspace,getWorkspaceInit:async()=>undefined}));
    const network = await import(${JSON.stringify(source)});
    try {
      let blocked = false;
      try { await network.setWorkspaceNetworkMode("testhosts", "hosts"); } catch { blocked = true; }
      if (blocked) { console.log(JSON.stringify({blocked,mode:network.getWorkspaceNetworkMode("testhosts"),calls:calls.length})); }
      else {
        const applied = await network.prepareWorkspaceNetwork("testhosts");
        // No Docker access for an empty workspace's template identity in this isolated fixture.
        const before = await network.workspaceNetworkRestartRequired("testhosts");
        entries = [{host:"other.internal",port:22}];
        const after = await network.workspaceNetworkRestartRequired("testhosts");
        console.log(JSON.stringify({blocked,applied:applied.mode,ports:applied.destinations.map(d=>d.port),before,after,calls:calls.length}));
      }
    } finally { await rm(directory,{recursive:true,force:true}); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(err).toBe(""); expect(code).toBe(0);
  return JSON.parse(out.replace(/\x1b\[[0-9;]*m/g, ""));
}

test("older installations cannot select or silently widen listed-host permissions", async () => {
  expect(await scenario(1)).toEqual({ blocked: true, mode: "off", calls: 0 });
});

test("a supported installation applies explicit ports and list edits remain pending until restart", async () => {
  expect(await scenario(2)).toEqual({ blocked: false, applied: "hosts", ports: [5432], before: false, after: true, calls: 1 });
});
