import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { durableWorkspaceTool } from "../../../src/server/durable-tools.ts";
import { defineWorkspaceTool } from "@kintsugi/agent/server/workspace-tool";
import { openDurableWorkspace } from "../../../src/server/durable-workspace.ts";

const [directory, replay] = process.argv.slice(2);
if (!directory || (replay !== "safe" && replay !== "unsafe" && replay !== "generation")) throw new Error("Expected directory and replay policy");
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: replay === "generation" ? 10 : 100_000 });
models.setProvider(faux.provider);
faux.setResponses([replay === "generation" ? fauxAssistantMessage("Committed partial before crash. ".repeat(100)) : fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" })]);
const registry = createRegistry();
registry.install(defineExtension({
  name: "crash-test",
  tools: [durableWorkspaceTool(defineWorkspaceTool({
    name: "effect",
    label: "Effect",
    description: "Exercise recovery after execution started",
    parameters: Type.Object({}),
    async execute(_callId, _args, signal, update) {
      await appendFile(join(directory, "executions.txt"), "executed\n");
      update?.({ content: [], details: { started: true } });
      process.stdout.write("effect-started\n");
      // The parent kills this process without running any shutdown handlers.
      return await new Promise<never>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    },
  }), replay === "generation" ? "safe" : replay)],
}));
const workspace = await openDurableWorkspace(directory, "crash-workspace", { models, registry });
const conversation = await workspace.agent({ agentId: "crash-tab", label: "Agent 1", title: "Crash recovery" }, {
  model: { provider: "faux", modelId: "faux-1" },
});
await conversation.submit({ type: "input", content: "Run the operation", requestId: "crash-request" }, BACKGROUND_CONTEXT);
if (replay === "generation") {
  // Watches show a partial at once; only a stored one survives the crash.
  const observation = workspace.harness.observeCommits({
    advance(publication) {
      if (!JSON.stringify(publication.changes).includes("Committed")) return;
      observation.detach();
      process.stdout.write("partial-committed\n");
    },
    end() {},
  });
}
// Keep the fixture alive even if the provider has no more active I/O.
setInterval(() => {}, 60_000);
