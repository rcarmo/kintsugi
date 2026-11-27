import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createKeyedOperationQueue, KintsugiCoreError, getKintsugiRuntimeContext, isJsonObject, isNotFoundError, writeJsonAtomic, type JsonValue } from "@kintsugi/core";
import { errorMessage, type WorkspaceWorkViewReference } from "@kintsugi/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";
export type { WorkspaceWorkViewReference } from "@kintsugi/shared";

/** Resource module contribution and type adapter for one Work view kind. */
export interface WorkspaceWorkViewContribution<Reference extends WorkspaceWorkViewReference = WorkspaceWorkViewReference> {
  type: Reference["type"];
  parseReference(value: JsonValue): Reference;
  identity(reference: Reference): string;
}

export interface WorkspaceWorkViewState<Reference extends WorkspaceWorkViewReference = WorkspaceWorkViewReference> {
  reference: Reference;
}

export interface WorkspacePresentationStore {
  dismissedWarnings(workspaceId: string): Promise<Record<string, string>>;
  dismissWarning(workspaceId: string, kind: string, state: string): Promise<void>;
  initialize(workspaceId: string, initialWorkViews?: WorkspaceWorkViewReference[]): Promise<void>;
  listWorkViews(workspaceId: string): Promise<WorkspaceWorkViewState[]>;
  openWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, options?: { after?: WorkspaceWorkViewReference }): Promise<{ opened: boolean }>;
  reorderWorkView(workspaceId: string, reference: WorkspaceWorkViewReference, index: number): Promise<void>;
  closeWorkView(workspaceId: string, reference: WorkspaceWorkViewReference): Promise<void>;
}

export interface WorkspacePresentationStoreOptions {
  dataDir?: string;
  workViewContributions: readonly WorkspaceWorkViewContribution[];
}

interface StoredPresentation {
  workViewsInitialized: boolean;
  dismissedWarnings: Record<string, string>;
  version: 1;
  workViews: WorkspaceWorkViewState[];
}

const presentationFilename = "presentation.json";
const workViewTypeSchema = Type.String();
const booleanSchema = Type.Boolean();
const dismissedWarningsSchema = Type.Record(Type.String(), Type.String());

function presentationError(workspaceId: string, message: string): KintsugiCoreError {
  return new KintsugiCoreError("workspace_presentation_invalid", `invalid presentation state for workspace ${workspaceId}: ${message}`);
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(workspaceId)) throw new KintsugiCoreError("invalid_arguments", `invalid workspace id: ${workspaceId}`);
}

export function createWorkspacePresentationStore(options: WorkspacePresentationStoreOptions): WorkspacePresentationStore {
  const dataDir = options.dataDir ?? getKintsugiRuntimeContext().kintsugiDataDir;
  const adapters = new Map(options.workViewContributions.map((adapter) => [adapter.type, adapter]));
  const serialized = createKeyedOperationQueue();

  if (adapters.size !== options.workViewContributions.length) throw new KintsugiCoreError("invalid_arguments", "Work view contribution types must be unique");

  function pathFor(workspaceId: string): string {
    assertWorkspaceId(workspaceId);
    return join(dataDir, "workspaces", workspaceId, "metadata", presentationFilename);
  }

  function referenceError(workspaceId: string, message: string, stored: boolean): KintsugiCoreError {
    return stored
      ? presentationError(workspaceId, message)
      : new KintsugiCoreError("work_view_reference_invalid", `invalid Work view reference for workspace ${workspaceId}: ${message}`);
  }

  function parseReference(workspaceId: string, value: JsonValue, stored = false): WorkspaceWorkViewReference {
    if (!isJsonObject(value)) throw referenceError(workspaceId, "reference must be an object", stored);
    const type = value.type;
    if (!Value.Check(workViewTypeSchema, type)) throw referenceError(workspaceId, "reference must have a type", stored);
    const adapter = adapters.get(type);
    if (!adapter) throw referenceError(workspaceId, `unknown Work view type: ${type}`, stored);
    try {
      return adapter.parseReference(value);
    } catch (error) {
      throw referenceError(workspaceId, errorMessage(error), stored);
    }
  }

  function identity(reference: WorkspaceWorkViewReference): string {
    const adapter = adapters.get(reference.type)!;
    return `${reference.type}:${adapter.identity(reference)}`;
  }

  function parse(workspaceId: string, value: JsonValue): StoredPresentation {
    if (!isJsonObject(value)) throw presentationError(workspaceId, "expected version 1 state");
    const { version, workViews: storedWorkViews } = value;
    if (version !== 1 || !Array.isArray(storedWorkViews)) {
      throw presentationError(workspaceId, "expected version 1 state");
    }
    const workViews = storedWorkViews.flatMap((entry, index) => {
      if (!isJsonObject(entry)) throw presentationError(workspaceId, `Work view ${index} must be an object`);
      // Skip legacy Review views and Subagents entries only when the Subagents module is absent.
      const type = isJsonObject(entry.reference) ? entry.reference.type : undefined;
      if (type === "review" || (type === "subagents" && !adapters.has(type))) return [];
      return [{ reference: parseReference(workspaceId, entry.reference, true) }];
    });
    const identities = workViews.map(({ reference }) => identity(reference));
    if (new Set(identities).size !== identities.length) throw presentationError(workspaceId, "Work view references must be unique");
    const dismissedWarnings = value.dismissedWarnings ?? {};
    if (!Value.Check(dismissedWarningsSchema, dismissedWarnings)) throw presentationError(workspaceId, "invalid dismissed warnings");
    const workViewsInitialized = value.workViewsInitialized ?? true;
    if (!Value.Check(booleanSchema, workViewsInitialized)) throw presentationError(workspaceId, "invalid Work view initialization state");
    return { version: 1, workViews, dismissedWarnings, workViewsInitialized };
  }

  async function read(workspaceId: string): Promise<StoredPresentation | undefined> {
    try {
      return parse(workspaceId, JSON.parse(await readFile(pathFor(workspaceId), "utf8")));
    } catch (error) {
      if (isNotFoundError(error)) return undefined;
      if (error instanceof SyntaxError) throw presentationError(workspaceId, error.message);
      throw error;
    }
  }

  async function write(workspaceId: string, state: StoredPresentation): Promise<void> {
    await writeJsonAtomic(pathFor(workspaceId), state);
  }

  async function requiredState(workspaceId: string): Promise<StoredPresentation> {
    const state = await read(workspaceId);
    if (!state) throw presentationError(workspaceId, "state is missing");
    return state;
  }

  return {
    async dismissedWarnings(workspaceId) {
      return await serialized(workspaceId, async () => ({ ...(await read(workspaceId))?.dismissedWarnings }));
    },
    async dismissWarning(workspaceId, kind, warningState) {
      await serialized(workspaceId, async () => {
        // A warning can be dismissed before modules initialize their Work views.
        const state = await read(workspaceId) ?? { version: 1, workViews: [], dismissedWarnings: {}, workViewsInitialized: false };
        state.dismissedWarnings[kind] = warningState;
        await write(workspaceId, state);
      });
    },
    async initialize(workspaceId, initialWorkViews = []) {
      await serialized(workspaceId, async () => {
        const existing = await read(workspaceId);
        if (existing?.workViewsInitialized) return;
        const state = parse(workspaceId, {
          dismissedWarnings: existing?.dismissedWarnings ?? {},
          workViewsInitialized: true,
          version: 1,
          workViews: initialWorkViews.map((reference) => ({ reference })),
        });
        await write(workspaceId, state);
      });
    },

    async listWorkViews(workspaceId) {
      return await serialized(workspaceId, async () => {
        // Navigation/recovery can list views before any container-backed module has attached.
        // Leave initialization to the first successful attachment so its defaults are retained.
        return (await read(workspaceId))?.workViews ?? [];
      });
    },

    async openWorkView(workspaceId, inputReference, openOptions = {}) {
      return await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        const reference = parseReference(workspaceId, inputReference);
        if (state.workViews.some((view) => identity(view.reference) === identity(reference))) return { opened: false };
        let insertAt = state.workViews.length;
        if (openOptions.after) {
          const after = parseReference(workspaceId, openOptions.after);
          const afterIndex = state.workViews.findIndex((view) => identity(view.reference) === identity(after));
          if (afterIndex < 0) throw new KintsugiCoreError("work_view_not_found", `Work view is not open: ${identity(after)}`);
          insertAt = afterIndex + 1;
        }
        state.workViews.splice(insertAt, 0, { reference });
        await write(workspaceId, state);
        return { opened: true };
      });
    },

    async reorderWorkView(workspaceId, inputReference, index) {
      await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        if (!Number.isSafeInteger(index) || index < 0 || index >= state.workViews.length) {
          throw new KintsugiCoreError("invalid_arguments", `invalid Work view index: ${index}`);
        }
        const reference = parseReference(workspaceId, inputReference);
        const currentIndex = state.workViews.findIndex((view) => identity(view.reference) === identity(reference));
        if (currentIndex < 0) throw new KintsugiCoreError("work_view_not_found", `Work view is not open: ${identity(reference)}`);
        if (currentIndex === index) return;
        const [view] = state.workViews.splice(currentIndex, 1);
        state.workViews.splice(index, 0, view!);
        await write(workspaceId, state);
      });
    },

    async closeWorkView(workspaceId, inputReference) {
      await serialized(workspaceId, async () => {
        const state = await requiredState(workspaceId);
        const reference = parseReference(workspaceId, inputReference);
        const index = state.workViews.findIndex((candidate) => identity(candidate.reference) === identity(reference));
        if (index < 0) throw new KintsugiCoreError("work_view_not_found", `Work view is not open: ${identity(reference)}`);
        state.workViews.splice(index, 1);
        await write(workspaceId, state);
      });
    },
  };
}
