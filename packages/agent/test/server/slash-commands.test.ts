import { describe, expect, test } from "bun:test";
import { renderSlashCommandCatalog } from "../../src/server/slash-commands.ts";

const skill = {
  name: "careful-review",
  description: "Review changes carefully",
};

describe("slash commands", () => {
  test("renders the complete catalog of built-in actions, templates, and skills", () => {
    const templates = Array.from({ length: 15 }, (_, index) => ({
      name: `prompt-${index}`,
      trigger: `/prompt-${index}`,
      description: `Prompt ${index}`,
      prompt: `Do ${index}`,
      composerButton: index === 2,
      shortcut: index === 2 ? "p" : undefined,
    }));

    const html = renderSlashCommandCatalog(templates, [skill]);

    expect((html.match(/data-command-trigger=/g) ?? []).length).toBe(23);
    expect(html).toContain('data-command-trigger="/tree" data-command-action="notice" data-command-message="/tree feature is coming soon!"');
    expect(html).toContain("/tree — Coming soon.");
    expect(html).toContain('data-completion-kind="prompt-template"');
    expect(html).toContain('data-command-trigger="/prompt-14"');
    expect(html).toContain('data-completion-kind="skill"');
    expect(html).toContain('data-command-trigger="/skill:careful-review"');
    expect(html).toContain("Review changes carefully");
    expect(html).toContain('role="group" aria-label="Prompt template buttons"');
    expect(html).toContain('data-completion-kind="prompt-template" data-command-trigger="/prompt-2" data-prompt-template-shortcut="p"');
    expect(html.match(/data-completion-kind="prompt-template-button"/g)).toHaveLength(1);
  });
});
