export type SlashCommandSource = "kintsugi" | "codex" | "claude";

export interface BuiltinSlashCommand {
  source: SlashCommandSource;
  kind: "builtin";
  name: string;
  trigger: string;
  description: string;
  argumentHint?: string;
  preserveArguments?: boolean;
}

export const builtinSlashCommands: readonly BuiltinSlashCommand[] = [{
  kind:"builtin",source:"kintsugi",name:"tokeneconomizer",trigger:"/tokeneconomizer",description:"Inspect or control this Agent’s token optimizer without a model call.",argumentHint:"[status|help|settings|on|watch|off|restore]",preserveArguments:true,
}, {
  kind: "builtin",
  source: "kintsugi",
  name: "compact",
  trigger: "/compact",
  description: "Compact the conversation context, optionally with custom instructions.",
  argumentHint: "[instructions]",
  preserveArguments: true,
}, {
  kind: "builtin",
  source: "kintsugi",
  name: "name",
  trigger: "/name",
  description: "Rename this Agent, using AI when no name is provided.",
  argumentHint: "[agent-name]",
  preserveArguments: true,
}, {
  kind: "builtin",
  source: "kintsugi",
  name: "new",
  trigger: "/new",
  description: "Start a fresh Agent session.",
}, {
  kind: "builtin",
  source: "kintsugi",
  name: "park",
  trigger: "/park",
  description: "Park this workspace.",
}];


export function parseCompactCommand(text: string): { customInstructions?: string } | undefined {
  const match = text.trim().match(/^\/compact(?:\s+([\s\S]+))?$/);
  if (!match) return undefined;
  const customInstructions = match[1]?.trim();
  return customInstructions ? { customInstructions } : {};
}

export function parseAgentNameCommand(text: string): { title?: string } | undefined {
  const match = text.trim().match(/^\/name(?:\s+([\s\S]+))?$/);
  if (!match) return undefined;
  const title = match[1]?.trim();
  return title ? { title } : {};
}
