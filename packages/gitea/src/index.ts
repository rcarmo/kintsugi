import { GitHostingRateLimitError, parseGitHostingResponse, readGitHostingCredentialFile, removeGitHostingCredentialFile, writeGitHostingCredentialFile, type GitHostingCredential, type GitHostingProvider, type GitHostingRepositorySearch, type GitHostingValidation } from "@kintsugi/core";
import { Type } from "typebox";
import { Value } from "typebox/value";

const credentialFile = "gitea-credential.json";
const credentialSchema = Type.Object({ serverUrl: Type.String(), account: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" }), token: Type.String({ minLength: 1 }), allowUntrustedCertificate: Type.Optional(Type.Boolean()) });
const userSchema = Type.Object({ id: Type.Integer(), login: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]*$" }), full_name: Type.Optional(Type.Union([Type.String(), Type.Null()])), email: Type.Optional(Type.Union([Type.String(), Type.Null()])) });
const repositoriesSchema = Type.Object({ data: Type.Array(Type.Object({ full_name: Type.String({ minLength: 1 }), clone_url: Type.String(), private: Type.Boolean(), description: Type.Optional(Type.Union([Type.String(), Type.Null()])) })) });

/** One operator-selected HTTPS instance, including an optional port and installation subpath. */
export function normalizeGiteaServerUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Use an HTTPS Gitea server URL without credentials, a query or a fragment.");
  if (url.hostname.includes("*")) throw new Error("Use an exact Gitea server hostname, not a wildcard.");
  // These providers already own their credential-helper and proxy destinations.
  if (["github.com", "api.github.com", "gitlab.com", "bitbucket.org", "api.bitbucket.org"].includes(url.hostname.replace(/\.$/, ""))) throw new Error("Use your Gitea server, not another provider's host.");
  return url.origin + url.pathname.replace(/\/+$/, "");
}

function headers(token: string): HeadersInit {
  return { accept: "application/json", "user-agent": "kintsugi", authorization: `token ${token}` };
}

function requestOptions(credential: GitHostingCredential): RequestInit & { tls?: { rejectUnauthorized: boolean } } {
  const options: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { headers: headers(credential.token.trim()), redirect: "error" };
  if (credential.allowUntrustedCertificate === true) options.tls = { rejectUnauthorized: false };
  return options;
}

export async function validateGiteaCredential(credential: GitHostingCredential): Promise<GitHostingValidation> {
  let serverUrl: string;
  try { serverUrl = normalizeGiteaServerUrl(credential.serverUrl ?? ""); }
  catch { return { ok: false, message: "Enter your Gitea HTTPS server URL, without credentials, a query or a fragment. Use the matching provider for GitHub, GitLab or Bitbucket." }; }
  const token = credential.token.trim();
  if (!token) return { ok: false, message: "Enter a Gitea token." };
  let response: Response;
  try { response = await fetch(`${serverUrl}/api/v1/user`, requestOptions(credential)); }
  catch { return { ok: false, message: "Could not reach Gitea. Check the URL, network and trusted HTTPS certificate. For a self-signed certificate, explicitly allow untrusted certificates only if you trust this server. Redirects are not followed." }; }
  if (response.status === 401 || response.status === 403) return { ok: false, message: "Gitea rejected that token. Check its expiry and user/repository permissions." };
  if (!response.ok) return { ok: false, message: `Gitea token validation failed (${response.status}). Try again.` };
  const user = await parseGitHostingResponse(response, userSchema);
  if (!user) return { ok: false, message: "Gitea returned an invalid user response. Check the server URL." };
  const saved: GitHostingCredential = { serverUrl, token, account: user.login };
  if (credential.allowUntrustedCertificate === true) saved.allowUntrustedCertificate = true;
  return { ok: true, identity: { name: user.full_name?.trim() || user.login, email: user.email?.trim() || `${user.id}-${user.login}@users.noreply.invalid` }, credential: saved };
}

export async function searchGiteaRepositories(query: string, credential: GitHostingCredential | undefined): Promise<GitHostingRepositorySearch> {
  if (!credential) return { repositories: [], notice: "Connect Gitea to search your server." };
  const serverUrl = normalizeGiteaServerUrl(credential.serverUrl ?? "");
  const url = new URL(`${serverUrl}/api/v1/repos/search`);
  url.searchParams.set("q", query.trim());
  url.searchParams.set("limit", "25");
  url.searchParams.set("private", "true");
  const response = await fetch(url, requestOptions(credential));
  if (response.status === 429) throw new GitHostingRateLimitError("Gitea repository search is rate limited", response);
  if (response.status === 401 || response.status === 403) return { repositories: [], notice: "Your Gitea repositories could not be searched. Check your Gitea connection and repository permissions." };
  if (!response.ok) throw new Error(`Gitea repository search failed (${response.status})`);
  const body = await parseGitHostingResponse(response, repositoriesSchema);
  if (!body) throw new Error("Gitea returned an invalid repository search response");
  const server = new URL(serverUrl);
  const repositories = body.data.map(repo => {
    const clone = new URL(repo.clone_url);
    if (clone.origin !== server.origin || clone.username || clone.password || clone.search || clone.hash || !clone.pathname.startsWith(`${server.pathname.replace(/\/+$/, "")}/`)) throw new Error("Gitea returned a repository URL outside the configured server");
    return { fullName: repo.full_name, description: repo.description || null, private: repo.private, cloneUrl: clone.href, personal: true };
  });
  return { repositories };
}

export const giteaProvider: GitHostingProvider = {
  id: "gitea", label: "Gitea", gitHost: "", gitUsername: "", tokenEnvVar: "GITEA_TOKEN", tokenEnvAliases: [], tokenHosts: [],
  // Arbitrary self-hosted SSH keys must be verified and added through the existing SSH trust settings.
  sshKnownHosts: "",
  connectForm: {
    instructionsHtml: "<p>Connect one Gitea HTTPS server. Create a personal access token there with user and repository read access; add repository write access if Agents should push.</p><p>Private servers still need the workspace's network permission. SSH host trust is configured separately.</p>",
    tokenPlaceholder: "Paste your Gitea token",
    serverUrl: { label: "Gitea server URL", placeholder: "https://git.example.com" },
    allowUntrustedCertificate: { label: "Allow untrusted certificates", warning: "Certificate verification will be disabled only for this server’s HTTPS host and port. An attacker could impersonate it and steal your token. Enable this only for a server you trust." },
  },
  credential() {
    const contents = readGitHostingCredentialFile(credentialFile);
    if (!contents) return undefined;
    const credential = Value.Parse(credentialSchema, JSON.parse(contents));
    return { ...credential, serverUrl: normalizeGiteaServerUrl(credential.serverUrl) };
  },
  saveCredential(credential) {
    const saved = Value.Parse(credentialSchema, { ...credential, token: credential.token.trim(), serverUrl: normalizeGiteaServerUrl(credential.serverUrl ?? "") });
    writeGitHostingCredentialFile(credentialFile, `${JSON.stringify(saved)}\n`);
  },
  clearCredential() { removeGitHostingCredentialFile(credentialFile); },
  connection(credential) {
    const url = new URL(normalizeGiteaServerUrl(credential.serverUrl ?? ""));
    const connection: ReturnType<NonNullable<GitHostingProvider["connection"]>> = { gitHost: url.host, gitUsername: credential.account!, tokenHosts: [url.hostname], tokenOrigins: [url.origin] };
    if (credential.allowUntrustedCertificate === true) connection.untrustedTlsOrigins = [url.origin];
    return connection;
  },
  workspaceEnv: () => ({}),
  validateCredential: validateGiteaCredential,
  searchRepositories: searchGiteaRepositories,
};
