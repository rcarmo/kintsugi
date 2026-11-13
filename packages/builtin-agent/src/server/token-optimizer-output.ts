import { defineExtension, hook, ToolTask, type HookApi, type ToolExecutionResult, type ConversationId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { isJsonObject } from "@kintsugi/core";
import { observing, reduceToolOutput, type Policy } from "@kintsugi/token-economizer/core";
import { codemodeCallEntry } from "./codemode-call.ts";
const resultSchema = Type.Object({output:Type.String(),exitCode:Type.Union([Type.Integer(),Type.Null()]),aborted:Type.Optional(Type.Boolean()),timedOut:Type.Optional(Type.Boolean()),truncated:Type.Optional(Type.Boolean())});
const detailsSchema = Type.Object({fullOutputPath:Type.String(),exitCode:Type.Union([Type.Integer(),Type.Null()]),aborted:Type.Optional(Type.Boolean()),timedOut:Type.Optional(Type.Boolean())});
const commandSchema = Type.Object({command:Type.String()});
type Projection = {texts:{index:number;text:string}[];raw:string;reductions:number;originalBytes:number;reducedBytes:number;applied:boolean};
function project(result:ToolExecutionResult,saved:Projection|null) {
  if (!saved) return result;
  const details = isJsonObject(result.details) ? result.details : {};
  return {...result,output:(result.output ?? []).map((block,index) => {const text = saved.applied ? saved.texts.find(item => item.index === index)?.text : undefined;return block.type === "text" && text !== undefined ? {...block,text} : block;}),details:{...details,optimizerRawOutput:saved.raw,optimizerReduction:{reductions:saved.reductions,originalBytes:saved.originalBytes,reducedBytes:saved.reducedBytes,applied:saved.applied}}};
}
export const optimizerRawOutputSchema = Type.Object({optimizerRawOutput:Type.String()});
/** The projection is committed with the result once; request replay never recompresses history. */
export function createOptimizerOutputExtension(policyFor:(id:ConversationId) => Promise<Policy|null>) {
  return defineExtension({name:"kintsugi.optimizer-output",hooks:[hook(ToolTask,{
    async afterTool(call,result,api,context) {
      if (call.parent || !["bash","codemode"].includes(call.name) || result.diagnostics?.some(d => ["aborted","interrupted","timeout","timed_out","uncertain"].includes(d.code ?? ""))) return result;
      const saved = await api.memo<Projection|null>("optimizer-output-v1",context);
      if (saved !== undefined) return project(result,saved);
      const policy = await policyFor(api.conversationId);
      if (!policy || !observing(policy) || !policy.reduceOutputs) {await api.memo("optimizer-output-v1",null,context);return result;}
      const candidates = call.name === "bash" && Value.Check(commandSchema,call.arguments) && Value.Check(resultSchema,result.structuredOutput) && Value.Check(detailsSchema,result.details)
        ? [{command:call.arguments.command,...result.structuredOutput,fullOutputPath:result.details.fullOutputPath}]
        : call.name === "codemode" ? await nestedOutputs(api,context) : [];
      let reductions = 0, originalBytes = 0, reducedBytes = 0;
      const output = (result.output ?? []).map(block => {
        if (block.type !== "text") return block;
        let text = block.text;
        for (const candidate of candidates) {
          const reduction = reduceToolOutput(candidate);if (!reduction) continue;
          // Direct bash text can carry an authoritative exit trailer. Code-mode text must be an exact emitted value.
          if (text === candidate.output || call.name === "bash" && text.startsWith(candidate.output+"\n\nCommand exited with code ")) {
            text = reduction.text+text.slice(candidate.output.length);
          } else {
            let json:unknown;try {json = JSON.parse(text);} catch {continue;}
            if (!Value.Check(resultSchema,json) || json.output !== candidate.output || json.exitCode !== candidate.exitCode || json.aborted || json.timedOut) continue;
            text = JSON.stringify({...json,output:reduction.text,fullOutputPath:candidate.fullOutputPath});
          }
          reductions++;originalBytes += reduction.originalBytes;reducedBytes += reduction.reducedBytes;break;
        }
        return {...block,text};
      });
      if (!reductions) {await api.memo("optimizer-output-v1",null,context);return result;}
      const projection = await api.memo<Projection|null>("optimizer-output-v1",{texts:output.flatMap((block,index) => block.type === "text" ? [{index,text:block.text}] : []),raw:(result.output ?? []).flatMap(block => block.type === "text" ? [block.text] : []).join("\n"),reductions,originalBytes,reducedBytes,applied:policy.mode === "active"},context);
      return project(result,projection);
    },
  })]});
}
async function nestedOutputs(api:HookApi,context:Context) {
  // Bounded to this script's recent ledger; no guessing a command from model-emitted prose.
  const entries = [...(await api.entries({order:"descending"},256,undefined,context)).items].reverse();
  const starts = new Map<string,string>(), candidates:Parameters<typeof reduceToolOutput>[0][] = [];
  for (const entry of entries) if (entry.byTaskId === api.taskId && codemodeCallEntry.is(entry)) {
    const data = entry.data;
    if (data.phase === "start" && data.name === "bash" && Value.Check(commandSchema,data.arguments)) starts.set(data.key,data.arguments.command);
    if (data.phase === "end" && data.output && !data.cancelled && starts.has(data.key) && Value.Check(detailsSchema,data.details)) candidates.push({command:starts.get(data.key)!,output:data.output,...data.details});
  }
  return candidates;
}
