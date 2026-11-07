import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PreviewInlinePolicy } from "../src/ingress/preview-inline-policy.ts";
import { previewContentPolicy } from "../src/preview-url.ts";

const hash = (text: string) => "'sha256-" + createHash("sha256").update(text).digest("base64") + "'";
test("only already-authorized inline hashes gain their translated equivalents", () => {
  const policy = new PreviewInlinePolicy();
  policy.record("script", "authorized()", "translated()");
  policy.record("script", "unapproved()", "alsoUnapproved()");
  const result = policy.rewrite("script-src " + hash("authorized()") + "; style-src " + hash("authorized()") + "; form-action 'none'");
  expect(result).toContain("script-src " + hash("authorized()") + " " + hash("translated()"));
  expect(result).toContain("style-src " + hash("authorized()") + ";");
  expect(result).not.toContain(hash("alsoUnapproved()"));
  expect(result).toContain("form-action 'none'");
});

test("worker adaptation does not newly authorize data/blob document scripts or override an explicit worker prohibition", () => {
  const result = previewContentPolicy("script-src 'self'; worker-src 'none'", { publicOrigin: "https://dynamic.example", root: "/~preview/capability/", app: "port-3152", upstream: "http://localhost:3152/" }, "runtime");
  const elements = result.split(";").find(part => part.trim().startsWith("script-src-elem"))!;
  expect(elements).not.toContain("data:");
  expect(elements).not.toContain("blob:");
  expect(result).toContain("worker-src 'none'");
});
