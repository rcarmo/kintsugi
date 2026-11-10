import { Type } from "typebox";
import { Value } from "typebox/value";
import { CableTopics, decodeCableServerMessage } from "@kintsugi/shared";
import type { JsonObject } from "../packages/core/src/index.ts";
// Run on a second physical LAN client. Mutates only a newly created disposable workspace when explicitly requested.
import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { ui: { type: "string" }, api: { type: "string" }, ca: { type: "string" }, "token-file": { type: "string" }, out: { type: "string" }, "preview-origin": { type: "string" }, "confirm-create-workspace": { type: "boolean", default: false } } });
if (!values.ui || !values.api || !values.ca || !values["token-file"] || !values.out) throw new Error("Require --ui URL --api URL --ca PUBLIC_CA --token-file PRIVATE_TOKEN --out NEW_REPORT.json");
for (const origin of [values.ui, values.api, ...(values["preview-origin"] ? [values["preview-origin"]] : [])]) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error("Use canonical HTTPS origins without credentials");
}
const ca = await readFile(values.ca, "utf8");
const captured = (await readFile(values["token-file"], "utf8")).trim();
const token = captured.startsWith("{") ? JSON.parse(captured).secret : captured;
if (!Value.Check(Type.String({ pattern: "^kintsugi_admin_[A-Za-z0-9_-]{43}$" }), token)) throw new Error("Invalid token file; expected issued JSON or the raw bearer secret");
const checks: string[] = [];
async function request(origin: string, path: string, method = "GET", body?: JsonObject, authenticated = false, browserOrigin = values.ui!) {
  const headers = new Headers({ accept: "application/json", "content-type": "application/json", origin: browserOrigin });
  if (authenticated) headers.set("authorization", `Bearer ${token}`);
  return fetch(origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), tls: { ca }, signal: AbortSignal.timeout(30_000) });
}
async function api(path: string, method = "GET", body?: JsonObject) {
  const response = await request(values.api!, path, method, body, true);
  if (!response.ok) throw new Error(`API ${method} ${path}: ${response.status}`);
  return response.json();
}
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(1000); }
  throw new Error("Workspace lifecycle timed out");
}
let created: string | undefined;
try {
  assert.equal((await request(values.ui, "/up")).status, 200); checks.push("CA-verified UI TLS");
  assert.equal((await request(values.api, "/openapi.json")).status, 401);
  const contract = await api("/openapi.json"); assert.equal(contract.openapi, "3.1.0"); checks.push("API rejects missing token and accepts scoped bearer token");
  assert.equal((await request(values.ui, "/lan-probe-no-route", "POST", {})).status, 404);
  for (const origin of ["https://foreign.invalid", "null"]) assert.equal((await request(values.ui, "/lan-probe-no-route", "POST", {}, false, origin)).status, 403, `Denied origin ${origin}`);
  const missing = await fetch(values.ui + "/lan-probe-no-route", { method: "POST", tls: { ca } }); assert.equal(missing.status, 403);
  checks.push("Foreign, null and missing origins rejected; same-origin reaches routing");
  const events = await request(values.ui, "/settings/access/events");
  assert.equal(events.status, 200); assert(events.headers.get("content-type")?.startsWith("text/event-stream"));
  const reader = events.body!.getReader(); assert((await reader.read()).value?.length); await reader.cancel(); checks.push("Settings SSE delivered without waiting for stream completion");
  // SAFETY: This CLI runs in Bun, whose WebSocket constructor accepts Origin and TLS options.
  const Client = WebSocket as typeof WebSocket & (new (url: string, options: Bun.WebSocketOptions) => WebSocket);
  const live = new Client(values.ui.replace("https:", "wss:") + "/cable", { headers: { origin: values.ui }, tls: { ca } });
  await new Promise<void>((resolve, reject) => {
    const subscriptionId = crypto.randomUUID();
    const identifier = CableTopics.shell();
    let welcomed = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      live.onclose = null;
      live.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("Live WebSocket subscription timed out")), 30_000);
    live.onerror = () => finish(new Error("Live WebSocket connection failed"));
    live.onclose = () => finish(new Error("Live WebSocket closed before subscription confirmation"));
    live.onmessage = event => {
      try {
        const message = decodeCableServerMessage(event.data);
        if (!welcomed) {
          assert.equal(message.type, "welcome");
          welcomed = true;
          live.send(JSON.stringify({ command: "subscribe", identifier, subscriptionId }));
        } else if (message.type === "confirm_subscription") {
          assert.equal(message.subscriptionId, subscriptionId);
          assert.deepEqual(message.identifier, identifier);
          live.send(JSON.stringify({ command: "unsubscribe", identifier, subscriptionId }));
          finish();
        } else if (message.type === "reject_subscription" || message.type === "error") {
          throw new Error(`Live WebSocket command failed: ${message.type}`);
        }
      } catch (error) { finish(new Error("Live WebSocket message failed verification", { cause: error })); }
    };
  });
  checks.push("CA-verified management WebSocket welcome and subscription round trip");
  if (values["preview-origin"]) {
    assert.notEqual(new URL(values["preview-origin"]).origin, values.ui);
    const preview = await request(values["preview-origin"], "/"); assert.equal(preview.status, 200);
    assert.equal((await request(values.ui, "/lan-probe-no-route", "POST", {}, false, values["preview-origin"])).status, 403);
    checks.push("Separate preview origin reachable and denied management mutation");
  }
  if (values["confirm-create-workspace"]) {
    const createdResult = await api("/workspaces", "POST", { source: { type: "empty" }, title: "Disposable LAN acceptance" });
    created = createdResult.workspace.id;
    await until(async () => { const detail = await api(`/workspaces/${created}`); if (detail.workspace.phase.status === "failed") throw new Error("Workspace provisioning failed"); return detail.workspace.phase.kind === "runningPhase"; });
    assert.equal((await request(values.ui, `/workspaces/${created}/sidebar-title`, "POST", { title: "LAN mutation verified" })).status, 200);
    assert.equal((await api(`/workspaces/${created}`)).workspace.title, "LAN mutation verified");
    await api(`/workspaces/${created}/park?force=1`, "POST", {});
    await until(async () => (await api("/workspaces")).workspaces.some((workspace: { id: string; parked?: boolean }) => workspace.id === created && workspace.parked === true));
    await api(`/workspaces/${created}/unpark`, "POST", {});
    await until(async () => (await api("/workspaces")).workspaces.some((workspace: { id: string; parked?: boolean }) => workspace.id === created && !workspace.parked));
    checks.push("Disposable workspace creation, actual same-origin mutation, park and unpark");
  }
} finally {
  if (created) { await api(`/workspaces/${created}/delete`, "POST", { force: true }); checks.push("Deleted only the workspace created by this probe"); }
}
await writeFile(values.out, JSON.stringify({ result: "pass", ui: values.ui, api: values.api, checks, clientArchitecture: process.arch, verification: "Run on a separate physical LAN client. This records client reachability; use host preflight and disposable System integration for ARM kernel, upstream plaintext, restart/update and file persistence evidence.", unverified: [...(!values["preview-origin"] ? ["Preview reachability and isolation"] : []), ...(!values["confirm-create-workspace"] ? ["Workspace lifecycle and actual mutation"] : []), "Browser/terminal visual interaction", "Host ARM kernel and storage capability", "Installation restart/update/rollback and file persistence"] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`PASS: ${checks.length} LAN protocol checks; report ${values.out}`);
