import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";

export type PreviewInlineKind = "script" | "style";

/** A generated HTTPS resource must not bypass a blob: script denial. */
export function previewBlobAllowed(policies: readonly string[], nonce = ""): boolean {
  return policies.flatMap(policy => policy.split(",")).every(policy => {
    const directives = previewPolicyDirectives(policy);
    const values = directives.get("script-src-elem") ?? directives.get("script-src") ?? directives.get("default-src");
    return !values || values.includes("blob:") || Boolean(nonce && values.includes(`'nonce-${nonce}'`));
  });
}

export function previewPolicyName(nonce: string): string { return `kintsugi-preview-${nonce}`; }

export function previewPolicyDirectives(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values);
  }
  return directives;
}

/** Match CSP inline authorisation before changing a source; never grant it by rewriting. */
export function previewInlineAllowed(policies: readonly string[], kind: PreviewInlineKind, source: string, nonce = "", attribute = false): boolean {
  const hashes = new Map<string, string>();
  return policies.flatMap(policy => policy.split(",")).every(policy => {
    const directives = previewPolicyDirectives(policy);
    const values = directives.get(`${kind}-src-${attribute ? "attr" : "elem"}`) ?? directives.get(`${kind}-src`) ?? directives.get("default-src");
    if (!values) return true;
    if (!attribute && nonce && values.includes(`'nonce-${nonce}'`)) return true;
    const hashOrNonce = values.some(value => /^'(?:nonce-|sha(?:256|384|512)-)/.test(value));
    if (values.includes("'unsafe-inline'") && !hashOrNonce && !(kind === "script" && values.includes("'strict-dynamic'"))) return true;
    if (attribute && !values.includes("'unsafe-hashes'")) return false;
    return values.some(value => {
      const match = /^'(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+=*)'$/.exec(value);
      if (!match) return false;
      let digest = hashes.get(match[1]!);
      if (!digest) {
        const algorithm = match[1] === "sha256" ? sha256 : match[1] === "sha384" ? sha384 : sha512;
        const bytes = algorithm(new TextEncoder().encode(source.replace(/\r\n?/g, "\n")));
        digest = btoa(String.fromCharCode(...bytes)); hashes.set(match[1]!, digest);
      }
      return digest.replace(/=+$/, "") === match[2]!.replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
    });
  });
}
