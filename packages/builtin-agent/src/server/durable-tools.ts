import { awaitWithContext } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord/json";
import { defineTool, type ToolRegistration, type ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEditTool, createReadTool, createWriteTool, type ImageProcessor } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import type { Static, TSchema } from "typebox";
import { createKintsugiControlTools, type WorkspaceAgentToolOptions } from "@kintsugi/agent/server/tools";
import { WorkspaceFileSystem } from "./durable-workspace-files.ts";
import type { WorkspaceTool } from "@kintsugi/agent/server/workspace-tool";

/**
 * Adapt a context-free workspace capability, not an AgentSession extension.
 * Replay is opt-in at assembly, never inferred from a tool's name.
 */
export function durableWorkspaceTool<TParams extends TSchema>(
  tool: WorkspaceTool<TParams, unknown>,
  replay: "safe" | "unsafe" = "unsafe",
  resolveAgentId?: (conversationId: ConversationId) => Promise<string>,
): ToolRegistration<TParams> {
  return defineTool({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    // SAFETY: TypeBox's Static and pi-schema's (which types Durable tool arguments) describe the same JSON values.
    prepareArguments: tool.prepareArguments as ToolRegistration<TParams>["prepareArguments"],
    executionMode: tool.executionMode,
    replay,
    async execute(args, api, context) {
      // SDK updates are snapshots, not append-only output. Store the snapshot in
      // details instead of duplicating every revision in the model transcript.
      let updates = Promise.resolve();
      const failures: unknown[] = [];
      try {
        if (tool.requiresAgentIdentity && !resolveAgentId) throw new Error("Verified Agent identity is unavailable");
        const identity = tool.requiresAgentIdentity ? { agentId: await resolveAgentId!(api.conversationId) } : undefined;
        // SAFETY: The Harness validates against the same JSON schema; only Static typings differ.
        const operation = Promise.resolve(tool.execute(api.callId, args as Static<TParams>, context.abortSignal, (partial) => {
          if (context.abortSignal?.aborted) return;
          const snapshot = copyJson(partial, { omitUndefinedProperties: true });
          updates = updates.then(() => api.details(snapshot, context)).catch((error) => {
            // The SDK callback cannot await writes. Observe rejection now and
            // propagate it before returning the tool result, never fire-and-forget.
            failures.push(error);
          });
        }, identity));
        // A capability may itself await workspace deletion, which joins this
        // invocation. Cancel the waiter, not the external effect, to break that
        // cycle. Unsafe effects retain native interrupted/uncertain semantics.
        const observed = operation.catch(error => {
          if (context.abortSignal?.aborted) console.error(`[durable tool ${tool.name}] operation failed after cancellation`, error);
          throw error;
        });
        const result = await awaitWithContext(observed, context);
        await updates;
        if (failures.length) throw failures[0];
        return {
          output: result.content,
          details: result.details === undefined ? undefined : copyJson(result.details, { omitUndefinedProperties: true }),
        };
      } finally {
        await updates;
      }
    },
  });
}

let photon: Promise<ImageProcessor> | undefined;
/** Resizes and converts images for the model, in a worker that starts with the first image `read` meets. */
const images: ImageProcessor = {
  async prepare(bytes, mimeType, limits) { return (await (photon ??= createNodePhotonImages())).prepare(bytes, mimeType, limits); },
};

/** `tool`, run on the files `env` reaches. */
function onFiles<TParams extends object>(tool: ToolRegistration<TParams>, env: ExecutionEnv): ToolRegistration<TParams> {
  return { ...tool, execute: (args, api, context) => tool.execute(args, { ...api, env }, context) };
}

/** pi-durable's read, write and edit on the files `env` reaches. Only the observational read reruns after a crash. */
export function createDurableFileTools(env: ExecutionEnv): ToolRegistration<any>[] {
  return [
    { ...onFiles(createReadTool({ images }), env), replay: "safe" },
    { ...onFiles(createWriteTool(), env), replay: "unsafe" },
    { ...onFiles(createEditTool(), env), replay: "unsafe" },
  ];
}

/** File/image and presentation capabilities ready for the native Durable registry. */
export function createDurableWorkspaceTools(workspaceId: string, options: WorkspaceAgentToolOptions = {}, resolveAgentId?: (conversationId: ConversationId) => Promise<string>): ToolRegistration<any>[] {
  return [
    ...createDurableFileTools(new WorkspaceFileSystem(workspaceId)),
    ...createKintsugiControlTools(workspaceId, { ...options, embeds: true }).map((tool) => durableWorkspaceTool(tool, "unsafe", resolveAgentId)),
    // Install createDurableBashExtension alongside these tools; it owns both
    // the bash task, backed by a terminal process, and its tool registration.
  ];
}
