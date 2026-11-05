import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { getKintsugiRuntimeContext } from "./runtime-context.ts";
import { shellQuote } from "./shell.ts";

export interface GitHostingCredential {
  token: string;
  /** The account the token belongs to, for providers whose API needs it next to the token. */
  account?: string;
  /** Configured instance for self-hosted providers. */
  serverUrl?: string;
  /** Explicit operator opt-in, scoped to this configured HTTPS server. */
  allowUntrustedCertificate?: boolean;
}

export interface GitHostingIdentity {
  name: string;
  email: string;
}

export type GitHostingValidation = { ok: true; identity: GitHostingIdentity; credential?: GitHostingCredential } | { ok: false; message: string };

export interface GitHostingRepository {
  fullName: string;
  description: string | null;
  private: boolean;
  cloneUrl: string;
  personal: boolean;
}

export interface GitHostingRepositorySearch {
  repositories: GitHostingRepository[];
  notice?: string;
}

export interface GitHostingConnectForm {
  /** Trusted HTML explaining how to create a token. */
  instructionsHtml: string;
  tokenPlaceholder: string;
  account?: { label: string; placeholder: string };
  serverUrl?: { label: string; placeholder: string };
  allowUntrustedCertificate?: { label: string; warning: string };
}

/** One place where people keep repositories, connected with a token that never enters a workspace. */
export interface GitHostingProvider {
  id: string;
  label: string;
  /** HTTPS git remotes on this host receive the token from the credential helper. */
  gitHost: string;
  gitUsername: string;
  /** Workspace environment variable holding the token placeholder. */
  tokenEnvVar: string;
  /** More workspace variables holding the same placeholder, for provider CLIs that read their own name. */
  tokenEnvAliases: string[];
  /** Hosts where the egress proxy substitutes the real token. */
  tokenHosts: string[];
  /** Exact HTTPS origins for a configurable provider; restricts scheme and port as well as host. */
  tokenOrigins?: string[];
  /** Exact HTTPS origins with an operator-approved certificate exception. */
  untrustedTlsOrigins?: string[];
  /** Resolve instance-specific routing from the same credential snapshot used for its token. */
  connection?(credential: GitHostingCredential): Pick<GitHostingProvider, "gitHost" | "gitUsername" | "tokenHosts" | "tokenOrigins" | "untrustedTlsOrigins">;
  /** Verified known_hosts records trusted by default. */
  sshKnownHosts: string;
  connectForm: GitHostingConnectForm;
  credential(): GitHostingCredential | undefined;
  saveCredential(credential: GitHostingCredential): void;
  clearCredential(): void;
  /** Non-secret workspace environment derived from the credential. */
  workspaceEnv(credential: GitHostingCredential): Record<string, string>;
  validateCredential(credential: GitHostingCredential): Promise<GitHostingValidation>;
  searchRepositories(query: string, credential: GitHostingCredential | undefined): Promise<GitHostingRepositorySearch>;
}

export class GitHostingRateLimitError extends Error {
  readonly retryAfterSeconds: number | undefined;

  constructor(message: string, response: Response) {
    super(message);
    this.name = "GitHostingRateLimitError";
    this.retryAfterSeconds = Number(response.headers.get("retry-after") ?? undefined) || undefined;
  }
}

/** Short-lived lookups per credential, keyed by a hash so tokens never become map keys. */
export function createGitHostingCache<T>(ttlMs: number): (credential: GitHostingCredential | undefined, key: string, load: () => Promise<T>) => Promise<T> {
  const entries = new Map<string, { expiresAt: number; value: T }>();
  return async (credential, key, load) => {
    const now = Date.now();
    for (const [entryKey, entry] of entries) if (entry.expiresAt <= now) entries.delete(entryKey);
    const credentialKey = credential ? createHash("sha256").update(JSON.stringify([credential.serverUrl ?? "", credential.account ?? "", credential.token, credential.allowUntrustedCertificate === true])).digest("hex") : "anonymous";
    const cacheKey = `${credentialKey}:${key}`;
    const cached = entries.get(cacheKey);
    if (cached) return cached.value;
    const value = await load();
    entries.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
    return value;
  };
}

export function gitHostingCredentialPath(fileName: string): string {
  return join(getKintsugiRuntimeContext().kintsugiDataDir, "workspace", fileName);
}

export function readGitHostingCredentialFile(fileName: string): string | undefined {
  const path = gitHostingCredentialPath(fileName);
  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

export function writeGitHostingCredentialFile(fileName: string, contents: string): void {
  const path = gitHostingCredentialPath(fileName);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
}

export function removeGitHostingCredentialFile(fileName: string): void {
  rmSync(gitHostingCredentialPath(fileName), { force: true });
}

/** Provider API responses are external input: undefined when they are not what we expect. */
export async function parseGitHostingResponse<Schema extends TSchema>(response: Response, schema: Schema): Promise<Static<Schema> | undefined> {
  try {
    return Value.Parse(schema, await response.json());
  } catch {
    return undefined;
  }
}

type CredentialHelperProvider = Pick<GitHostingProvider, "gitHost" | "gitUsername" | "tokenEnvVar">;

// Submodule URLs are repository-controlled, so each token is only offered to its own host.
export function gitCredentialHelperShellBody(providers: readonly CredentialHelperProvider[]): string {
  const cases = providers.filter(provider => provider.gitHost).map((provider) => {
    const host = new URL(`https://${provider.gitHost}`);
    const hosts = host.port ? [host.host] : [host.host, `${host.hostname}:443`];
    return `    ${hosts.map(shellQuote).join("|")}) username=${shellQuote(provider.gitUsername)}; token="\${${provider.tokenEnvVar}:-}" ;;`;
  }).join("\n");
  return `test "$1" = get || exit 0
protocol=
host=
while IFS='=' read -r key value; do
  case "$key" in
    protocol) protocol="$value" ;;
    host) host="$value" ;;
  esac
done
[ "$protocol" = https ] || exit 0
case "$host" in
${cases}
    *) exit 0 ;;
esac
[ -n "$token" ] || exit 0
echo username="$username"
echo password="$token"`;
}
