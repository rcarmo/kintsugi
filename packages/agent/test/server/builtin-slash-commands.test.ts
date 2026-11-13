import { describe, expect, test } from "bun:test";
import { parseCompactCommand, parseAgentNameCommand } from "../../src/server/builtin-slash-commands.ts";
import { expandSlashCommandText } from "../../src/server/slash-command-input.ts";
import { slashCommands } from "../../src/server/slash-commands.ts";

const template = { name: "land", trigger: "/land", description: "Land", prompt: "Push to ${1:-main}" };

describe("Slash commands", () => {
  test("distinguishes built-in actions, Prompt templates, and Skills", () => {
    const commands = slashCommands([template], [{ name: "review", description: "Review changes" }]);
    expect(commands.find((command) => command.trigger === "/new")?.kind).toBe("builtin");
    expect(commands.find((command) => command.trigger === "/compact")?.kind).toBe("builtin");
    expect(commands.find((command) => command.trigger === "/tokeneconomizer")?.kind).toBe("builtin");
    expect(commands.find((command) => command.trigger === "/land")?.kind).toBe("prompt-template");
    expect(commands.find((command) => command.trigger === "/skill:review")?.kind).toBe("skill");
    expect(commands.find((command) => command.trigger === "/new")).not.toHaveProperty("prompt");
  });

  test("keeps native CLI commands out of the app catalog", () => {
    const triggers = slashCommands([template], [], "cli").map((command) => command.trigger);
    expect(triggers).toEqual(["/land", "/name", "/new", "/park"]);
  });

  test("only Prompt templates expand into prompt text", () => {
    expect(expandSlashCommandText("/land release", [template])).toBe("Push to release");
    expect(expandSlashCommandText(" /compact  Keep test commands. ", [template])).toBe("/compact  Keep test commands.");
    expect(expandSlashCommandText(" /tokeneconomizer restore bash read ", [template])).toBe("/tokeneconomizer restore bash read");
    expect(expandSlashCommandText(" /name my-custom-name ", [template])).toBe("/name my-custom-name");
    expect(expandSlashCommandText(" /new ignored arguments ", [template])).toBe("/new");
    expect(expandSlashCommandText(" /park ignored arguments ", [template])).toBe("/park");
    expect(expandSlashCommandText("/skill:review details", [template])).toBe("/skill:review details");
    expect(expandSlashCommandText("ordinary message", [template])).toBe("ordinary message");
  });

  test("parses compaction commands with optional custom instructions", () => {
    expect(parseCompactCommand("/compact")).toEqual({});
    expect(parseCompactCommand(" /compact   Preserve exact test commands. ")).toEqual({ customInstructions: "Preserve exact test commands." });
    expect(parseCompactCommand("/compactness")).toBeUndefined();
  });

  test("parses AI and manual Agent name commands", () => {
    expect(parseAgentNameCommand("/name")).toEqual({});
    expect(parseAgentNameCommand(" /name   my-custom-name ")).toEqual({ title: "my-custom-name" });
    expect(parseAgentNameCommand("/names")).toBeUndefined();
  });

});
