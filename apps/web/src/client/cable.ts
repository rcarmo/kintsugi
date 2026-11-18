/// <reference lib="dom" />

import { cableCommandBatchLimit, cableCommandBodyLimit, cableHeartbeatIntervalMs, decodeCableServerMessage, encodeCableClientMessages, liveRegionDigestsSchema, liveShownAttribute, serializeCableIdentifier, type KintsugiCableClient, type CableClientMessage, type CableIdentifier, type CableSubscription, type CableSubscriptionOptions, type WorkspaceVisibilityReport } from "@kintsugi/shared";
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
  drainingCommands?: boolean;
  connectionId?: string;
  openingTimer?: ReturnType<typeof setTimeout>;
  stabilityTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
  /** Welcome frames from older app servers use the original 30s cadence. */
  heartbeatIntervalMs?: number;
} & ({ transport: "websocket"; socket: WebSocket } | { transport: "sse"; controller: AbortController; reader?: ReadableStreamDefaultReader<Uint8Array> });

export type CableStreamRenderer = (html: string, isCurrent: () => boolean, onApplied: () => void, onFailed: (error: Error) => void) => void;

const utf8 = new TextEncoder();
const maxPendingCommands = cableCommandBatchLimit * 4;
const maxBufferedCommandBytes = 1024 * 1024;

export function createKintsugiCableClient(renderStreams: CableStreamRenderer): KintsugiCableClient {
  const desired = new Map<string, DesiredSubscription>();
  // Changing the browser preference reloads the initiating page. Other open
  // pages keep their selected transport until they too are reloaded.
  const transport = browserTransportFromCookies(document.cookie);
  const delays = [100, 250, 500, 1000, 2000, 5000];
  let connection: LiveConnection | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  let closingForPageHide = false;
  let visibility: WorkspaceVisibilityReport = { surfaceKeys: [] };
  let lastMessageAt = Date.now();
  setInterval(() => {
    if (document.hidden || desired.size === 0) return;
    // Lifecycle events can be lost when WebKit suspends/restores a page. Also
    // reconcile visible state when there is no socket left to become stale.
    if (closingForPageHide) { resume(true); return; }
    if (!connection) { scheduleReconnect(); return; }
    if (Date.now() - lastMessageAt > (connection.heartbeatIntervalMs ?? 30_000) * 2.5) transportFailed(connection, "heartbeat timed out");
  }, cableHeartbeatIntervalMs / 2);

  function changed(): void { document.dispatchEvent(new Event("live:connection")); }

  function sendRaw(message: CableClientMessage): void {
    const source = connection;
    if (!source?.connectionId) return;
    const queue = source.pendingCommands;
    // Visibility describes current state, not a history. Preserve its order
    // relative to subscribe/unsubscribe, but replace adjacent unsent reports.
    if (message.command === "visibility" && queue.at(-1)?.command === "visibility") queue[queue.length - 1] = message;
    else queue.push(message);
    if (queue.length > maxPendingCommands) {
      transportFailed(source, "command queue exceeded capacity");
      return;
    }
    if (source.drainingCommands) return;
    source.drainingCommands = true;
    queueMicrotask(() => { void drainCommands(source); });
  }

  async function drainCommands(source: LiveConnection): Promise<void> {
    try {
      // Keep one drain per connection, including while an SSE POST is pending.
      while (connection === source && source.pendingCommands.length) {
        for (const body of encodeCableClientMessages(source.pendingCommands.splice(0))) {
          if (connection !== source) return;
          if (source.transport === "websocket") {
            if (source.socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket is no longer writable");
            if (source.socket.bufferedAmount + utf8.encode(body).byteLength > maxBufferedCommandBytes) {
              throw new Error("WebSocket command buffer exceeded capacity");
            }
            source.socket.send(body);
            continue;
          }
          // Safari may leave a POST pending while the SSE reader still receives pings.
          const timer = setTimeout(() => transportFailed(source, "SSE command timed out"), 8_000);
          try {
            const response = await fetch(`/cable/${source.connectionId}`, {
              method: "POST", headers: { "content-type": "application/json" }, body,
              signal: source.controller.signal, credentials: "same-origin", cache: "no-store", redirect: "error",
            });
            if (!response.ok) throw new Error(`Live command failed: ${response.status}`);
          } finally { clearTimeout(timer); }
        }
      }
    } catch (error) {
      if (connection !== source) return;
      console.error("Live command could not be delivered", error);
      transportFailed(source, "command failed");
    } finally { source.drainingCommands = false; }
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
    if (shown) {
      try {
        message.shown = Value.Parse(liveRegionDigestsSchema, JSON.parse(shown));
        if (utf8.encode(JSON.stringify(message)).byteLength > cableCommandBodyLimit) throw new Error("Live cache hint exceeds the command limit");
      } catch (error) {
        delete message.shown;
        // A retained cache hint is optional, not a reason to break the connection.
        console.error("Invalid live cache hint; requesting a fresh snapshot", error);
        subscription.shownIn?.removeAttribute(liveShownAttribute);
        subscription.shownIn = undefined;
      }
    }
    subscription.confirmationTimer = setTimeout(() => {
      if (matchingSubscription(subscription.identifier, subscriptionId) !== subscription) return;
      failView(source, subscription, "Live updates timed out while waiting for this view. Retry the view to reconnect.");
    }, 20_000);
    sendRaw(message);
  }

  function resubscribeAll(): void {
    for (const subscription of desired.values()) subscribeOnWire(subscription);
  }

  function scheduleReconnect(): void {
    if (closingForPageHide || document.hidden || reconnectTimer || desired.size === 0) return;
    const base = delays[Math.min(attempts++, delays.length - 1)]!;
    // Spread simultaneous reconnects without exceeding the configured delay cap.
    const delay = Math.round(base * (0.8 + Math.random() * 0.2));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  }

  function shellUnavailable(): boolean {
    return [...desired.values()].some(item => item.identifier.channel === "shell" && item.status !== "ready");
  }

  function settled(source: LiveConnection): void {
    if (connection !== source || !source.connectionId || shellUnavailable() || source.stabilityTimer !== undefined) return;
    // Welcome/confirmation alone cannot establish recovery: a flapping server
    // can deliver either and immediately disconnect. Retain its retry history
    // until the subscriptions have remained settled on a stable connection.
    source.stabilityTimer = setTimeout(() => {
      source.stabilityTimer = undefined;
      if (connection === source && !shellUnavailable()) attempts = 0;
    }, 10_000);
  }

  function matchingSubscription(identifier: CableIdentifier, subscriptionId: string): DesiredSubscription | undefined {
    const subscription = desired.get(serializeCableIdentifier(identifier));
    return subscription?.subscriptionId === subscriptionId ? subscription : undefined;
  }

  function notifyLease(notify: () => void): void {
    try { notify(); }
    catch (error) { console.error("Live subscription callback failed", error); }
  }

  function rejectView(source: LiveConnection, subscription: DesiredSubscription, reason: string): void {
    clearTimeout(subscription.confirmationTimer);
    subscription.confirmationTimer = undefined;
    subscription.status = "rejected";
    subscription.subscriptionId = undefined;
    for (const lease of [...subscription.leases]) {
      if (subscription.leases.has(lease)) notifyLease(() => lease.options?.onRejected?.(reason));
    }
    settled(source);
    changed();
  }

  function failView(source: LiveConnection, subscription: DesiredSubscription, reason: string): void {
    if (subscription.identifier.channel === "shell") { disconnect(source); return; }
    if (subscription.subscriptionId) {
      sendRaw({ command: "unsubscribe", identifier: subscription.identifier, subscriptionId: subscription.subscriptionId });
    }
    // A slow or broken view must not tear down a healthy connection or its siblings.
    rejectView(source, subscription, reason);
  }

  function applyStreams(source: LiveConnection, subscription: DesiredSubscription, subscriptionId: string, html: string, applied: () => void): void {
    const current = () => connection === source && matchingSubscription(subscription.identifier, subscriptionId) === subscription;
    const failed = (error: Error) => {
      if (!current()) return;
      console.error("Live view could not be applied", error);
      failView(source, subscription, "Live updates could not be applied to this view. Retry the view to reconnect.");
    };
    try { renderStreams(html, current, applied, failed); }
    catch (error) { failed(error instanceof Error ? error : new Error(String(error))); }
  }

  function markSubscriptionsDisconnected(notify: boolean): SubscriptionLease[] {
    const interrupted: SubscriptionLease[] = [];
    for (const subscription of desired.values()) {
      if (notify && subscription.status === "ready") interrupted.push(...subscription.leases);
      clearTimeout(subscription.confirmationTimer);
      subscription.confirmationTimer = undefined;
      subscription.status = "pending";
      subscription.subscriptionId = undefined;
    }
    return interrupted;
  }

  function handleMessage(source: LiveConnection, raw: string): void {
    if (connection !== source) return;
    const message = decodeCableServerMessage(raw);
    lastMessageAt = Date.now();
    switch (message.type) {
      case "welcome":
        // A welcome belongs to a connection, not to a subscription refresh.
        if (source.connectionId !== undefined) break;
        clearTimeout(source.openingTimer);
        source.connectionId = message.connectionId;
        source.heartbeatIntervalMs = message.heartbeatIntervalMs;
        sendRaw({ command: "visibility", visibility });
        resubscribeAll();
        settled(source);
        changed();
        break;
      case "confirm_subscription": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (!subscription) break;
        const isCurrent = () => matchingSubscription(message.identifier, message.subscriptionId) === subscription;
        const applied = () => {
          if (!isCurrent()) return;
          clearTimeout(subscription.confirmationTimer);
          subscription.confirmationTimer = undefined;
          subscription.status = "ready";
          subscription.shownIn?.removeAttribute(liveShownAttribute);
          subscription.shownIn = undefined;
          const leases = [...subscription.leases];
          settled(source);
          changed();
          for (const lease of leases) {
            if (isCurrent() && subscription.leases.has(lease)) notifyLease(() => lease.options?.onReady?.());
          }
        };
        if (message.html) applyStreams(source, subscription, message.subscriptionId, message.html, applied);
        else applied();
        break;
      }
      case "reject_subscription":
        const rejected = matchingSubscription(message.identifier, message.subscriptionId);
        if (rejected) {
          console.error("Cable subscription rejected", message);
          rejectView(source, rejected, message.reason);
        }
        break;
      case "turbo_stream": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (subscription) applyStreams(source, subscription, message.subscriptionId, message.html, () => {});
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

  function transportFailed(source: LiveConnection, reason: string): void {
    if (connection !== source) return;
    console.warn(`Live ${source.transport} connection: ${reason}`);
    disconnect(source);
  }

  function disconnect(source: LiveConnection, notify = true): void {
    if (connection !== source) return;
    connection = undefined;
    clearTimeout(source.openingTimer);
    clearTimeout(source.stabilityTimer);
    source.pendingCommands.length = 0;
    if (source.transport === "websocket") source.socket.close();
    else {
      source.controller.abort();
      // Release the reader too; suspended WebKit fetches do not always settle promptly on abort.
      void source.reader?.cancel().catch(() => {});
    }
    const interrupted = markSubscriptionsDisconnected(notify);
    scheduleReconnect();
    for (const lease of interrupted) notifyLease(() => lease.options?.onDisconnected?.());
    changed();
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
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(pending))) {
            const frame = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
            if (data) handleMessage(source, data);
          }
        }
      } finally { source.reader = undefined; reader.releaseLock(); }
      transportFailed(source, "event stream ended");
    } catch (error) {
      if (connection !== source) return;
      console.error("Live stream disconnected", error);
      transportFailed(source, "event stream failed");
    }
  }

  function connect(): void {
    // Online/offline are OS hints, not reachability tests for a local/tailnet app.
    // Visible pages keep bounded backoff probes; hidden pages do not reconnect.
    if (connection || reconnectTimer !== undefined || closingForPageHide || document.hidden || desired.size === 0) return;
    lastMessageAt = Date.now();
    let source: LiveConnection;
    if (transport === "sse") {
      source = { transport: "sse", controller: new AbortController(), pendingCommands: [], startedAt: Date.now() };
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
    source.openingTimer = setTimeout(() => transportFailed(source, "welcome timed out"), 15_000);
    if (source.transport === "sse") { void receiveSse(source); return; }
    source.socket.onmessage = event => {
      try {
        handleMessage(source, event.data);
      } catch (error) {
        console.error("Live WebSocket message failed", error);
        transportFailed(source, "invalid live message");
      }
    };
    source.socket.onclose = event => transportFailed(source, `socket closed (${event?.code ?? 0})`);
    source.socket.onerror = () => transportFailed(source, "socket error");
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
  window.addEventListener("offline", () => {
    if (connection) disconnect(connection);
    else scheduleReconnect();
  });
  window.addEventListener("focus", () => resume(Date.now() - lastMessageAt > (connection?.heartbeatIntervalMs ?? 30_000)));
  document.addEventListener("visibilitychange", () => document.hidden ? pause() : resume(true));

  const client: KintsugiCableClient = {
    ready() { return connection?.connectionId !== undefined && !shellUnavailable(); },
    reconnect() {
      if (document.hidden) return;
      closingForPageHide = false;
      if (connection) disconnect(connection);
      resume();
    },
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
          if (connection) settled(connection);
          changed();
          if (subscription.subscriptionId) {
            sendRaw({ command: "unsubscribe", identifier: subscription.identifier, subscriptionId: subscription.subscriptionId });
          }
        },
      };
      subscription.leases.add(lease);
      if (subscription.status === "ready") {
        const subscriptionId = subscription.subscriptionId;
        requestAnimationFrame(() => {
          if (subscription.leases.has(lease) && desired.get(key) === subscription && subscription.status === "ready" && subscription.subscriptionId === subscriptionId) {
            notifyLease(() => lease.options?.onReady?.());
          }
        });
      }
      return lease;
    },
  };

  return client;
}
