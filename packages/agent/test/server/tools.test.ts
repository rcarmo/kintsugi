import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { createKintsugiControlTools, executeDeleteCurrentWorkspace, registerWorkspacePresenter } from "../../src/server/tools.ts";

describe("workspace agent tools", () => {
  test("only the built-in agent's present tool teaches embed URLs", () => {
    const unregister = registerWorkspacePresenter("test-browser", () => ({
      kind: "test-browser",
      description: "Present a test browser.",
      parameters: { url: Type.String() },
      execute: async () => ({ content: [{ type: "text" as const, text: "presented" }], details: {} }),
    }));

    try {
      expect(createKintsugiControlTools("abc", { embeds: true }).find((tool) => tool.name === "present")?.description).toContain("artifact-preview:");
      expect(createKintsugiControlTools("abc").find((tool) => tool.name === "present")?.description).not.toContain("artifact-preview:");
    } finally {
      unregister();
    }
  });

  test("present tool uses a top-level object schema accepted by Moonshot", () => {
    const unregisterBrowser = registerWorkspacePresenter("test-browser", () => ({
      kind: "test-browser",
      description: "Present a test browser.",
      parameters: { url: Type.String() },
      execute: async () => ({ content: [{ type: "text" as const, text: "presented" }], details: {} }),
    }));
    const unregisterTerminal = registerWorkspacePresenter("test-terminal", () => ({
      kind: "test-terminal",
      description: "Present a test terminal.",
      parameters: { session: Type.String() },
      execute: async () => ({ content: [{ type: "text" as const, text: "presented" }], details: {} }),
    }));

    try {
      const present = createKintsugiControlTools("abc", { embeds: true }).find((tool) => tool.name === "present");
      expect(present?.parameters.type).toBe("object");
      expect(present?.parameters.anyOf).toBeUndefined();
      expect(present?.parameters.required).toEqual(["kind"]);
      expect(present?.parameters.properties.kind.enum).toEqual(["test-browser", "test-terminal"]);
      expect(present?.parameters.properties.url.type).toBe("string");
      expect(present?.parameters.properties.session.type).toBe("string");
    } finally {
      unregisterBrowser();
      unregisterTerminal();
    }
  });

  test("delete current workspace tool reports blocked safety checks", async () => {
    const result = await executeDeleteCurrentWorkspace("abc", async (force) => ({
      deleted: false,
      blocked: !force,
      details: { workspaceId: "abc", issues: [{ repo: "demo", uncommittedPaths: ["wip.txt"] }] },
    }), false);

    const content = result.content[0];
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("expected text content");
    expect(content.text).toContain("was not deleted");
    expect(result.details).toMatchObject({ workspaceId: "abc", deleted: false, blocked: true });
  });
});
