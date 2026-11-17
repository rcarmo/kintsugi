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
const search:AgentToolPresentation = {
  displayName:"Search saved outputs",
  summary(tool) {
    const args = isJsonObject(tool.args) ? tool.args : undefined;
    if (!args || !Value.Check(Type.String({maxLength:512}),args.query)) return "";
    const query = Array.from(args.query.replace(/\s+/g," ").trim());
    return query.length ? `“${query.slice(0,96).join("")}${query.length > 96 ? "…" : ""}”` : "";
  },
  detail:() => undefined,
};
export const toolOutputPresentations:ReadonlyMap<string,AgentToolPresentation> = new Map([
  ["read_tool_output",read],
  ["search_tool_output",search],
]);
