import { describe, expect, test } from "bun:test";
import { previewInlineAllowed, previewPolicyDirectives } from "../src/preview-policy.ts";

const source = "document.body.dataset.value = location.pathname;";
const hash = (algorithm: "sha256" | "sha384" | "sha512", value = source) => `'${algorithm}-${new Bun.CryptoHasher(algorithm).update(value).digest("base64")}'`;

describe("generated inline source authorization", () => {
  test("uses the first duplicate directive and fallback hierarchy", () => {
    expect(previewPolicyDirectives("SCRIPT-SRC 'none'; script-src 'unsafe-inline'").get("script-src")).toEqual(["'none'"]);
    expect(previewInlineAllowed(["default-src 'none'; script-src 'unsafe-inline'; script-src-elem 'none'"], "script", source)).toBe(false);
    expect(previewInlineAllowed(["default-src 'none'; script-src 'unsafe-inline'; script-src-attr 'none'"], "script", source, "", true)).toBe(false);
    expect(previewInlineAllowed(["default-src 'unsafe-inline'; script-src 'none'"], "style", source)).toBe(true);
  });
  test("preserves only effective unsafe-inline authorization", () => {
    expect(previewInlineAllowed([], "script", source)).toBe(true);
    expect(previewInlineAllowed(["script-src 'unsafe-inline'"], "script", source)).toBe(true);
    expect(previewInlineAllowed([`script-src 'unsafe-inline' ${hash("sha256", "other")}`], "script", source)).toBe(false);
    expect(previewInlineAllowed(["script-src 'unsafe-inline' 'nonce-other'"], "script", source)).toBe(false);
    expect(previewInlineAllowed(["script-src 'unsafe-inline' 'strict-dynamic'"], "script", source)).toBe(false);
    expect(previewInlineAllowed(["style-src 'unsafe-inline' 'strict-dynamic'"], "style", source)).toBe(true);
  });
  for (const algorithm of ["sha256", "sha384", "sha512"] as const) test(`${algorithm} authorizes the original, not a changed source`, () => {
    const policy = `script-src ${hash(algorithm)}`;
    expect(previewInlineAllowed([policy], "script", source)).toBe(true);
    expect(previewInlineAllowed([policy], "script", source + " ")).toBe(false);
    expect(previewInlineAllowed([policy], "script", source, "", true)).toBe(false);
    expect(previewInlineAllowed([`${policy} 'unsafe-hashes'`], "script", source, "", true)).toBe(true);
    expect(previewInlineAllowed([policy.replace(/=+'/g, "'")], "script", source)).toBe(true);
  });
  test("normalizes HTML parser line endings before comparing hashes", () => {
    expect(previewInlineAllowed([`script-src ${hash("sha256", "one\ntwo\nthree")}`], "script", "one\r\ntwo\rthree")).toBe(true);
  });
  test("nonces apply to elements, not attributes, and every policy must allow", () => {
    expect(previewInlineAllowed(["script-src 'nonce-known'"], "script", source, "known")).toBe(true);
    expect(previewInlineAllowed(["script-src 'nonce-known'"], "script", source, "unknown")).toBe(false);
    expect(previewInlineAllowed(["script-src 'nonce-known'"], "script", source, "known", true)).toBe(false);
    expect(previewInlineAllowed(["script-src 'nonce-known'", "script-src 'none'"], "script", source, "known")).toBe(false);
    expect(previewInlineAllowed(["script-src 'unsafe-inline', script-src 'none'"], "script", source)).toBe(false);
    expect(previewInlineAllowed([`script-src 'nonce-known', script-src ${hash("sha256")}`], "script", source, "known")).toBe(true);
  });
});
