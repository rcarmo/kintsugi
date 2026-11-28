import { maxConcurrentSubagents } from "./native-state.ts";
import { codexModelId } from "./codex-model.ts";
import upstream from "./codex-prompts.json";

const models: Record<string, ModelDelegationText> = upstream.models;

interface ModelDelegationText {
  role?: { root: string | null; subagent: string | null } | null;
  mode?: { hint_text?: string | null; explicit?: string | null; proactive?: string | null } | null;
}

/** Codex's V2 role/mode resolution, with Kintsugi transport and capacity facts kept local.
 * Provider-specific ids resolve to catalogue models; other models use Codex's V2 defaults.
 * This deliberately does not replace Kintsugi's base prompt with the Codex CLI prompt. */
export function delegationPrompt(modelId: string | undefined, thinkingLevel: string, role: "root" | "subagent"): string[] {
  const canonicalId = codexModelId(modelId);
  const model = canonicalId ? models[canonicalId] : undefined;
  // Keep the imported Codex text intact; use app vocabulary at the prompt boundary.
  const roleText = (model?.role?.[role] ?? upstream.defaults[role])?.replaceAll("sub-agent", "subagent");
  const mode = model?.mode;
  const modeText = (mode?.hint_text ?? (thinkingLevel === "ultra"
    ? mode?.proactive ?? upstream.defaults.proactive
    : mode?.explicit ?? upstream.defaults.explicit)).replaceAll("sub-agent", "subagent");
  return [
    ...(roleText ? [`<multi_agent_role>\n${roleText.replace("You will receive messages in the analysis channel in the form:", "You will receive agent messages in the form:")}\n${kintsugiCollaborationGuidance}\n\n${upstream.defaults.wait}\n</multi_agent_role>`] : []),
    ...(modeText ? [`<multi_agent_mode>\n${modeText}\n</multi_agent_mode>`] : []),
  ];
}

// Codex's shared guidance assumes functions.exec and a six-slot limit including root.
// Kintsugi exposes direct collaboration tools and permits six running subagents plus root.
const kintsugiCollaborationGuidance = `Call collaboration tools directly using the names in their tool definitions.

All agents share the same container, filesystem, and current working directory. Edits made by one agent are immediately visible to all other agents; coordinate edits.

Up to ${maxConcurrentSubagents} subagents can run concurrently in a delegation tree, in addition to the root agent. Each spawn_agent call can select an enabled, available model using provider/modelId and a supported thinkingLevel. Omit either setting to inherit it from the parent; inherited thinking is clamped when the model changes. The subagent keeps both settings for follow-ups.`;
