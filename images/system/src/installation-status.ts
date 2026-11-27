export type Activity = { description: string; percent?: number };
export type InstallationStatus = {
  state: "starting" | "ready" | "failed";
  activity: Activity;
  recoveringHealth?: true;
  appUrl?: string;
  supervisorUrl?: string;
  action?: { description: string; url?: string };
  diagnostics?: { description: string; lines: string[] };
};

// This is System's public installation contract. Clients need no knowledge of
// Tailscale states, routes, startup phases, or where diagnostic output lives.
export function installationStatus(input: {
  activity: Activity;
  localMode?: boolean;
  proxyMode?: boolean;
  localOrigin?: string;
  failure?: string;
  recoveringHealth?: boolean;
  degradedHealth?: boolean;
  stopping: boolean;
  busy: boolean;
  appResponding: boolean;
  hostname?: string;
  appliedRoute: string;
  connectionState: string;
  authUrl?: string;
  connectionAction?: InstallationStatus["action"];
  logs: string[];
}): InstallationStatus {
  const { hostname, appliedRoute } = input;
  const localSupervisor = input.proxyMode ? undefined : input.localOrigin?.replace("//kintsugi.", "//system.kintsugi.");
  const supervisorUrl = !input.localMode && !input.connectionAction && hostname && appliedRoute.startsWith(`${hostname}:`)
    ? `https://${hostname}:8443` : localSupervisor;
  const terminal = Boolean(input.failure || input.stopping);
  const recoveringHealth = !terminal && input.recoveringHealth === true;
  const ready = input.appResponding && !input.busy && !terminal && !recoveringHealth &&
    (input.localMode || !input.connectionAction) &&
    (input.localMode ? !!input.localOrigin : !!hostname && appliedRoute === `${hostname}:3000`);
  const state = terminal ? "failed" : ready ? "ready" : "starting";
  let action: InstallationStatus["action"];
  if (!input.localMode && input.connectionAction) {
    action = input.connectionAction;
  } else if (!input.localMode && input.connectionState === "NeedsMachineAuth") {
    action = {
      description: "Ask your Tailscale administrator to approve this server, then leave this installer running to continue.",
      url: "https://login.tailscale.com/admin/machines",
    };
  } else if (!input.localMode && input.authUrl && input.connectionState === "NeedsLogin") {
    action = {
      description: "Kintsugi uses Tailscale so only your devices can reach it. Sign in to connect securely.",
      url: input.authUrl,
    };
  }
  return {
    state,
    activity: state === "failed" ? { description: input.failure ?? "Kintsugi services stopped" }
      : recoveringHealth ? { description: input.degradedHealth
        ? "A health check failed. Checking again without closing access to Kintsugi."
        : "Kintsugi stopped responding to health checks. Waiting for it to recover." }
      : ready ? { description: "Your Kintsugi is ready!" }
      : action ? { description: "Waiting for your private connection" }
      : input.appResponding && !input.busy ? { description: "Connecting Kintsugi securely" }
      : input.activity,
    recoveringHealth: recoveringHealth ? true : undefined,
    appUrl: ready ? input.localMode ? input.localOrigin : `https://${hostname}` : undefined,
    supervisorUrl,
    action: terminal || recoveringHealth ? undefined : action,
    diagnostics: state === "failed" ? {
      description: supervisorUrl ? "Open the supervisor for full logs and recovery options." : "The supervisor is not reachable over your private connection yet. Recent System logs:",
      lines: supervisorUrl ? [] : input.logs.slice(-12),
    } : undefined,
  };
}
