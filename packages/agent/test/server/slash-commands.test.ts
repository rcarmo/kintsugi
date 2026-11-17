import { describe, expect, test } from "bun:test";
import { slashCommands } from "../../src/server/slash-commands.ts";

describe("slash command metadata", () => {
  test("offers tree navigation alongside templates and skills without duplicate commands", () => {
    const templates = Array.from({ length: 15 }, (_, index) => ({ name: `prompt-${index}`, trigger: `/prompt-${index}`, description: `Prompt ${index}`, prompt: `Do ${index}`, composerButton: index === 2, shortcut: index === 2 ? "p" : undefined }));
    const commands = slashCommands(templates, [{ name: "careful-review", description: "Review changes carefully" }]);
    expect(commands.find(command => command.trigger === "/tree")).toMatchObject({ kind: "builtin", source: "kintsugi", description: "Browse session history and continue on a new branch." });
    expect(commands.find(command => command.trigger === "/prompt-14")).toMatchObject({ kind: "prompt-template", prompt: "Do 14" });
    expect(commands.find(command => command.trigger === "/skill:careful-review")).toMatchObject({ kind: "skill", description: "Review changes carefully" });
    expect(new Set(commands.map(command => command.trigger)).size).toBe(commands.length);
    expect(slashCommands([], [], "cli").some(command => command.trigger === "/tree")).toBe(false);
  });
});

test("the reserved native tree command cannot be duplicated by additional command metadata",()=>{
  const commands=slashCommands([],[],"builtin",[{kind:"builtin",source:"kintsugi",name:"tree",trigger:"/tree",description:"Custom"}]);
  expect(commands.filter(command=>command.trigger==="/tree")).toHaveLength(1);
  expect(commands.find(command=>command.trigger==="/tree")!.description).not.toBe("Custom");
});

test("external CLI tree commands remain available without the native tree reservation",()=>{
  const commands=slashCommands([],[],"cli",[{kind:"builtin",source:"kintsugi",name:"tree",trigger:"/tree",description:"External tree"}]);
  expect(commands.filter(command=>command.trigger==="/tree")).toHaveLength(1);
  expect(commands.find(command=>command.trigger==="/tree")!.description).toBe("External tree");
});
