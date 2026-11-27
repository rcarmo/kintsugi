import { expect, test } from "bun:test";
import { AppHealthMonitor, appHealthIntervalMs, probeAppHealth, type AppHealthProbe } from "./app-health.ts";
import { installationStatus } from "./installation-status.ts";
import { startProxyIngress } from "./local-ingress.ts";

const origin = "https://health-fixture.example";
async function withHealthFixture(run: (fixture: ReturnType<typeof healthFixture>) => Promise<void>) {
  const fixture = healthFixture();
  try { await run(fixture); }
  finally { fixture.close(); }
}
function healthFixture() {
  let mode: "ok" | "delayed" | "unavailable" = "ok", now = 0;
  const backend = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (new URL(request.url).pathname !== "/up") return new Response("App route");
    if (mode === "delayed") await Bun.sleep(120);
    return new Response("Health", { status: mode === "unavailable" ? 503 : 200 });
  } });
  let appPort = backend.port!;
  const proxy = startProxyIngress(() => appPort, () => ({ origin, previewPorts: { start: 41000, end: 41009 } }), 0);
  const routes: boolean[] = [], diagnostics: { state: string; probe: AppHealthProbe; consecutiveFailures: number }[] = [];
  const monitor = new AppHealthMonitor({
    probe: () => probeAppHealth(`http://127.0.0.1:${backend.port}/up`, mode === "delayed" ? 35 : 500),
    routeToApp: async open => { routes.push(open); appPort = open ? backend.port! : 0; },
    change: () => {}, diagnostic: event => diagnostics.push(event), stopped: () => false, now: () => now,
  });
  monitor.ready();
  return {
    async check(value: typeof mode, delay = appHealthIntervalMs) { mode = value; now += delay; await monitor.recheck(); },
    status() { return installationStatus({
      activity: { description: "Checking" }, localMode: true, proxyMode: true, localOrigin: origin,
      stopping: false, busy: false, appResponding: monitor.state === "ready",
      recoveringHealth: monitor.recovering, degradedHealth: monitor.state === "degraded",
      appliedRoute: "", connectionState: "", logs: [],
    }); },
    publicRequest: () => fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { host: new URL(origin).host } }),
    close() { proxy.stop(true); backend.stop(true); },
    routes, diagnostics, monitor,
  };
}

test("a delayed health probe keeps the public route but does not report installation readiness", async () => {
  await withHealthFixture(async fixture => {
    expect(fixture.status().state).toBe("ready");
    await fixture.check("delayed");
    expect(fixture.status()).toMatchObject({ state: "starting", recoveringHealth: true });
    expect(fixture.status().appUrl).toBeUndefined();
    expect(fixture.status().activity.description).toContain("without closing access");
    expect(fixture.diagnostics[0]).toMatchObject({ state: "degraded", probe: { kind: "timeout" }, consecutiveFailures: 1 });
    expect(await (await fixture.publicRequest()).text()).toBe("App route");
    await fixture.check("ok");
    expect(fixture.status()).toMatchObject({ state: "ready", appUrl: origin });
    expect(fixture.routes).toEqual([]);
  });
});

test("alternating failures neither withdraw ingress nor flood diagnostics", async () => {
  await withHealthFixture(async fixture => {
    for (let i = 0; i < 4; i++) {
      await fixture.check("delayed");
      expect((await fixture.publicRequest()).status).toBe(200);
      expect(fixture.status().state).toBe("starting");
      await fixture.check("ok");
      expect(fixture.status().state).toBe("ready");
    }
    expect(fixture.routes).toEqual([]);
    expect(fixture.diagnostics).toHaveLength(1);
  });
});

test("sustained failures withdraw the public route and a successful probe restores it", async () => {
  await withHealthFixture(async fixture => {
    await fixture.check("unavailable");
    expect((await fixture.publicRequest()).status).toBe(200);
    await fixture.check("unavailable");
    expect((await fixture.publicRequest()).status).toBe(200);
    await fixture.check("unavailable");
    const withdrawn = await fixture.publicRequest();
    expect(withdrawn.status).toBe(404);
    expect(await withdrawn.text()).toContain("Unknown Kintsugi endpoint");
    expect(fixture.status()).toMatchObject({ state: "starting", recoveringHealth: true });
    expect(fixture.diagnostics.at(-1)).toMatchObject({ state: "recovering", probe: { kind: "http", status: 503 } });
    await fixture.check("ok");
    expect(fixture.routes).toEqual([false, true]);
    expect((await fixture.publicRequest()).status).toBe(200);
    expect(fixture.status().state).toBe("ready");
    expect(fixture.diagnostics.at(-1)).toMatchObject({ state: "ready", probe: { kind: "ok" } });
  });
});

test("rapid manual rechecks cannot withdraw ingress before the confirmation interval", async () => {
  await withHealthFixture(async fixture => {
    for (let i = 0; i < 4; i++) await fixture.check("unavailable", 0);
    expect(fixture.monitor.state).toBe("degraded");
    expect(fixture.routes).toEqual([]);
    expect((await fixture.publicRequest()).status).toBe(200);
  });
});

test("health probe errors are separate from HTTP responses", async () => {
  const result = await probeAppHealth("not a URL");
  expect(result.kind).toBe("error");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
});

test("replacing an app resets the failure streak and shutdown invalidates the pending probe", async () => {
  const pending = Promise.withResolvers<AppHealthProbe>();
  let stopped = false, now = 0;
  const routes: boolean[] = [];
  const monitor = new AppHealthMonitor({
    probe: () => pending.promise, routeToApp: async open => { routes.push(open); },
    change: () => {}, diagnostic: () => {}, stopped: () => stopped, now: () => now,
  });
  monitor.ready();
  const failed = monitor.recheck();
  pending.resolve({ kind: "error", name: "ConnectionError", elapsedMs: 2 });
  await failed;
  now += appHealthIntervalMs;
  await monitor.recheck();
  expect(monitor.state).toBe("degraded");
  monitor.reset();
  expect(monitor.state).toBe("inactive");
  monitor.ready();
  now += appHealthIntervalMs;
  await monitor.recheck();
  expect(monitor.state).toBe("degraded");
  const last = monitor.recheck();
  stopped = true;
  monitor.reset();
  await last;
  expect(monitor.state).toBe("inactive");
  expect(routes).toEqual([]);
});
