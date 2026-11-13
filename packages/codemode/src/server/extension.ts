import { visibleMcpAgent } from "@kintsugi/builtin-agent/server/mcp-access";
import { attributeModelToolUsage } from "@kintsugi/builtin-agent/server/model-tool-usage";
import type { JsonValue } from "@earendil-works/chord/json";
import { defineEntry, type Extension, type JsonObject, type NestedToolExecutionResult, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CODEMODE_TOOL_NAME, createCodemodeExtension, createCodemodeTool, type CodemodeToolInput } from "@earendil-works/pi-durable/codemode";
import { CodemodeSandbox, type CodemodeResult } from "@earendil-works/pi-codemode";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject } from "@kintsugi/core";
import { isToolViewDetails, toolOutcomeLabel, type ToolViewDetails } from "@kintsugi/agent/server/transcript";
import { WorkspaceFileSystem } from "@kintsugi/builtin-agent/server/durable-workspace-files";
import { resolveScript, scriptFileDescription, type ReadScriptFile } from "./script-file.ts";

const textSchema = Type.String();
/** A tool with a structured output schema whose value carries its output, such as bash's. */
const outputValueSchema = Type.Object({ output: Type.String() });
/** A schema-less tool's output with several items; images are not text. */
const contentListSchema = Type.Array(Type.Union([Type.Object({ type: Type.Literal("text"), text: Type.String() }), Type.Object({ type: Type.String() })]));
const imageBlockSchema = Type.Object({ type: Type.Literal("image"), data: Type.String() });
/** Larger arguments are left out of a call's record. */
const maxRecordedArgumentsChars = 64 * 1024;

export { codemodeCallEntry, type CallStart, type CallEnd } from "@kintsugi/builtin-agent/server/codemode-call";
import { McpScriptOutputDoc, codemodeCallEntry, type CallStart, type CallEnd } from "@kintsugi/builtin-agent/server/codemode-call";

/** A value as JSON for people to read: image data, which is long and unreadable, shows as its length. */
function displayJson(value: JsonValue, indent?: number): string {
  return JSON.stringify(value, (_key: string, item: JsonValue) => Value.Check(imageBlockSchema, item) ? { ...item, data: `${item.data.length} base64 characters` } : item, indent);
}

/** The text a nested call gave the script: its output, or the value it returned as JSON. */
function outputText(structuredOutput: NestedToolExecutionResult["structuredOutput"]): string | undefined {
  if (structuredOutput === undefined) return undefined;
  if (Value.Check(textSchema, structuredOutput)) return structuredOutput;
  if (Value.Check(outputValueSchema, structuredOutput)) return structuredOutput.output;
  if (Value.Check(contentListSchema, structuredOutput)) return structuredOutput.flatMap(item => "text" in item ? [item.text] : []).join("\n");
  return displayJson(structuredOutput, 2);
}

function callStart(name: string, argumentsJson: string): CallStart {
  const start: CallStart = { phase: "start", name, issuedAt: Date.now() };
  if (argumentsJson.length <= maxRecordedArgumentsChars) start.arguments = JSON.parse(argumentsJson);
  return start;
}

function callEnd(result: NestedToolExecutionResult): CallEnd {
  const end: CallEnd = { phase: "end", isError: result.isError, cancelled: result.diagnostics.some(diagnostic => diagnostic.code === "aborted") };
  const output = outputText(result.structuredOutput);
  const error = result.diagnostics.filter(diagnostic => diagnostic.severity === "error").map(diagnostic => diagnostic.message).join("\n");
  if (result.durationMs !== undefined) end.durationMs = result.durationMs;
  if (output !== undefined) end.output = output;
  if (error) end.error = error;
  if (isJsonObject(result.details)) end.details = result.details;
  return end;
}

/** A finished call's details as the transcript shows them; a cancelled call counts as aborted. */
export function callEndDetails(end: CallEnd): ToolViewDetails | undefined {
  const details = isToolViewDetails(end.details) ? end.details : undefined;
  return end.cancelled ? { ...details, aborted: true } : details;
}

/** How a call ended, for the model, in the words its row in the transcript uses. */
function endSummary(end: CallEnd): string {
  const outcome = toolOutcomeLabel(callEndDetails(end), end.isError);
  return outcome === "failed" ? `failed: ${(end.error ?? end.output ?? "").split("\n")[0]!.slice(0, 200)}` : outcome || "ok";
}

/** A code mode call's API, recording each call its script makes, with a line of running output as it starts and ends. */
function recordingCalls(api: ToolExecutionApi): ToolExecutionApi {
  return {
    ...api,
    async executeTool(name, toolArgs, callContext, options) {
      // Code mode names each call `c<VM call id>`, so a rerun after a restart reattaches to it.
      const key = options?.key;
      if (key === undefined) throw new Error("Code mode calls tools by key");
      const record = (data: CallStart | CallEnd) => api.commit(async tx => {
        await tx.appendEntry(codemodeCallEntry, api.conversationId, { data: { callId: api.callId, key, ...data } });
      }, callContext);
      const argumentsJson = displayJson(toolArgs);
      await record(callStart(name, argumentsJson));
      api.output(`started ${key}: ${name} ${argumentsJson.slice(0, 200)}\n`);
      const result = await api.executeTool(name, toolArgs, callContext, options);
      const end = callEnd(result);
      await record(end);
      api.output(`finished ${key}: ${endSummary(end)}\n`);
      return result;
    },
  };
}

/**
 * The code mode extension, with its tool running a script file a call names, saving script output files in the
 * workspace, and recording each call its scripts make. Each call also gets a line of running output, which a stopped
 * script's result keeps: the model then knows which calls ran, since their effects stay.
 */
export function createWorkspaceCodemodeExtension(workspaceId: string, sandbox: CodemodeSandbox, readScriptFile: ReadScriptFile): Extension {
  const extension = createCodemodeExtension({ sandbox });
  // Code mode saves the images a script shows to files in the workspace, so the agent can use them later.
  const env = new WorkspaceFileSystem(workspaceId);
  return { ...extension, sections:extension.sections?.map(section => ({...section,async render(input,context) {return section.render({...input,agent:await visibleMcpAgent(workspaceId,input.conversationId,input.agent,input.read,context)},context);}})), tools: extension.tools?.map(attributeModelToolUsage).map(tool => tool.name !== CODEMODE_TOOL_NAME ? tool : {
    ...tool,
    description: `${tool.description}\n\n${scriptFileDescription}`,
    execute: async (args, api, context) => {
      // SAFETY: the harness checked the arguments against the tool's parameters.
      const input = args as CodemodeToolInput;
      const script = await resolveScript(readScriptFile, input.code, api, context);
      if ("error" in script) return script.error;
      // Observe the public sandbox result before SDK token clipping, without changing it.
      const observed = new class extends CodemodeSandbox {
        override start(code: string, options: Parameters<CodemodeSandbox["start"]>[1]) {
          const run=sandbox.start(code,options);
          const result=run.result.then(async (result:CodemodeResult)=>{
            if(result.ok && result.calls.length && result.calls.every(call=>call.name.startsWith("mcp__")) && result.output.every(item=>item.type==="text")) {
              const pieces=result.output.flatMap(item=>item.type==="text"?[item.console?`<console_output>\n${item.text}\n</console_output>`:item.text]:[]);
              if(result.value!==undefined)pieces.push(Value.Check(textSchema,result.value)?result.value:JSON.stringify(result.value));
              const raw=pieces.join("\n");
              if(Buffer.byteLength(raw)<=1024*1024)await api.commit(async tx=>{const staged=await tx.doc(McpScriptOutputDoc,api.taskId);if(Object.keys(staged.calls).length===result.calls.length)staged.raw=raw;},context);
            }
            return result;
          });
          return {result,get finished(){return run.finished;},deliver:run.deliver.bind(run)};
        }
      }();
      return await attributeModelToolUsage(createCodemodeTool({sandbox:observed})).execute({ code: script.code }, recordingCalls({ ...api, env, async agent(context) {return visibleMcpAgent(workspaceId,api.conversationId,await api.agent(context),api,context);} }), context);
    },
  }) };
}
