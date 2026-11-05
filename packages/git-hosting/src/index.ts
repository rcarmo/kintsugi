import { gitCredentialHelperShellBody as credentialHelperShellBody, invalidArguments, type GitHostingCredential, type GitHostingProvider } from "@kintsugi/core";
import { bitbucketProvider } from "@kintsugi/bitbucket";
import { gitHubProvider } from "@kintsugi/github";
import { gitLabProvider } from "@kintsugi/gitlab";
import { giteaProvider } from "@kintsugi/gitea";

export const gitHostingProviders: readonly GitHostingProvider[] = [gitHubProvider, gitLabProvider, bitbucketProvider, giteaProvider];

export function gitHostingProvider(id: string): GitHostingProvider {
  const provider = gitHostingProviders.find((candidate) => candidate.id === id);
  if (!provider) throw invalidArguments(`unknown git hosting provider: ${id}`);
  return provider;
}

export function connectedGitHostingProviders(): Array<{ provider: GitHostingProvider; credential: GitHostingCredential }> {
  return gitHostingProviders.flatMap((provider) => {
    const credential = provider.credential();
    return credential ? [{ provider, credential }] : [];
  });
}

const listeners = new Set<() => void>();

export function onGitHostingCredentialsChanged(listener: () => void): void {
  listeners.add(listener);
}

export function saveGitHostingCredential(provider: GitHostingProvider, credential: GitHostingCredential): void {
  provider.saveCredential(credential);
  for (const listener of listeners) listener();
}

export function clearGitHostingCredential(provider: GitHostingProvider): void {
  provider.clearCredential();
  for (const listener of listeners) listener();
}

export function gitHostingConnection(provider: GitHostingProvider, credential: GitHostingCredential) {
  return provider.connection?.(credential) ?? provider;
}

/** Capture configurable hosts, usernames and tokens together, so instance rotation cannot mix credentials. */
export function gitHostingGitConfiguration() {
  const connected = new Map(connectedGitHostingProviders().map(({ provider, credential }) => [provider, credential]));
  const providers = gitHostingProviders.map(provider => {
    const credential = connected.get(provider);
    return { ...(credential ? gitHostingConnection(provider, credential) : provider), tokenEnvVar: provider.tokenEnvVar };
  });
  const configArgs = [...new Set(providers.flatMap(provider => provider.untrustedTlsOrigins ?? []))].flatMap(origin => ["-c", `http.${origin}/.sslVerify=false`, "-c", `http.${origin}/.followRedirects=false`]);
  const shellBody = credentialHelperShellBody(providers);
  return { shellBody, configArgs, command: `!f() { ${shellBody}; }; f`, environment: Object.fromEntries([...connected].map(([provider, credential]) => [provider.tokenEnvVar, credential.token])) };
}

export function gitCredentialHelperShellBody(): string { return gitHostingGitConfiguration().shellBody; }

export const gitHostingKnownHosts = gitHostingProviders.map((provider) => provider.sshKnownHosts).join("");

/** `github.com/org/repo` style shorthand for a provider-hosted repository. */
export function gitHostingShorthandUrl(spec: string): string | undefined {
  return gitHostingProviders.some((provider) => provider.gitHost && spec.toLowerCase().startsWith(`${provider.gitHost}/`)) ? `https://${spec}` : undefined;
}
