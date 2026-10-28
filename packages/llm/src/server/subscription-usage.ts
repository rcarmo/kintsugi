import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

export interface ReportedAllowance {
  quotaId: string;
  sourceQuotaId: string | null;
  label: string;
  unit: "requests" | "credits" | "completions" | "unknown";
  selected: boolean;
  entitlement: number | null;
  remaining: number | null;
  remainingPercent: number | null;
  remainingPercentSource: "reported" | "quantity-estimate" | "unknown";
  unlimited: boolean;
  overageCount: number | null;
  overagePermitted: boolean | null;
  /** Absolute AI credits consumed this period; token-billed seats report it without an allowance. */
  creditsUsed: number | null;
  resetsAt: string | null;
}

export type SubscriptionUsage = {
  plan: string | null;
  checkedAt: string;
  allowed: boolean | null;
  limitReached: boolean | null;
  credits?: { unlimited: boolean; balance: string | null };
  resets?: { available: number };
  /** Prepaid money rather than allowance windows; amounts are in currency units. */
  balance?: { currency: string; available: number; monthSpend: number | null };
  /** Provider facts outside allowance windows, including extra-usage availability. */
  details?: { label: string; value: string }[];
  /** Account snapshots, distinct from per-call charges or session usage. */
  allowances?: ReportedAllowance[];
  windows: { periodBasis?: "calendar-month-estimate"; limitName: string; meteredFeature: string | null; kind: "primary" | "secondary"; usedPercent: number; durationSeconds: number | null; resetsAt: string | null; limitReached?: boolean }[];
};

/** Expected provider/authentication failures that can be shown in the usage overview. */
export class SubscriptionUsageError extends Error {
  /** Seconds the provider asked us to wait before asking again, when it said. */
  constructor(message: string, readonly retryAfterSeconds: number | null = null) { super(message); }
}

/** Parse external reset dates consistently, without local-time or rolled-calendar guesses. */
export function parseSubscriptionUsageDate(value: string | undefined | null, invalid: string): Date | null {
  if (value == null) return null;
  // Date-only values are UTC. Reject timezone-less timestamps rather than using host time.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) throw new SubscriptionUsageError(invalid);
  const calendarDate = value.slice(0, 10);
  const day = new Date(`${calendarDate}T00:00:00Z`);
  // JavaScript rolls e.g. February 30 into March, including in full timestamps.
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== calendarDate) throw new SubscriptionUsageError(invalid);
  const reset = new Date(value);
  if (!Number.isFinite(reset.getTime())) throw new SubscriptionUsageError(invalid);
  return reset;
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export type SubscriptionUsageMessages = {
  unreachable: string;
  rejected: string;
  unavailable: (status: number) => string;
  invalid: string;
  unrecognized: string;
};

/** The usual wording for a provider whose usage endpoint reports subscription usage. */
export function subscriptionUsageMessages(provider: string, reconnect: string = provider): SubscriptionUsageMessages {
  return {
    unreachable: `Could not reach ${provider} to check subscription usage. Try again.`,
    rejected: `${provider} rejected the credentials. Reconnect ${reconnect}.`,
    unavailable: (status) => `${provider} usage is unavailable (HTTP ${status}). Try again later.`,
    invalid: `${provider} returned an invalid usage response.`,
    unrecognized: `${provider} returned an unrecognized usage response.`,
  };
}

export async function requestSubscriptionUsage(url: string, init: RequestInit, unreachable: string, fetcher: Fetcher): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000), redirect: "error" });
  } catch {
    throw new SubscriptionUsageError(unreachable);
  }
}

export async function readSubscriptionUsageJson<Schema extends TSchema>(response: Response, schema: Schema, messages: Pick<SubscriptionUsageMessages, "invalid" | "unrecognized">): Promise<Static<Schema>> {
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new SubscriptionUsageError(messages.invalid); }
  if (!Value.Check(schema, payload)) throw new SubscriptionUsageError(messages.unrecognized);
  return payload;
}

export async function fetchSubscriptionUsageJson<Schema extends TSchema>(url: string, init: RequestInit, schema: Schema, messages: SubscriptionUsageMessages, fetcher: Fetcher): Promise<Static<Schema>> {
  const response = await requestSubscriptionUsage(url, init, messages.unreachable, fetcher);
  if (response.status === 401) throw new SubscriptionUsageError(messages.rejected);
  if (!response.ok) throw new SubscriptionUsageError(messages.unavailable(response.status));
  return await readSubscriptionUsageJson(response, schema, messages);
}
