import { contentRowHtml } from "@kintsugi/design-system/content-row";
import { autocompleteHtml } from "@kintsugi/design-system/autocomplete";
import { builtinAgentIconHtml } from "@kintsugi/design-system/icons";
import { buttonHtml } from "@kintsugi/design-system/button";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { escapeHtml, providerBrandIconHtml } from "@kintsugi/shared";
import { builtinSlashCommands, type BuiltinSlashCommand, type SlashCommandSource } from "./builtin-slash-commands.ts";
import type { PromptTemplate } from "./prompt-templates.ts";

type SlashCommand = BuiltinSlashCommand | {
  kind: "prompt-template";
  source: SlashCommandSource;
  trigger: string;
  description: string;
  argumentHint?: string;
  prompt: string;
  shortcut?: string;
} | {
  kind: "skill";
  source: SlashCommandSource;
  trigger: string;
  description: string;
  argumentHint?: never;
};

export function slashCommands(templates: readonly PromptTemplate[], skills: readonly Pick<Skill, "name" | "description">[], mode: "builtin" | "cli" = "builtin", additionalCommands: readonly BuiltinSlashCommand[] = []): SlashCommand[] {
  const commands: SlashCommand[] = [
    ...builtinSlashCommands.filter((command) => (mode === "builtin" || !["/compact","/tokeneconomizer"].includes(command.trigger)) && !additionalCommands.some(extra => extra.trigger === command.trigger)),
    ...additionalCommands,
    ...templates.filter((template) => template.trigger !== "/tree" && !additionalCommands.some(command => command.trigger === template.trigger)).map((template) => ({
      kind: "prompt-template" as const,
      source: "kintsugi" as const,
      trigger: template.trigger,
      description: template.description,
      argumentHint: template.argumentHint,
      prompt: template.prompt,
      shortcut: template.shortcut,
    })),
  ];
  return [
    ...(mode === "builtin" ? [{ kind: "builtin" as const, source: "kintsugi" as const, name: "tree", trigger: "/tree", description: "Coming soon." }] : []),
    ...commands.sort((left, right) => left.trigger.localeCompare(right.trigger)),
    ...skills.map((skill) => ({ kind: "skill" as const, source: "kintsugi" as const, trigger: `/skill:${skill.name}`, description: skill.description })),
  ];
}

export function renderSlashCommandCatalog(templates: readonly PromptTemplate[], skills: readonly Pick<Skill, "name" | "description">[], mode: "builtin" | "cli" = "builtin", additionalCommands: readonly BuiltinSlashCommand[] = []): string {
  const commands = slashCommands(templates, skills, mode, additionalCommands);
  const promptTemplateButtons = templates.filter((template) => template.composerButton && !additionalCommands.some(command => command.trigger === template.trigger)).map((template) => {
    const shortcut = template.shortcut;
    const shortcutData = shortcut ? ` data-prompt-template-shortcut="${escapeHtml(shortcut)}"` : "";
    return buttonHtml({
      type: "button",
      variant: "secondary",
      content: { kind: "caption", caption: template.trigger },
      attributesHtml: `data-agent-completion-option data-agent-prompt-template-button data-completion-kind="prompt-template-button" data-command-trigger="${escapeHtml(template.trigger)}"${shortcutData}`,
    });
  }).join("");
  const promptTemplateButtonCatalog = promptTemplateButtons ? `<div class="agent-prompt-template-buttons" data-popular-button="touch" role="group" aria-label="Prompt template buttons">${promptTemplateButtons}</div>` : "";
  const slashCommandCatalog = autocompleteHtml({ kind: "results", label: "Slash commands", contentHtml: commands.map((command, index) => {
    // Keep existing previews for built-in actions without modelling them as Prompt templates.
    const preview = command.kind === "prompt-template" ? command.prompt : command.kind === "builtin" && command.trigger !== "/tree" ? command.trigger : undefined;
    const hasPreview = preview !== undefined;
    const sourceLabel = command.source === "codex" ? "Codex" : command.source === "claude" ? "Claude Code" : "Kintsugi";
    const sourceIcon = command.source === "codex" ? providerBrandIconHtml("openai", "Codex") : command.source === "claude" ? providerBrandIconHtml("anthropic", "Claude Code") : builtinAgentIconHtml;
    return contentRowHtml({
      width: "fill",
      kind: "compact",
      leadingHtml: `<span role="img" aria-label="${sourceLabel}" title="${sourceLabel}"><span class="agent-slash-command-source-icon" aria-hidden="true">${sourceIcon}</span></span>`,
      label: { kind: "text", text: `${command.trigger}${command.argumentHint ? ` ${command.argumentHint}` : ""} — ${command.description}` },
      trailingHtml: preview === undefined ? "" : `<template data-kintsugi-fullscreen-target="content"><pre class="agent-slash-command-preview">${escapeHtml(preview)}</pre></template>`,
      element: {
        tag: "button",

        attributesHtml: `type="button" role="option" aria-selected="${index === 0 ? "true" : "false"}" data-completion-kind="${command.kind}" data-command-trigger="${escapeHtml(command.trigger)}"${command.kind === "prompt-template" && command.shortcut ? ` data-prompt-template-shortcut="${escapeHtml(command.shortcut)}"` : ""}${command.trigger === "/tree" ? ` data-command-action="notice" data-command-message="/tree feature is coming soon!"` : ""}${hasPreview ? ` data-controller="kintsugi-fullscreen" data-kintsugi-fullscreen-mode-value="template" data-kintsugi-fullscreen-title-value="${escapeHtml(command.trigger)}"` : ""}`,
      },
    });
  }).join("") });
  return `${promptTemplateButtonCatalog}${slashCommandCatalog}`;
}
