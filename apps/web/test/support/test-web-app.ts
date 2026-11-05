import type { KintsugiEventBus, JsonObject } from "@kintsugi/core";
import type { WorkspaceDeletionReview, WorkspaceModule } from "@kintsugi/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { workspaceModules } from "../../src/server/workspace-modules.generated.ts";
import { createWebApp } from "../../src/server/app.ts";
import { createWorkspaceRegistry } from "../../src/server/workspace-registry.ts";

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type ProvisionWorkspace = Parameters<typeof createWebApp>[0]["provisionWorkspace"];
export type ProvisionWorkspaceOptions = Parameters<ProvisionWorkspace>[1];

interface TestAppOptions {
  provision?: ProvisionWorkspace;
  inspect?: (id: string) => Promise<string[]>;
  destroy?: (id: string) => Promise<void>;
  persistParked?: (id: string, parked: boolean) => Promise<void>;
  events?: KintsugiEventBus;
}

const deletionDetailsSchema = Type.Object({ risks: Type.Array(Type.String()) });

function deletionReview(inspect: (id: string) => Promise<string[]>): WorkspaceDeletionReview {
  return {
    async inspect(workspaceId) {
      const risks = await inspect(workspaceId);
      if (!risks.length) return { status: "clear" };
      const details = { risks };
      return { status: "blocked", fingerprint: String(Bun.hash(JSON.stringify(details))), details };
    },
    renderEvidence(_workspaceId, details) {
      return Value.Parse(deletionDetailsSchema, details).risks.join("\n");
    },
  };
}

// App contract fixtures have no containers. Exercise Git behavior through the
// repository tests, rather than attaching live Git-backed modules to fake IDs.
function gitWorkViewFixture(type: string, label: string): WorkspaceModule {
  const reference = { type };
  return {
    id: type,
    workViews: [{ type, parseReference: () => reference, identity: () => "workspace", render: () => "" }],
    commands: [{ id: `${type}.open`, execute: () => ({ createdWorkView: reference }) }],
    attachToWorkspace: () => ({
      workViews: [{ reference, sourceKey: `${type}:workspace`, label, kind: "contextual", availability: { phase: "live" }, initiallyOpen: false }],
      commands: [{ id: `${type}.open`, label, scope: "workspace" }],
    }),
  };
}

const testWorkspaceModules = workspaceModules.map(module => module.id === "review" ? gitWorkViewFixture("review", "Review")
  : module.id === "changes" ? gitWorkViewFixture("changes", "Changes") : module);

export function createTestApp(options: TestAppOptions = {}) {
  const registry = createWorkspaceRegistry({
    activityStore: { load: async () => ({}), save: async () => {} },
  });
  const app = createWebApp({
    registry,
    workspaceModules: testWorkspaceModules,
    events: options.events,
    provisionWorkspace: options.provision ?? (async () => {}),
    deletionReview: deletionReview(options.inspect ?? (async () => [])),
    destroyWorkspace: options.destroy ?? (async () => {}),
    persistWorkspaceParked: options.persistParked ?? (async () => {}),
    logError: () => {},
  });
  return { app, registry };
}

export function temporaryKintsugiDataDir() {
  let previous: string | undefined;
  let path: string | undefined;
  return {
    async setUp() {
      previous = process.env.KINTSUGI_DATA_DIR;
      path = await mkdtemp(join(tmpdir(), "kintsugi-web-test-"));
      process.env.KINTSUGI_DATA_DIR = path;
    },
    async tearDown() {
      if (previous === undefined) delete process.env.KINTSUGI_DATA_DIR;
      else process.env.KINTSUGI_DATA_DIR = previous;
      if (path) await rm(path, { recursive: true, force: true });
      previous = undefined;
      path = undefined;
    },
  };
}

export function post(path: string): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "text/vnd.turbo-stream.html" },
  });
}

export function postForm(path: string, body: URLSearchParams): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "text/vnd.turbo-stream.html", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
}

export function postJson(path: string, body: JsonObject): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
