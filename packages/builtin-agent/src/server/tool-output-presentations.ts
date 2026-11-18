import type {AgentToolPresentation} from "@kintsugi/agent/server";
import {isJsonObject} from "@kintsugi/core";
import {Type} from "typebox";
import {Value} from "typebox/value";

const lineIndex = Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER});
const lineCount = Type.Integer({minimum:1,maximum:500});
const charOffset = Type.Integer({minimum:0,maximum:Number.MAX_SAFE_INTEGER-1});
const number = (value:number) => value.toLocaleString("en-GB");

/** Retained/streaming arguments are display data: incomplete values get an action-only label. */
const read:AgentToolPresentation = {
  displayName:"Read saved output",
  summary(tool) {
    const args = isJsonObject(tool.args) ? tool.args : undefined;
    if (!args || !Value.Check(Type.String({minLength:1}),args.id)) return "";
    if (args.offset !== undefined) return Value.Check(charOffset,args.offset) ? `from character ${number(args.offset+1)}` : "";
    if (args.lines !== undefined && !Value.Check(lineCount,args.lines) || args.start !== undefined && !Value.Check(lineIndex,args.start) || args.fromEnd !== undefined && !Value.Check(Type.Boolean(),args.fromEnd)) return "";
    const count = Value.Check(lineCount,args.lines) ? args.lines : 200;
    if (args.fromEnd === true) return `last ${number(count)} ${count === 1 ? "line" : "lines"}`;
    const start = Value.Check(lineIndex,args.start) ? args.start : 1;
    if (count === 1) return `line ${number(start)}`;
    return start === 1 ? `first ${number(count)} lines` : `lines ${number(start)}–${number(Math.min(Number.MAX_SAFE_INTEGER,start+count-1))}`;
  },
  detail:() => undefined,
};
function search(displayName:string,key:"query"|"pattern",mode?:string):AgentToolPresentation {
  return {displayName,
    summary(tool) {
      const args = isJsonObject(tool.args) ? tool.args : undefined;
      const value = args?.[key];
      if (!Value.Check(Type.String({maxLength:512}),value)) return "";
      const query = value.replace(/\s+/g," ").trim();
      if (!query) return "";
      const excerpt = query.length > 96 ? `${query.slice(0,96).replace(/[\uD800-\uDBFF]$/u,"")}…` : query;
      const label = `“${excerpt}”`;
      return mode && args?.fixed !== true ? `${label} · ${mode}` : label;
    },
    detail:() => undefined,
  };
}

const recallRetrieve:AgentToolPresentation = {
  displayName:"Read saved MCP result",
  summary(tool) {
    const args = isJsonObject(tool.args) ? tool.args : undefined;
    if (args?.mode === "peek") return "Matching excerpt";
    if (args?.mode === "full") return "Original result";
    return "Overview";
  },
  detail:() => undefined,
};

const recallManage:AgentToolPresentation = {
  displayName:"Manage saved MCP results",
  summary(tool) {
    const args = isJsonObject(tool.args) ? tool.args : undefined;
    switch (args?.action) {
      case "list": return "List saved results";
      case "stats": return "Retention statistics";
      case "pin": return args.pinned === false ? "Unpin saved result" : "Pin saved result";
      case "forget": return args.all === true ? "Forget all saved results" : "Forget saved result";
      default: return "";
    }
  },
  detail:() => undefined,
};

export const toolOutputPresentations:ReadonlyMap<string,AgentToolPresentation> = new Map([
  ["grep_history",search("Search timeline","pattern","Regex")],
  ["search_history",search("Search history","query")],
  ["read_tool_output",read],
  ["search_tool_output",search("Search saved outputs","query")],
  ["mcp_recall_search",search("Search saved MCP results","query")],
  ["mcp_recall_retrieve",recallRetrieve],
  ["mcp_recall_manage",recallManage],
]);
