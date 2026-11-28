import { expect, test } from "bun:test";
import { delegationPrompt } from "../../src/server/prompt.ts";
import upstream from "../../src/server/codex-prompts.json";

test("Astra medium resolves catalogue roles and explicit delegation for both root and Subagent", () => {
  const root = delegationPrompt("gpt-6-astra", "medium", "root").join("\n");
  const child = delegationPrompt("gpt-6-astra", "medium", "subagent").join("\n");
  expect(root).toContain("You are `/root`, the primary agent");
  expect(child).not.toContain("You are `/root`, the primary agent");
  expect(child).toContain("that content is immediately delivered back to your parent agent");
  for (const prompt of [root, child]) {
    expect(prompt).toContain("Always put proper spaces between words and/or numbers.");
    expect(prompt).toContain(upstream.defaults.explicit.replaceAll("sub-agent", "subagent"));
    expect(prompt).not.toContain("functions.exec");
    expect(prompt).not.toContain("analysis channel");
    expect(prompt).toContain("6 subagents");
    expect(prompt).not.toContain("sub-agent");
    expect(prompt).toContain("provider/modelId");
    expect(prompt).toContain("keeps both settings for follow-ups");
  }
});

test("Ultra selects proactive policy, never xhigh or medium", () => {
  for (const role of ["root", "subagent"] as const) {
    expect(delegationPrompt("gpt-6-astra", "ultra", role)).toContain(`<multi_agent_mode>\n${upstream.defaults.proactive.replaceAll("sub-agent", "subagent")}\n</multi_agent_mode>`);
    for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
      expect(delegationPrompt("gpt-6-astra", effort, role).join("\n")).toContain(upstream.defaults.explicit.replaceAll("sub-agent", "subagent"));
    }
  }
});

test("models without role text or a recognized GPT identifier use bundled Codex V2 guidance", () => {
  for (const model of ["gpt-5.6-sol", "claude-opus-4-6", "custom-astra", undefined]) {
    const prompt = delegationPrompt(model, "medium", "root").join("\n");
    expect(prompt).toContain("You are `/root`, the primary agent");
    expect(prompt).not.toContain("Always put proper spaces between words and/or numbers.");
    expect(prompt).toContain(upstream.defaults.explicit.replaceAll("sub-agent", "subagent"));
  }
});
