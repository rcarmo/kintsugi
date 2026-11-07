import { createHash } from "node:crypto";

type InlineKind = "script" | "style";

/** Keep hash-authorized inline content authorized after URL/source translation. */
export class PreviewInlinePolicy {
  #hashes = { script: new Map<string, Set<string>>(), style: new Map<string, Set<string>>() };
  record(kind: InlineKind, original: string, rewritten: string): void {
    if (original === rewritten) return;
    for (const algorithm of ["sha256", "sha384", "sha512"] as const) {
      const digest = (text: string) => `${algorithm}-${createHash(algorithm).update(text.replace(/\r\n?/g, "\n")).digest("base64")}`;
      const key = digest(original);
      const values = this.#hashes[kind].get(key) ?? new Set<string>();
      values.add(digest(rewritten)); this.#hashes[kind].set(key, values);
    }
  }
  rewrite(policy: string): string {
    return policy.split(",").map(part => part.split(";").map(directive => {
      const name = directive.trim().split(/\s/)[0]?.toLowerCase();
      const kinds: InlineKind[] = name === "default-src" ? ["script", "style"] : name?.startsWith("script-src") ? ["script"] : name?.startsWith("style-src") ? ["style"] : [];
      return directive.replace(/'(sha256|sha384|sha512)-([A-Za-z0-9+/_-]+=*)'/g, (original, algorithm: string, value: string) => {
        const key = `${algorithm}-${Buffer.from(value, "base64").toString("base64")}`;
        const translated = new Set(kinds.flatMap(kind => [...this.#hashes[kind].get(key) ?? []]));
        return [original, ...[...translated].map(hash => `'${hash}'`)].join(" ");
      });
    }).join(";")).join(",");
  }
}
