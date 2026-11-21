import { expect, test } from "bun:test";
import { installationStatus } from "./installation-status.ts";

const input = {
  activity: { description: "Preparing Kintsugi", percent: 40 },
  stopping: false, busy: false, appResponding: true,
  hostname: "kintsugi.example.ts.net", appliedRoute: "kintsugi.example.ts.net:3000",
  connectionState: "Running", logs: ["App exited with code 1"],
};

test("health recovery stays pending until the app responds, but terminal failures still win", () => {
  const input = { activity: { description: "Kintsugi needs attention" }, localMode: true, localOrigin: "http://kintsugi.localhost:5000", stopping: false, busy: false, appResponding: false, appliedRoute: "", connectionState: "", logs: [] };
  const pending = installationStatus({ ...input, recoveringHealth: true });
  expect(pending.state).toBe("starting");
  expect(pending.recoveringHealth).toBe(true);
  expect(pending.activity.description).toContain("stopped responding to health checks");
  expect(pending.appUrl).toBeUndefined();
  expect(pending.action).toBeUndefined();
  expect(installationStatus({ ...input, appResponding: true, recoveringHealth: true }).state).toBe("starting");
  expect(installationStatus({ ...input, appResponding: true }).state).toBe("ready");
  expect(installationStatus({ ...input, recoveringHealth: true, failure: "Startup failed" }).state).toBe("failed");
  expect(installationStatus({ ...input, recoveringHealth: true, stopping: true }).state).toBe("failed");
});

test("System owns destinations and only releases the app URL after health and routing", () => {
  const status = installationStatus(input);
  expect(status.state).toBe("ready");
  expect(status.appUrl).toBe("https://kintsugi.example.ts.net");
  expect(status.supervisorUrl).toBe("https://kintsugi.example.ts.net:8443");
  for (const change of [{ appResponding: false }, { busy: true }, { appliedRoute: "kintsugi.example.ts.net:3001" }, { hostname: undefined }]) {
    const pending = installationStatus({ ...input, ...change });
    expect(pending.state).toBe("starting");
    expect(pending.appUrl).toBeUndefined();
  }
});

test("failure offers routed diagnostics, not the app", () => {
  const status = installationStatus({ ...input, failure: "Health timed out" });
  expect(status.state).toBe("failed");
  expect(status.activity.description).toBe("Health timed out");
  expect(status.appUrl).toBeUndefined();
  expect(status.supervisorUrl).toBeDefined();
  expect(status.diagnostics?.lines).toEqual([]);
});

test("failure without routing provides recent System logs directly", () => {
  const status = installationStatus({ ...input, failure: "Health timed out", appliedRoute: "" });
  expect(status.supervisorUrl).toBeUndefined();
  expect(status.diagnostics?.lines).toEqual(input.logs);
});

test("System translates sign-in and machine approval into user actions", () => {
  const disconnected = { ...input, hostname: undefined, appliedRoute: "" };
  const login = installationStatus({ ...disconnected, connectionState: "NeedsLogin", authUrl: "https://login.tailscale.com/a/example" });
  expect(login.state).toBe("starting");
  expect(login.action?.url).toBe("https://login.tailscale.com/a/example");
  expect(login.appUrl).toBeUndefined();
  const approval = installationStatus({ ...disconnected, connectionState: "NeedsMachineAuth" });
  expect(approval.action?.url).toBe("https://login.tailscale.com/admin/machines");
  expect(installationStatus(input).action).toBeUndefined();
});

test("stopping never advertises readiness and unknown-duration activity has no percent", () => {
  expect(installationStatus({ ...input, stopping: true }).state).toBe("failed");
  const starting = installationStatus({ ...input, appResponding: false, activity: { description: "Starting Kintsugi" } });
  expect(starting.activity.percent).toBeUndefined();
});

test("local install becomes ready without Tailscale and keeps diagnostics reachable", () => {
  const status = installationStatus({ activity: { description: "Starting" }, stopping: false, busy: false, appResponding: true, appliedRoute: "", connectionState: "NeedsLogin", authUrl: "https://login.tailscale.com/test", logs: [], localMode: true, localOrigin: "http://kintsugi.localhost:55001" });
  expect(status.state).toBe("ready");
  expect(status.appUrl).toBe("http://kintsugi.localhost:55001");
  expect(status.supervisorUrl).toBe("http://system.kintsugi.localhost:55001");
  expect(status.action).toBeUndefined();
});

test("failures suppress unrelated sign-in actions", () => {
  const status = installationStatus({ ...input, failure: "Host requirement missing", connectionState: "NeedsLogin", authUrl: "https://login.example" });
  expect(status.state).toBe("failed");
  expect(status.activity.description).toBe("Host requirement missing");
  expect(status.action).toBeUndefined();
  expect(status.appUrl).toBeUndefined();
});

test("HTTPS setup is recoverable and cannot advertise readiness or a stale app URL", () => {
  for (const action of [
    { description: "Enable MagicDNS and HTTPS Certificates", url: "https://login.tailscale.com/admin/dns" },
    { description: "Could not provision a certificate. Retrying automatically." },
  ]) {
    const pending = installationStatus({ ...input, connectionAction: action });
    expect(pending.state).toBe("starting");
    expect(pending.action).toEqual(action);
    expect(pending.supervisorUrl).toBeUndefined();
    expect(pending.appUrl).toBeUndefined();
    expect(installationStatus({ ...input, connectionAction: action, localMode: true, localOrigin: "http://kintsugi.localhost:5000" }).state).toBe("ready");
  }
  expect(installationStatus(input).state).toBe("ready");
});
