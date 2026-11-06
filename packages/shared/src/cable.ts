import type { JsonValue } from "@kintsugi/core";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { liveRegionDigestsSchema, type LiveRegionDigests } from "./live-region-digests.ts";

export interface CableSubscriptionOptions {
  /** Runs after the server's authoritative initial update has been applied to the DOM. */
  onReady?: () => void;
  /** Runs when a previously ready subscription loses its Cable connection. */
  onDisconnected?: () => void;
  onRejected?: (reason: string) => void;
  /** The server-rendered element this subscription continues. Its shown regions go with each subscribe until a snapshot is applied; a reconnect then gets a full snapshot. */
  shownIn?: Element;
}

const cableIdentifierSchema = Type.Union([
  Type.Object({ channel: Type.Literal("shell") }),
  Type.Object({ channel: Type.Literal("module"), name: Type.String({ minLength: 1 }), workspaceId: Type.String({ minLength: 1 }), params: Type.Record(Type.String(), Type.String()) }),
  Type.Object({ channel: Type.Literal("agent"), workspaceId: Type.String({ minLength: 1 }), agentId: Type.String({ minLength: 1 }) }),
  Type.Object({ channel: Type.Literal("agent-turn"), workspaceId: Type.String({ minLength: 1 }), agentId: Type.String({ minLength: 1 }), turnId: Type.String({ minLength: 1 }), branchId: Type.String({ minLength: 1 }) }),
]);

export const cableCommandBodyLimit = 64 * 1024;
export const cableCommandBatchLimit = 256;

const subscriptionIdSchema = Type.String({ minLength: 1 });

const workspaceVisibilitySchema = Type.Object({ workspaceId: Type.Optional(Type.String({ minLength: 1 })), surfaceKeys: Type.Array(Type.String({ minLength: 1 })) });
export type WorkspaceVisibilityReport = Static<typeof workspaceVisibilitySchema>;

const cableClientMessageSchema = Type.Union([
  Type.Object({ command: Type.Literal("visibility"), visibility: workspaceVisibilitySchema }),
  Type.Object({ command: Type.Literal("subscribe"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, shown: Type.Optional(liveRegionDigestsSchema) }),
  Type.Object({ command: Type.Literal("unsubscribe"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema }),
  Type.Object({ command: Type.Literal("pong"), time: Type.Optional(Type.Number()) }),
]);

const cableClientBatchSchema = Type.Array(cableClientMessageSchema, { minItems: 1, maxItems: cableCommandBatchLimit });

const cableServerMessageSchema = Type.Union([
  Type.Object({ type: Type.Literal("welcome"), connectionId: Type.String() }),
  Type.Object({ type: Type.Literal("confirm_subscription"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, html: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal("reject_subscription"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, reason: Type.String() }),
  Type.Object({ type: Type.Literal("turbo_stream"), identifier: cableIdentifierSchema, subscriptionId: subscriptionIdSchema, html: Type.String() }),
  Type.Object({ type: Type.Literal("ping"), time: Type.Number() }),
  Type.Object({ type: Type.Literal("error"), message: Type.String() }),
]);

export type CableIdentifier = Static<typeof cableIdentifierSchema>;
export type CableClientMessage = Static<typeof cableClientMessageSchema>;
export type CableServerMessage = Static<typeof cableServerMessageSchema>;

function parseJson(text: string, invalidJsonMessage: string): JsonValue {
  let encoded: JsonValue;
  try {
    encoded = JSON.parse(text);
  } catch {
    throw new Error(invalidJsonMessage);
  }
  return encoded;
}

export function decodeCableClientMessage(text: string): CableClientMessage {
  const encoded = parseJson(text, "cable message must be valid JSON");
  try {
    return Value.Parse(cableClientMessageSchema, Value.Clean(cableClientMessageSchema, encoded));
  } catch {
    throw new Error("unsupported cable message");
  }
}

/** Validate the whole batch before any command can change connection state. */
export function decodeCableClientMessages(text: string): CableClientMessage[] {
  const encoded = parseJson(text, "cable message must be valid JSON");
  const schema = Array.isArray(encoded) ? cableClientBatchSchema : cableClientMessageSchema;
  try {
    const decoded = Value.Parse(schema, Value.Clean(schema, encoded));
    return Array.isArray(decoded) ? decoded : [decoded];
  } catch {
    throw new Error("unsupported cable message");
  }
}

/** Ordered command bodies, bounded by the same byte and count limits as the server. */
export function encodeCableClientMessages(messages: readonly CableClientMessage[]): string[] {
  const bodies: string[] = [];
  const encoder = new TextEncoder();
  let batch: string[] = [];
  let bytes = 2; // JSON array brackets.
  const flush = (): void => {
    if (!batch.length) return;
    bodies.push(batch.length === 1 ? batch[0]! : `[${batch.join(",")}]`);
    batch = [];
    bytes = 2;
  };
  for (const message of messages) {
    const encoded = JSON.stringify(message);
    const size = encoder.encode(encoded).byteLength;
    if (size > cableCommandBodyLimit) throw new Error("Live command exceeds the request size limit");
    if (batch.length === cableCommandBatchLimit || (batch.length > 0 && bytes + 1 + size > cableCommandBodyLimit)) flush();
    bytes += size + (batch.length ? 1 : 0);
    batch.push(encoded);
  }
  flush();
  return bodies;
}

export function decodeCableServerMessage(text: string): CableServerMessage {
  const encoded = parseJson(text, "cable server message must be valid JSON");
  try {
    return Value.Parse(cableServerMessageSchema, Value.Clean(cableServerMessageSchema, encoded));
  } catch {
    throw new Error("unsupported cable server message");
  }
}

export interface CableSubscription {
  unsubscribe(): void;
}

export interface KintsugiCableClient {
  reportVisibility(visibility: WorkspaceVisibilityReport): void;
  subscribe(identifier: CableIdentifier, options?: CableSubscriptionOptions): CableSubscription;
  ready(): boolean;
  reconnect(): void;
}

function requireNonEmpty(value: string, message: string): string {
  if (!(value.length > 0)) throw new Error(message);
  return value;
}

export const CableTopics = {
  shell(): CableIdentifier { return { channel: "shell" }; },
  module(name: string, workspaceId: string, params: Record<string, string> = {}): CableIdentifier {
    return { channel: "module", name: requireNonEmpty(name, "channel name must not be empty"), workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"), params };
  },
  agentTurn(workspaceId: string, agentId: string, turnId: string, branchId: string): CableIdentifier {
    return {
      channel: "agent-turn",
      workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"),
      agentId: requireNonEmpty(agentId, "agent identifier must not be empty"),
      turnId: requireNonEmpty(turnId, "agent turn identifier must not be empty"),
      branchId: requireNonEmpty(branchId, "agent branch identifier must not be empty"),
    };
  },
  agent(workspaceId: string, agentId: string): CableIdentifier {
    return {
      channel: "agent",
      workspaceId: requireNonEmpty(workspaceId, "workspace identifier must not be empty"),
      agentId: requireNonEmpty(agentId, "agent identifier must not be empty"),
    };
  },
};

export function serializeCableIdentifier(identifier: CableIdentifier): string {
  switch (identifier.channel) {
    case "shell": return JSON.stringify(["shell"]);
    case "module": return JSON.stringify(["module", identifier.name, identifier.workspaceId, Object.entries(identifier.params).sort(([a], [b]) => a.localeCompare(b))]);
    case "agent-turn": return JSON.stringify([
      identifier.channel,
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.agentId, "agent identifier must not be empty"),
      requireNonEmpty(identifier.turnId, "agent turn identifier must not be empty"),
      requireNonEmpty(identifier.branchId, "agent branch identifier must not be empty"),
    ]);
    case "agent": return JSON.stringify([
      identifier.channel,
      requireNonEmpty(identifier.workspaceId, "workspace identifier must not be empty"),
      requireNonEmpty(identifier.agentId, "agent identifier must not be empty"),
    ]);
    default: throw new Error("unsupported cable identifier");
  }
}

export interface CableChannelSubscription {
  unsubscribe(): void;
}

/** The adapter validates its parameters and access before publishing its first snapshot.
 * Cable owns confirmation, cancellation races, incremental delivery and error reporting. */
export interface CableChannelAdapter {
  name: string;
  subscribe(identifier: CableIdentifier, listener: (html: string) => void, events: import("@kintsugi/core").KintsugiEventBus, shown?: LiveRegionDigests): CableChannelSubscription | Promise<CableChannelSubscription>;
}
