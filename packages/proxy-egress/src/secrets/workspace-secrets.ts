import { withHostNetworkBoundary } from "../egress/network-boundary.ts";
import { grantedInstanceCredentials, resolveInstanceCredential, credentialHosts, workspaceTemplateIdOfInit, revealEffectiveSecrets, onWorkspaceTemplateStoreChanged, workspaceTemplateSecretPlaceholder, workspaceTemplateSecretHosts, workspaceTemplateSecretAllowsPath } from "@kintsugi/workspace-templates";
import { getWorkspaceInit, getAppliedWorkspaceNetwork, type WorkspaceInitInstruction } from "@kintsugi/workspace";
import { connectedGitHostingProviders, gitHostingConnection, onGitHostingCredentialsChanged } from "@kintsugi/git-hosting";
import { matchHostname } from "./patterns.ts";
import { privateNetworkDestinationAllowed } from "@kintsugi/shared/network-destinations";
import { workspaceNetworkAddressAllowed } from "@kintsugi/shared/network-policy";
import { createHttpHooks, type RequestTransformHttpHooks, type SecretRequestTransform, type SecretDefinition } from "./placeholder-hooks.ts";

export type WorkspaceSecretContext = {
  workspaceId: string;
  env: Record<string, string>;
  hooks: RequestTransformHttpHooks;
  secrets: Array<{ name: string; placeholder: string; hosts: string[] }>;
  untrustedTlsOrigins?: string[];
};

const subscriptionSecrets: Record<string, SecretDefinition> = {};
const requestTransforms = new Map<string, { transform: SecretRequestTransform; hosts: () => Promise<string[]> }>();
const responseTransforms = new Map<string, (response: Response, request: Request) => Promise<Response>>();

/** Host-owned bridges run before ordinary substitution and must register every injected secret for response scrubbing. */
export function registerWorkspaceRequestTransform(id: string, transform: SecretRequestTransform, hosts: () => Promise<string[]> = async () => []): void {
  requestTransforms.set(id, { transform, hosts });
  invalidateContexts();
}

/** HTTPS must be decrypted before host-owned request bridges can see placeholders. */
export async function workspaceRequestTransformMatchesHost(hostname: string): Promise<boolean> {
  for (const { hosts } of requestTransforms.values()) {
    if ((await hosts()).some((host) => matchHostname(hostname, host))) return true;
  }
  return false;
}

export function registerWorkspaceResponseTransform(id: string, transform: (response: Response, request: Request) => Promise<Response>): void {
  responseTransforms.set(id, transform);
  invalidateContexts();
}

export function registerWorkspaceSubscriptionSecrets(secrets: Record<string, SecretDefinition>): void {
  Object.assign(subscriptionSecrets, secrets);
  invalidateContexts();
}

const contexts = new Map<string, WorkspaceSecretContext>();
let configurationGeneration = 0;
// New requests reload hooks; existing raw CONNECT tunnels still require client reconnection.
function invalidateContexts(): void {
  configurationGeneration++;
  contexts.clear();
}
onWorkspaceTemplateStoreChanged(invalidateContexts);
onGitHostingCredentialsChanged(invalidateContexts);

export async function createWorkspaceSecretContext(workspaceId: string, init?: WorkspaceInitInstruction): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;

  const generation = configurationGeneration;
  const secrets: Record<string, SecretDefinition> = {};
  const plainEnv: Record<string, string> = {};
  const untrustedTlsOrigins: string[] = [];
  for (const { provider, credential } of connectedGitHostingProviders()) {
    const placeholder = workspaceTemplateSecretPlaceholder(provider.tokenEnvVar);
    const connection = gitHostingConnection(provider, credential);
    untrustedTlsOrigins.push(...connection.untrustedTlsOrigins ?? []);
    secrets[provider.tokenEnvVar] = { value: credential.token, hosts: connection.tokenHosts, origins: connection.tokenOrigins, placeholder };
    Object.assign(plainEnv, provider.workspaceEnv(credential));
    for (const alias of provider.tokenEnvAliases) plainEnv[alias] = placeholder;
  }
  const workspaceTemplateId = workspaceTemplateIdOfInit(init);
  for (const secret of await revealEffectiveSecrets(workspaceTemplateId)) {
    secrets[secret.envName] = { value: secret.secretValue, allowInPath: workspaceTemplateSecretAllowsPath(secret), hosts: workspaceTemplateSecretHosts(secret.hostPattern), placeholder: secret.placeholder ?? workspaceTemplateSecretPlaceholder(secret.envName) };
  }
  for (const credential of await grantedInstanceCredentials(workspaceTemplateId)) {
    if (secrets[credential.envName] || plainEnv[credential.envName] || subscriptionSecrets[credential.envName]) throw new Error(`Credential variable conflicts with an existing integration: ${credential.envName}`);
    const hosts = credentialHosts(credential);
    secrets[credential.envName] = { value: "", placeholder: credential.placeholder, hosts, origins: hosts.map(host => `https://${host}`), allowInPath: credential.allowInPath,
      resolve: () => resolveInstanceCredential(credential, workspaceTemplateId!) };
  }
  if (generation !== configurationGeneration) return createWorkspaceSecretContext(workspaceId, init);
  const created = buildContext(workspaceId, { ...secrets, ...subscriptionSecrets }, plainEnv, untrustedTlsOrigins);
  contexts.set(workspaceId, created);
  return created;
}

export async function getWorkspaceSecretContext(
  workspaceId: string,
  loadWorkspaceInit: (workspaceId: string) => Promise<WorkspaceInitInstruction | undefined> = getWorkspaceInit,
): Promise<WorkspaceSecretContext> {
  const existing = contexts.get(workspaceId);
  if (existing) return existing;
  return await createWorkspaceSecretContext(workspaceId, await loadWorkspaceInit(workspaceId));
}

export function forgetWorkspaceSecretContext(workspaceId: string): void {
  contexts.delete(workspaceId);
}

function buildContext(workspaceId: string, secrets: Record<string, SecretDefinition>, plainEnv: Record<string, string>, untrustedTlsOrigins: string[]): WorkspaceSecretContext {
  const hooks = createHttpHooks({
    allowedHosts: ["*"],
    blockInternalRanges: false,
    isIpAllowed: (request) => {
      const policy = withHostNetworkBoundary(getAppliedWorkspaceNetwork(workspaceId));
      return workspaceNetworkAddressAllowed(request.ip, policy) || privateNetworkDestinationAllowed(policy.destinations ?? [], request, { enabled: policy.mode === "hosts", denied: policy.denied });
    },
    replaceSecretsInQuery: false,
    secrets,
    onRequest: async (request, registerSecret) => {
      for (const { transform } of requestTransforms.values()) request = await transform(request, registerSecret);
      return request;
    },
    onResponse: async (response, request) => {
      for (const transform of responseTransforms.values()) response = await transform(response, request);
      return response;
    },
  });
  return {
    workspaceId,
    untrustedTlsOrigins,
    env: { ...plainEnv, ...Object.fromEntries(Object.entries(hooks.env).filter(([name]) => !(name in subscriptionSecrets))) },
    hooks: hooks.httpHooks,
    secrets: hooks.secrets,
  };
}
