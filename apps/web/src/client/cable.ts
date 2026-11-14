/// <reference lib="dom" />

import { cableHeartbeatIntervalMs, decodeCableServerMessage, encodeCableClientMessages, liveRegionDigestsSchema, liveShownAttribute, serializeCableIdentifier, type KintsugiCableClient, type CableClientMessage, type CableIdentifier, type CableSubscription, type CableSubscriptionOptions, type WorkspaceVisibilityReport } from "@kintsugi/shared";
import { Value } from "typebox/value";
import { browserTransportFromCookies } from "../browser-transport.ts";

declare global {
  interface Window {
    KintsugiCable?: KintsugiCableClient;
    Turbo?: { renderStreamMessage(html: string): void };
  }
}

type SubscriptionLease = CableSubscription & {
  options?: CableSubscriptionOptions;
};

type DesiredSubscription = {
  identifier: CableIdentifier;
  leases: Set<SubscriptionLease>;
  status: "pending" | "ready" | "rejected";
  subscriptionId?: string;
  confirmationTimer?: ReturnType<typeof setTimeout>;
  /** Until a snapshot is applied, the page still shows this element's server render. */
  shownIn?: Element;
};

type LiveConnection = {
  pendingCommands: CableClientMessage[];
  connectionId?: string;
  openingTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  /** Welcome frames from older app servers use the original 30s cadence. */
  heartbeatIntervalMs?: number;
} & ({ transport: "websocket"; socket: WebSocket } | { transport: "sse"; controller: AbortController; commands: Promise<void>; reader?: ReadableStreamDefaultReader<Uint8Array> });

export type CableStreamRenderer = (html: string, isCurrent: () => boolean, onApplied: () => void) => void;

export function createKintsugiCableClient(renderStreams: CableStreamRenderer): KintsugiCableClient {
  const desired = new Map<string, DesiredSubscription>();
  const delays = [100, 250, 500, 1000, 2000, 5000];
  let connection: LiveConnection | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let recovering = true;
  let closingForPageHide = false;
  let visibility: WorkspaceVisibilityReport = { surfaceKeys: [] };
  let lastMessageAt = Date.now();
  setInterval(() => {
    if (connection && Date.now() - lastMessageAt > (connection.heartbeatIntervalMs ?? 30_000) * 2.5) disconnect(connection);
  }, cableHeartbeatIntervalMs / 2);

  function changed(): void { document.dispatchEvent(new Event("live:connection")); }

  function sendRaw(message: CableClientMessage): void {
    const source = connection;
    if (!source?.connectionId || (source.transport === "websocket" && source.socket.readyState !== WebSocket.OPEN)) return;
    source.pendingCommands.push(message);
    if (source.pendingCommands.length > 1) return;
    // Visibility and initial subscriptions share a bounded, ordered batch.
    queueMicrotask(() => {
      const messages = source.pendingCommands.splice(0);
      if (connection !== source) return;
      if (source.transport === "websocket") {
        try {
          for (const body of encodeCableClientMessages(messages)) source.socket.send(body);
        } catch (error) {
          console.error("Live command could not be delivered", error);
          disconnect(source);
        }
      } else {
        source.commands = source.commands.then(async () => {
          if (connection !== source) return;
          for (const body of encodeCableClientMessages(messages)) {
            if (connection !== source) return;
            // Safari may leave a POST pending while the SSE reader still receives pings.
            // A heartbeat alone cannot prove that the command path is making progress.
            const timer = setTimeout(() => disconnect(source), 8_000);
            try {
              const response = await fetch(`/cable/${source.connectionId}`, {
                method: "POST", headers: { "content-type": "application/json" }, body,
                signal: source.controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error",
              });
              if (!response.ok) throw new Error(`Live command failed: ${response.status}`);
            } finally { clearTimeout(timer); }
          }
        }).catch(error => {
          if (connection !== source) return;
          console.error("Live command could not be delivered", error);
          disconnect(source);
        });
      }
    });
  }

  function subscribeOnWire(subscription: DesiredSubscription): void {
    const source = connection;
    if (!source) return;
    clearTimeout(subscription.confirmationTimer);
    const subscriptionId = crypto.randomUUID();
    subscription.status = "pending";
    subscription.subscriptionId = subscriptionId;
    changed();
    const message: Extract<CableClientMessage, { command: "subscribe" }> = { command: "subscribe", identifier: subscription.identifier, subscriptionId };
    const shown = subscription.shownIn?.getAttribute(liveShownAttribute);
    if (shown) message.shown = Value.Parse(liveRegionDigestsSchema, JSON.parse(shown));
    subscription.confirmationTimer = setTimeout(() => {
      if (matchingSubscription(subscription.identifier, subscriptionId) === subscription) disconnect(source);
    }, 20_000);
    sendRaw(message);
  }

  function resubscribeAll(): void {
    for (const subscription of desired.values()) subscribeOnWire(subscription);
  }

  function scheduleReconnect(): void {
    if (closingForPageHide || reconnectTimer || desired.size === 0) return;
    const delay = delays[Math.min(attempts++, delays.length - 1)]!;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function matchingSubscription(identifier: CableIdentifier, subscriptionId: string): DesiredSubscription | undefined {
    const subscription = desired.get(serializeCableIdentifier(identifier));
    return subscription?.subscriptionId === subscriptionId ? subscription : undefined;
  }

  function markSubscriptionsDisconnected(notify: boolean): void {
    for (const subscription of desired.values()) {
      if (notify && subscription.status === "ready") {
        for (const lease of subscription.leases) lease.options?.onDisconnected?.();
      }
      clearTimeout(subscription.confirmationTimer);
      subscription.confirmationTimer = undefined;
      subscription.status = "pending";
      subscription.subscriptionId = undefined;
    }
  }

  function handleMessage(source: LiveConnection, raw: string): void {
    if (connection !== source) return;
    lastMessageAt = Date.now();
    const message = decodeCableServerMessage(raw);
    switch (message.type) {
      case "welcome":
        clearTimeout(source.openingTimer);
        source.connectionId = message.connectionId;
        source.heartbeatIntervalMs = message.heartbeatIntervalMs;
        attempts = 0;
        sendRaw({ command: "visibility", visibility });
        resubscribeAll();
        break;
      case "confirm_subscription": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (!subscription) break;
        clearTimeout(subscription.confirmationTimer);
        subscription.confirmationTimer = undefined;
        const isCurrent = () => matchingSubscription(message.identifier, message.subscriptionId) === subscription;
        const applied = () => {
          if (!isCurrent()) return;
          subscription.status = "ready";
          subscription.shownIn?.removeAttribute(liveShownAttribute);
          subscription.shownIn = undefined;
          if ([...desired.values()].every(item => item.status !== "pending")) recovering = false;
          changed();
          for (const lease of subscription.leases) lease.options?.onReady?.();
        };
        if (message.html) renderStreams(message.html, isCurrent, applied);
        else applied();
        break;
      }
      case "reject_subscription":
        const rejected = matchingSubscription(message.identifier, message.subscriptionId);
        if (rejected) {
          clearTimeout(rejected.confirmationTimer);
          rejected.confirmationTimer = undefined;
          rejected.status = "rejected";
          rejected.subscriptionId = undefined;
          console.error("Cable subscription rejected", message);
          for (const lease of rejected.leases) lease.options?.onRejected?.(message.reason);
          if ([...desired.values()].every(item => item.status !== "pending")) recovering = false;
          changed();
        }
        break;
      case "turbo_stream": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (subscription) renderStreams(message.html, () => matchingSubscription(message.identifier, message.subscriptionId) === subscription, () => {});
        break;
      }
      case "ping":
        // Application heartbeats drive the stale-connection watchdog.
        break;
      case "error":
        console.error("Cable error", message.message);
        break;
    }
  }

  function disconnect(source: LiveConnection, notify = true): void {
    if (connection !== source) return;
    connection = undefined;
    clearTimeout(source.openingTimer);
    if (source.transport === "websocket") source.socket.close();
    else {
      source.controller.abort();
      // Release the reader too; suspended WebKit fetches do not always settle promptly on abort.
      void source.reader?.cancel().catch(() => {});
    }
    recovering = true;
    markSubscriptionsDisconnected(notify);
    changed();
    scheduleReconnect();
  }

  async function receiveSse(source: Extract<LiveConnection, { transport: "sse" }>): Promise<void> {
    try {
      const response = await fetch("/cable", {
        method: "POST", headers: { accept: "text/event-stream" }, signal: source.controller.signal,
        credentials: "same-origin", cache: "no-store", redirect: "error",
      });
      if (connection !== source) { await response.body?.cancel(); return; }
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) {
        throw new Error(`Live stream failed: ${response.status}`);
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      source.reader = reader;
      let pending = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done || connection !== source) break;
          pending += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = pending.indexOf("\n\n")) !== -1) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
            if (data) handleMessage(source, data);
          }
        }
      } finally { source.reader = undefined; reader.releaseLock(); }
      disconnect(source);
    } catch (error) {
      if (connection !== source) return;
      console.error("Live stream disconnected", error);
      disconnect(source);
    }
  }

  function connect(): void {
    if (connection || closingForPageHide || document.hidden || desired.size === 0) return;
    lastMessageAt = Date.now();
    let source: LiveConnection;
    if (browserTransportFromCookies(document.cookie) === "sse") {
      source = { transport: "sse", controller: new AbortController(), commands: Promise.resolve(), pendingCommands: [], startedAt: Date.now() };
    } else {
      try {
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        source = { transport: "websocket", socket: new WebSocket(`${protocol}//${location.host}/cable`), pendingCommands: [], startedAt: Date.now() };
      } catch (error) {
        // A browser/CSP rejection must not prevent Settings from initialising.
        console.error("Live WebSocket could not be opened", error);
        scheduleReconnect();
        return;
      }
    }
    connection = source;
    source.openingTimer = setTimeout(() => disconnect(source), 15_000);
    if (source.transport === "sse") { void receiveSse(source); return; }
    source.socket.onmessage = event => {
      try {
        handleMessage(source, event.data);
      } catch (error) {
        console.error("Live message could not be applied", error);
        disconnect(source);
      }
    };
    source.socket.onclose = () => disconnect(source);
    source.socket.onerror = () => disconnect(source);
  }

  function pause(): void {
    closingForPageHide = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (connection) disconnect(connection, false);
  }
  function resume(replace = false): void {
    if (document.hidden) return;
    closingForPageHide = false;
    attempts = 0;
    // A frozen iPad page can return without delivering its earlier hide event.
    // Do not trust the pre-suspension reader. Coalesce the cluster of wake events
    // by retaining a connection we have only just started.
    if (replace && connection && Date.now() - connection.startedAt > 1000) disconnect(connection);
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    connect();
  }
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", event => resume(event.persisted));
  window.addEventListener("online", () => resume(true));
  window.addEventListener("focus", () => resume(Date.now() - lastMessageAt > (connection?.heartbeatIntervalMs ?? 30_000)));
  document.addEventListener("visibilitychange", () => document.hidden ? pause() : resume(true));

  const client: KintsugiCableClient = {
    ready() { return connection?.connectionId !== undefined && !recovering; },
    reconnect() { if (connection) disconnect(connection); else scheduleReconnect(); },
    reportVisibility(next) {
      visibility = next;
      sendRaw({ command: "visibility", visibility });
    },
    subscribe(identifier, options) {
      const key = serializeCableIdentifier(identifier);
      let subscription = desired.get(key);
      if (!subscription) {
        subscription = { identifier, leases: new Set(), status: "pending", shownIn: options?.shownIn };
        desired.set(key, subscription);
        connect();
        if (connection?.connectionId !== undefined) subscribeOnWire(subscription);
      } else if (subscription.status === "rejected" && connection?.connectionId !== undefined) {
        subscribeOnWire(subscription);
      }

      const lease: SubscriptionLease = {
        options,
        unsubscribe() {
          if (!subscription.leases.delete(lease) || subscription.leases.size > 0) return;
          if (desired.get(key) !== subscription) return;
          clearTimeout(subscription.confirmationTimer);
          subscription.confirmationTimer = undefined;
          desired.delete(key);
          if ([...desired.values()].every(item => item.status !== "pending")) recovering = false;
          changed();
          if (subscription.subscriptionId) {
            sendRaw({ command: "unsubscribe", identifier: subscription.identifier, subscriptionId: subscription.subscriptionId });
          }
        },
      };
      subscription.leases.add(lease);
      if (subscription.status === "ready") requestAnimationFrame(() => {
        if (subscription.leases.has(lease) && desired.get(key) === subscription && subscription.status === "ready") lease.options?.onReady?.();
      });
      return lease;
    },
  };

  return client;
}
