import { expect, test } from "bun:test";
import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import { assertOneShotJson } from "../packages/codemode/src/server/one-shot-limits.ts";
import { loadPromptTemplatesFromRoot } from "../packages/agent/src/server/prompt-templates.ts";

interface AgentCall { label: string; prompt: string; schema: TSchema; tools: string[] }
const source = await Bun.file(new URL("../.kintsugi/scripts/review.js", import.meta.url)).text();
// SAFETY: Trusted repository script evaluated as an async codemode body; tests supply its only tool and assert the result contract.
const run = new Function("input", "tools", `return (async () => {\n${source}\n})();`) as (
  input: JsonValue | undefined, tools: { agent: (args: AgentCall) => Promise<JsonValue> },
) => Promise<JsonValue>;
const answer = { blocker: [], major: [], minor: [], serializedState: null, upgradeRisk: null, fixChecks: [] };

test("an explicit review round calls one constrained one-shot agent and returns its structured answer", async () => {
  const calls: AgentCall[] = [];
  const result = await run({ scope: "git diff -- packages/core" }, { agent: async args => { calls.push(args); return answer; } });
  expect(result).toBe(answer);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.label).toBe("review");
  expect(calls[0]!.tools).toEqual(["read", "bash"]);
  expect(calls[0]!.prompt).toContain("git diff -- packages/core");
  expect(calls[0]!.prompt).toContain("Do not change the reviewed files");
  expect(calls[0]!.prompt).toContain("stage, commit, push, stash, reset");
  expect(calls[0]!.prompt).toContain("temporary files outside the checkout");
  // SAFETY: The script constructs a JSON-only schema; this check rejects unsupported values/features before compilation.
  assertOneShotJson(calls[0]!.schema as JsonValue, true);
  const validator = Compile(calls[0]!.schema);
  expect(validator.Check(answer)).toBe(true);
  expect(validator.Check({ ...answer, upgradeRisk: undefined })).toBe(false);
  expect(validator.Check({ ...answer, automaticCommit: true })).toBe(false);
  expect(validator.Check({ ...answer, fixChecks: [{ commit: "abc", verdict: "fixed", reproStillHits: false, note: "" }] })).toBe(false);
});

test("later rounds carry decisions and existing fixes without executing them", async () => {
  let request: AgentCall | undefined;
  await run({ scope: "Existing fix commit", pushbacks: ["Minor: retained for compatibility"], fixes: [{ commit: "abc123", finding: "Major: failed save; rerun the existing fixture" }] }, {
    agent: async args => { request = args; return answer; },
  });
  expect(request!.prompt).toContain("Minor: retained for compatibility");
  expect(request!.prompt).toContain("abc123: Major: failed save");
  expect(request!.prompt).toContain("cannot be resolved");
  expect(request!.tools).not.toContain("edit");
  expect(request!.tools).not.toContain("write");
});

test("invalid review inputs fail before starting inference", async () => {
  let calls = 0;
  for (const input of [undefined, {}, { scope: " " }, { scope: "diff", pushbacks: "no" }, { scope: "diff", fixes: [{ commit: "", finding: "bug" }] }]) {
    await expect(run(input, { agent: async () => { calls++; return answer; } })).rejects.toThrow();
  }
  expect(calls).toBe(0);
});

test("review failure propagates instead of starting another round", async () => {
  let calls = 0;
  const failure = new Error("review failed");
  await expect(run({ scope: "diff" }, { agent: async () => { calls++; throw failure; } })).rejects.toBe(failure);
  expect(calls).toBe(1);
});

test("loading the review template keeps it a plain prompt and starts no script", async () => {
  const templates = await loadPromptTemplatesFromRoot(new URL("..", import.meta.url).pathname);
  const review = templates.find(template => template.trigger === "/review");
  expect(review).toBeDefined();
  expect(review!.codemode).not.toBe(true);
  expect(review!.prompt).toContain(".kintsugi/scripts/review.js");
});
