/// <reference lib="dom" />

import { decodeCableServerMessage, encodeCableClientMessages, liveRegionDigestsSchema, liveShownAttribute, serializeCableIdentifier, type KintsugiCableClient, type CableClientMessage, type CableIdentifier, type CableSubscription, type CableSubscriptionOptions, type WorkspaceVisibilityReport } from "@kintsugi/shared";
import { Value } from "typebox/value";

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
  /** Until a snapshot is applied, the page still shows this element's server render. */
  shownIn?: Element;
};

type LiveConnection = {
  socket: WebSocket;
  pendingCommands: CableClientMessage[];
  connectionId?: string;
  openingTimer?: ReturnType<typeof setTimeout>;
};

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
    if (connection && Date.now() - lastMessageAt > 75_000) disconnect(connection);
  }, 15_000);

  function changed(): void { document.dispatchEvent(new Event("live:connection")); }

  function sendRaw(message: CableClientMessage): void {
    const source = connection;
    if (!source?.connectionId || source.socket.readyState !== WebSocket.OPEN) return;
    source.pendingCommands.push(message);
    if (source.pendingCommands.length > 1) return;
    // Visibility and initial subscriptions share a bounded, ordered batch.
    queueMicrotask(() => {
      const messages = source.pendingCommands.splice(0);
      if (connection !== source) return;
      try {
        for (const body of encodeCableClientMessages(messages)) source.socket.send(body);
      } catch (error) {
        console.error("Live command could not be delivered", error);
        disconnect(source);
      }
    });
  }

  function subscribeOnWire(subscription: DesiredSubscription): void {
    const subscriptionId = crypto.randomUUID();
    subscription.status = "pending";
    subscription.subscriptionId = subscriptionId;
    changed();
    const message: Extract<CableClientMessage, { command: "subscribe" }> = { command: "subscribe", identifier: subscription.identifier, subscriptionId };
    const shown = subscription.shownIn?.getAttribute(liveShownAttribute);
    if (shown) message.shown = Value.Parse(liveRegionDigestsSchema, JSON.parse(shown));
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
        attempts = 0;
        sendRaw({ command: "visibility", visibility });
        resubscribeAll();
        break;
      case "confirm_subscription": {
        const subscription = matchingSubscription(message.identifier, message.subscriptionId);
        if (!subscription) break;
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
    source.socket.close();
    recovering = true;
    markSubscriptionsDisconnected(notify);
    changed();
    scheduleReconnect();
  }

  function connect(): void {
    if (connection || closingForPageHide || document.hidden || desired.size === 0) return;
    lastMessageAt = Date.now();
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/cable`);
    const source: LiveConnection = { socket, pendingCommands: [] };
    connection = source;
    source.openingTimer = setTimeout(() => disconnect(source), 15_000);
    socket.onmessage = event => {
      try {
        handleMessage(source, event.data);
      } catch (error) {
        console.error("Live message could not be applied", error);
        disconnect(source);
      }
    };
    socket.onclose = () => disconnect(source);
    socket.onerror = () => disconnect(source);
  }

  function pause(): void {
    closingForPageHide = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (connection) disconnect(connection, false);
  }
  function resume(): void {
    closingForPageHide = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    connect();
  }
  window.addEventListener("pagehide", pause);
  window.addEventListener("pageshow", resume);
  window.addEventListener("online", () => {
    if (connection) disconnect(connection);
    resume();
  });
  document.addEventListener("visibilitychange", () => document.hidden ? pause() : resume());

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
