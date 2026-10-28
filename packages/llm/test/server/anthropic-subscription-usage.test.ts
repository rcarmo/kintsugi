import type { JsonObject } from "@kintsugi/core";
import { expect, test } from "bun:test";
import { anthropicUsageFromHeaders, createAnthropicUsageSource, fetchAnthropicAccountUsage, probeAnthropicSubscriptionUsage } from "../../src/server/anthropic-subscription-usage.ts";

const window = { utilization: 72, resets_at: "2026-09-03T12:00:00+00:00" };
const payload = { five_hour: window, seven_day: { ...window, utilization: 0 } };
const fetcher = (body: JsonObject, status = 200) => async () => Response.json(body, { status });

test("requests Claude account usage with OAuth and reads every window it names", async () => {
  const windows = await fetchAnthropicAccountUsage("secret", async (url, init) => {
    expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ ...payload, seven_day_sonnet: { ...window, utilization: 100 }, seven_day_opus: null, seven_day_oauth_apps: window, three_hour_new_model: window });
  });
  // The shortest window is the primary one, even when it's a new kind of window.
  expect(windows).toEqual([
    { limitName: "Claude", meteredFeature: null, kind: "secondary", usedPercent: 72, durationSeconds: 18000, resetsAt: "2026-09-03T12:00:00.000Z" },
    { limitName: "Claude", meteredFeature: null, kind: "secondary", usedPercent: 0, durationSeconds: 604800, resetsAt: "2026-09-03T12:00:00.000Z" },
    { limitName: "Sonnet", meteredFeature: "sonnet", kind: "secondary", limitReached: true, usedPercent: 100, durationSeconds: 604800, resetsAt: "2026-09-03T12:00:00.000Z" },
    { limitName: "Oauth apps", meteredFeature: "oauth_apps", kind: "secondary", usedPercent: 72, durationSeconds: 604800, resetsAt: "2026-09-03T12:00:00.000Z" },
    { limitName: "New model", meteredFeature: "new_model", kind: "primary", usedPercent: 72, durationSeconds: 10800, resetsAt: "2026-09-03T12:00:00.000Z" },
  ]);
});

test("null buckets are omitted but null resets preserve usage; unnamed or monetary entries aren't windows", async () => {
  const bucket = { utilization: 42, resets_at: null, limit_dollars: null, used_dollars: null, remaining_dollars: null, locked_reason: null };
  const windows = await fetchAnthropicAccountUsage("secret", fetcher({ five_hour: null, seven_day: bucket, extra_usage: { is_enabled: true, utilization: 50, monthly_limit: 1000 }, weekly: bucket }));
  expect(windows).toEqual([{ limitName: "Claude", meteredFeature: null, kind: "primary", usedPercent: 42, durationSeconds: 604800, resetsAt: null }]);
});

test("rejects malformed upstream usage rather than inventing values", async () => {
  for (const body of [[], { ...payload, five_hour: { ...window, utilization: -1 } }, { ...payload, seven_day: { ...window, resets_at: "tomorrow" } }, { ...payload, seven_day_opus: { utilization: "5", resets_at: null } }]) {
    // SAFETY: Malformed bodies are the point of this test.
    await expect(fetchAnthropicAccountUsage("secret", fetcher(body as JsonObject))).rejects.toThrow("unrecognized usage response");
  }
});

// Shapes below follow CodexBar's Claude OAuth fixtures (github.com/steipete/CodexBar).
test("unmetered buckets are skipped, exhausted ones stay full, and model-scoped weekly limits are added", async () => {
  const windows = await fetchAnthropicAccountUsage("secret", fetcher({
    five_hour: { utilization: 104, resets_at: window.resets_at }, seven_day: { utilization: 20, resets_at: window.resets_at },
    seven_day_oauth_apps: { utilization: null, resets_at: null }, seven_day_opus: { utilization: 3, resets_at: null },
    limits: [
      { kind: "session", group: "session", percent: 16, resets_at: window.resets_at, scope: null, is_active: true },
      { kind: "weekly_scoped", group: "weekly", percent: 5, resets_at: window.resets_at, scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 9, resets_at: null, scope: { model: { id: null, display_name: "Opus" } } },
      { kind: "weekly_scoped", group: "weekly", percent: 1, scope: { model: { id: "all-models", display_name: "All models" } } },
    ],
  }));
  expect(windows.map((entry) => `${entry.limitName} ${entry.usedPercent} ${entry.durationSeconds}`)).toEqual(["Claude 104 18000", "Claude 20 604800", "Opus 3 604800", "Fable 5 604800"]);
});

test("HTTP failures are actionable, carry retry-after, and don't leak response bodies", async () => {
  for (const status of [401, 403, 429, 500]) {
    await expect(fetchAnthropicAccountUsage("secret", fetcher({ secret: "private" }, status))).rejects.toThrow(status === 401 ? "Reconnect Anthropic" : `HTTP ${status}`);
  }
  const limited = await fetchAnthropicAccountUsage("secret", async () => Response.json({}, { status: 429, headers: { "retry-after": "3600" } })).catch((error) => error);
  expect(limited.retryAfterSeconds).toBe(3600);
});

test("network and invalid JSON failures are explicit", async () => {
  await expect(fetchAnthropicAccountUsage("secret", async () => { throw new Error("private"); })).rejects.toThrow("Could not reach Anthropic");
  await expect(fetchAnthropicAccountUsage("secret", async () => new Response("private"))).rejects.toThrow("invalid usage response");
});

// Real header shape from an OAuth /v1/messages response.
const unified = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.26",
  "anthropic-ratelimit-unified-5h-reset": "1790592600",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-7d-utilization": "0.05",
  "anthropic-ratelimit-unified-7d-reset": "1790856000",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
};
const checkedAt = new Date("2026-09-28T10:00:00.000Z");

test("unified rate limit headers become the main windows with an account-wide decision", () => {
  expect(anthropicUsageFromHeaders(new Headers(unified), checkedAt)).toEqual({
    plan: null, checkedAt: checkedAt.toISOString(), allowed: true, limitReached: false,
    windows: [
      { limitName: "Claude", meteredFeature: null, kind: "primary", usedPercent: 26, durationSeconds: 18000, resetsAt: "2026-09-28T10:50:00.000Z" },
      { limitName: "Claude", meteredFeature: null, kind: "secondary", usedPercent: 5, durationSeconds: 604800, resetsAt: "2026-10-01T12:00:00.000Z" },
    ],
  });
  const feature = anthropicUsageFromHeaders(new Headers({ ...unified, "anthropic-ratelimit-unified-7d_opus-utilization": "0.5", "anthropic-ratelimit-unified-2h-utilization": "0.1" }), checkedAt)!;
  expect(feature.windows.map(({ limitName, kind, durationSeconds, resetsAt }) => `${limitName} ${kind} ${durationSeconds} ${resetsAt}`).toSorted()).toEqual([
    "Claude primary 7200 null", "Claude secondary 18000 2026-09-28T10:50:00.000Z", "Claude secondary 604800 2026-10-01T12:00:00.000Z", "Opus secondary 604800 null",
  ]);
  const rejected = anthropicUsageFromHeaders(new Headers({ ...unified, "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-5h-utilization": "1" }), checkedAt)!;
  expect([rejected.allowed, rejected.limitReached, rejected.windows[0]!.usedPercent]).toEqual([false, true, 100]);
});

test("extra usage status shows as an account detail", () => {
  const extraUsage = (status?: string, reason?: string) => anthropicUsageFromHeaders(new Headers({
    ...unified,
    ...(status && { "anthropic-ratelimit-unified-overage-status": status }),
    ...(reason && { "anthropic-ratelimit-unified-overage-disabled-reason": reason }),
  }), checkedAt)!.details?.[0]?.value;
  expect(extraUsage()).toBeUndefined();
  // Real header shape from an account whose extra usage ran out of credits.
  expect(extraUsage("rejected", "out_of_credits")).toBe("Off, out of credits");
  expect(extraUsage("rejected")).toBe("Off");
  expect(extraUsage("allowed")).toBe("On");
  expect(extraUsage("allowed_warning")).toBe("On, nearly used up");
});

test("responses without unified headers carry no usage, malformed ones are rejected", () => {
  expect(anthropicUsageFromHeaders(new Headers({ "anthropic-ratelimit-requests-remaining": "10" }), checkedAt)).toBeNull();
  expect(anthropicUsageFromHeaders(new Headers({ ...unified, "anthropic-ratelimit-unified-status": "allowed_warning", "anthropic-ratelimit-unified-weekly-utilization": "x" }), checkedAt)!.allowed).toBe(true);
  for (const override of [{ "anthropic-ratelimit-unified-5h-utilization": "" }, { "anthropic-ratelimit-unified-5h-utilization": "-0.1" }, { "anthropic-ratelimit-unified-7d-reset": "soon" }]) {
    expect(() => anthropicUsageFromHeaders(new Headers({ ...unified, ...override }), checkedAt)).toThrow("unrecognized rate limit headers");
  }
});

test("the probe is a one-token OAuth message and reads limits even from limited responses", async () => {
  const usage = await probeAnthropicSubscriptionUsage("secret", "cheap-model", async (url, init) => {
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret");
    expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "cheap-model", max_tokens: 1 });
    return Response.json({ error: { type: "rate_limit_error" } }, { status: 429, headers: { ...unified, "anthropic-ratelimit-unified-status": "rejected" } });
  });
  expect(usage.limitReached).toBe(true);
  await expect(probeAnthropicSubscriptionUsage("secret", "cheap-model", fetcher({}, 401))).rejects.toThrow("Reconnect Anthropic");
  await expect(probeAnthropicSubscriptionUsage("secret", "cheap-model", fetcher({}, 529))).rejects.toThrow("HTTP 529");
  await expect(probeAnthropicSubscriptionUsage("secret", "cheap-model", async () => { throw new Error("private"); })).rejects.toThrow("Could not reach Anthropic");
});

function usageSource(accountUsage: () => Response = () => new Response(null, { status: 500 })) {
  let at = checkedAt.getTime();
  const calls: string[] = [];
  const source = createAnthropicUsageSource(async (url, init) => {
    calls.push(`${new URL(url).pathname} ${new Headers(init.headers).get("authorization")}`);
    return url.endsWith("/v1/messages") ? new Response("{}", { headers: unified }) : accountUsage();
  }, () => at);
  const read = (token = "secret", refresh = false) => source.usage(token, { model: "cheap-model", refresh });
  const probes = () => calls.filter((call) => call.startsWith("/v1/messages")).length;
  return { source, calls, read, probes, advance: (ms: number) => { at += ms; } };
}

test("asks Anthropic on the first read after start, then stays quiet however long it idles", async () => {
  const { read, calls, advance } = usageSource();
  const usage = await read();
  expect(usage.windows[0]!.usedPercent).toBe(26);
  expect(usage.checkedAt).toBe(checkedAt.toISOString());
  expect(calls.toSorted()).toEqual(["/api/oauth/usage Bearer secret", "/v1/messages Bearer secret"]);
  advance(40 * 60_000);
  await read();
  expect(calls).toHaveLength(2);
});

test("observed proxy traffic replaces the snapshot without asking Anthropic", async () => {
  const { source, read, calls } = usageSource();
  await read();
  source.observe(new Headers({ ...unified, "anthropic-ratelimit-unified-5h-utilization": "0.5" }));
  expect((await read()).windows[0]!.usedPercent).toBe(50);
  expect(calls).toHaveLength(2);
});

test("a passed reset, an explicit refresh, or a credential change asks again; concurrent reads share one probe", async () => {
  const { source, read, probes, advance } = usageSource();
  await Promise.all([read(), read(), read()]);
  expect(probes()).toBe(1);
  advance(50 * 60_000);
  await read();
  expect(probes()).toBe(2);
  await read("secret", true);
  expect(probes()).toBe(3);
  source.forget();
  await read("new");
  expect(probes()).toBe(4);
});

test("a probe started before a credential change doesn't become the new account's snapshot", async () => {
  const { source, read, probes } = usageSource();
  const pending = read("old");
  source.forget();
  await pending;
  await read("new");
  expect(probes()).toBe(2);
});

test("account usage only adds windows the headers lack, keeps them on failure, and honors retry-after", async () => {
  let accountResponse = () => Response.json({ ...payload, seven_day_sonnet: { utilization: 40, resets_at: "2026-10-01T12:00:00+00:00" } });
  const { read, calls, advance } = usageSource(() => accountResponse());
  const accountCalls = () => calls.filter((call) => call.startsWith("/api/oauth/usage")).length;
  const labels = async (refresh: boolean) => (await read("secret", refresh)).windows.map((window) => `${window.limitName} ${window.usedPercent}`);
  expect(await labels(false)).toEqual(["Claude 26", "Claude 5", "Sonnet 40"]);
  accountResponse = () => new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  expect(await labels(true)).toEqual(["Claude 26", "Claude 5", "Sonnet 40"]);
  expect(accountCalls()).toBe(2);
  advance(59 * 60_000);
  await labels(true);
  expect(accountCalls()).toBe(2);
  advance(60_000);
  await labels(true);
  expect(accountCalls()).toBe(3);
});

test("absent utilization and bad additive scoped entries do not discard known account windows", async () => {
  const windows = await fetchAnthropicAccountUsage("secret", fetcher({
    ...payload, seven_day_oauth_apps: { resets_at: null },
    limits: [
      { kind: "weekly_scoped", group: "weekly", percent: 5, resets_at: "bad", scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", group: "weekly", percent: 5, scope: { model: { id: "scope-all-models", display_name: "Everything" } } },
    ],
  }));
  expect(windows).toHaveLength(2);
});

test("invalid header periods and out-of-range reset epochs are safe usage errors", () => {
  for (const [key, value] of [
    ["anthropic-ratelimit-unified-0h-utilization", "0.13"],
    ["anthropic-ratelimit-unified-9999999999999999999999h-utilization", "0.13"],
    ["anthropic-ratelimit-unified-5h-reset", "9999999999999999"],
    ["anthropic-ratelimit-unified-5h-utilization", "1e308"],
  ]) {
    expect(() => anthropicUsageFromHeaders(new Headers({ ...unified, [key]: value }), checkedAt)).toThrow("unrecognized rate limit headers");
  }
});

test("a successful probe without usage headers reports missing limits, not HTTP 200 as an error", async () => {
  await expect(probeAnthropicSubscriptionUsage("secret", "model", async () => Response.json({}))).rejects.toThrow("did not report usage limits");
});

test("reset dates never depend on the host timezone or silently roll impossible calendar dates", async () => {
  for (const resets_at of ["2026-02-30T00:00:00Z", "2026-11-01T00:00:00"]) {
    await expect(fetchAnthropicAccountUsage("secret", fetcher({ five_hour: { utilization: 13, resets_at } }))).rejects.toThrow("unrecognized usage response");
  }
});

test("scoped model labels preserve the provider's name, including non-Latin characters", async () => {
  const windows = await fetchAnthropicAccountUsage("secret", fetcher({ limits: [{ kind: "weekly_scoped", group: "weekly", percent: 13, scope: { model: { display_name: "モデル 5.6" } } }] }));
  expect(windows[0]).toMatchObject({ limitName: "モデル 5.6", usedPercent: 13, durationSeconds: 7 * 86400 });
});

// Real limits[] shape from an account that had hit the Fable cap.
const scopedLimit = (displayName: string, percent: number) => ({
  kind: "weekly_scoped", group: "weekly", percent, severity: "critical", resets_at: "2026-10-30T21:59:59.766338+00:00",
  scope: { model: { id: null, display_name: displayName }, surface: null }, is_active: true,
});
const weekBucket = (utilization: number) => ({ utilization, resets_at: "2026-10-30T21:59:59.765981+00:00" });
const otherLimits = [
  { kind: "session", group: "session", percent: 7, severity: "normal", resets_at: "2026-10-26T17:59:59.765937+00:00", scope: null, is_active: false },
  { kind: "weekly_all", group: "weekly", percent: 53, severity: "normal", resets_at: "2026-10-30T21:59:59.765981+00:00", scope: null, is_active: false },
];

test("model-scoped weekly limits are windows named by their model; other limits[] kinds repeat the buckets", async () => {
  const windows = await fetchAnthropicAccountUsage("secret", fetcher({ ...payload, limits: [...otherLimits, scopedLimit("Fable", 100)] }));
  expect(windows.map(({ limitName, meteredFeature, usedPercent, durationSeconds }) => `${limitName} ${meteredFeature} ${usedPercent} ${durationSeconds}`)).toEqual([
    "Claude null 72 18000", "Claude null 0 604800", "Fable fable 100 604800",
  ]);
  expect(windows[2]!.resetsAt).toBe("2026-10-30T21:59:59.766Z");
  // Only the scoped cap that's used up is limited.
  expect(windows.map((window) => window.limitReached ?? false)).toEqual([false, false, true]);
  // Caps scoped to something other than a model are left out, not the whole response.
  const scopes: JsonObject["scope"][] = [null, "model", {}, { model: null, surface: "claude_code" }, { model: { id: "x" } }, { model: { id: "x", display_name: null } }, { model: { display_name: "" } }];
  const unnamed = scopes.map((scope) => ({ ...scopedLimit("Fable", 10), scope }));
  expect((await fetchAnthropicAccountUsage("secret", fetcher({ ...payload, limits: [...unnamed, scopedLimit("Fable", 100)] }))).map((window) => window.limitName))
    .toEqual(["Claude", "Claude", "Fable"]);
  // A model's name isn't what makes it a window.
  expect(await fetchAnthropicAccountUsage("secret", fetcher({ limits: [{ ...scopedLimit("Fable", 100), kind: "weekly_fable" }] }))).toEqual([]);
  // The fork skips malformed optional scoped entries, preserving valid account buckets.
  for (const limits of [{}, [null], [{ ...scopedLimit("Fable", 100), percent: "100" }], [{ ...scopedLimit("Fable", 100), resets_at: "soon" }]]) {
    expect((await fetchAnthropicAccountUsage("secret", fetcher({ ...payload, limits }))).map(window => window.limitName)).toEqual(["Claude", "Claude"]);
  }
});

test("abbreviated features get their model's name, unknown ones are capitalised", () => {
  const names = (features: string[]) => anthropicUsageFromHeaders(new Headers({ ...unified, ...Object.fromEntries(features.map((feature) => [`anthropic-ratelimit-unified-7d_${feature}-utilization`, "0.5"])) }), checkedAt)!
    .windows.filter((window) => window.meteredFeature !== null).map((window) => `${window.meteredFeature} ${window.limitName}`).toSorted();
  expect(names(["oi", "overage_included", "opus", "sonnet", "oauth_apps"])).toEqual(["oauth_apps Oauth apps", "oi Fable", "opus Opus", "overage_included Fable", "sonnet Sonnet"]);
});

const fableHeaders = {
  ...unified,
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d_oi-utilization": "1",
  "anthropic-ratelimit-unified-7d_oi-reset": "1790856000",
  "anthropic-ratelimit-unified-7d_oi-status": "rejected",
};

test("only Fable is limited when its cap alone ran out and the shared windows still allow use", () => {
  const usage = anthropicUsageFromHeaders(new Headers(fableHeaders), checkedAt)!;
  expect([usage.allowed, usage.limitReached]).toEqual([true, false]);
  expect(usage.windows.filter((window) => window.limitReached).map((window) => window.limitName)).toEqual(["Fable"]);
  const limited = (overrides: Record<string, string>) => {
    const headers = new Headers({ ...fableHeaders, ...overrides });
    for (const [name, value] of Object.entries(overrides)) if (value === "") headers.delete(name);
    return anthropicUsageFromHeaders(headers, checkedAt)!.limitReached;
  };
  expect(limited({ "anthropic-ratelimit-unified-5h-status": "allowed_warning" })).toBe(false);
  // A shared window that ran out, or none saying it's allowed, limits the whole account.
  expect(limited({ "anthropic-ratelimit-unified-7d-status": "rejected" })).toBe(true);
  expect(limited({ "anthropic-ratelimit-unified-5h-status": "" })).toBe(false);
  // Real responses can carry 7d usage without its status; used up, it limits the account.
  expect(limited({ "anthropic-ratelimit-unified-7d-status": "", "anthropic-ratelimit-unified-7d-utilization": "0.99" })).toBe(false);
  expect(limited({ "anthropic-ratelimit-unified-7d-status": "", "anthropic-ratelimit-unified-7d-utilization": "1" })).toBe(true);
  expect(limited({ "anthropic-ratelimit-unified-5h-status": "", "anthropic-ratelimit-unified-7d-status": "" })).toBe(true);
  expect(limited({ "anthropic-ratelimit-unified-7d-status": "unknown" })).toBe(true);
  expect(limited({ "anthropic-ratelimit-unified-7d_oi-status": "allowed" })).toBe(true);
  // Fable used up without saying so is still Fable's limit alone.
  const unsaid = new Headers(fableHeaders);
  unsaid.delete("anthropic-ratelimit-unified-7d_oi-status");
  const quiet = anthropicUsageFromHeaders(unsaid, checkedAt)!;
  expect([quiet.limitReached, quiet.windows.filter((window) => window.limitReached).map((window) => window.limitName)]).toEqual([false, ["Fable"]]);
});

function sourceWith(headers: Record<string, string>, account: JsonObject) {
  return createAnthropicUsageSource(async (url) => url.endsWith("/v1/messages") ? new Response("{}", { headers }) : Response.json(account), () => checkedAt.getTime());
}
const shown = async (source: ReturnType<typeof createAnthropicUsageSource>) => (await source.usage("secret", { model: "cheap-model", refresh: false })).windows
  .map((window) => `${window.limitName} ${window.usedPercent}${window.limitReached ? " reached" : ""}`);

test("the Fable header window takes the account endpoint's model name and shows once", async () => {
  expect(await shown(sourceWith(fableHeaders, { ...payload, limits: [...otherLimits, scopedLimit("Fable 5", 98)] }))).toEqual(["Claude 26", "Claude 5", "Fable 5 100 reached"]);
  // Opus's cap is Opus's own window, which leaves one cap for "7d_oi".
  expect(await shown(sourceWith(fableHeaders, { ...payload, limits: [scopedLimit("Fable 5", 98), scopedLimit("Opus", 40)] }))).toEqual(["Claude 26", "Claude 5", "Fable 5 100 reached", "Opus 40"]);
  // With several unknown caps it's unclear which one "7d_oi" is, so it keeps its own name.
  expect(await shown(sourceWith(fableHeaders, { ...payload, limits: [scopedLimit("Fable 5", 98), scopedLimit("Gizmo", 40)] }))).toEqual(["Claude 26", "Claude 5", "Fable 100 reached", "Fable 5 98", "Gizmo 40"]);
  // A single cap that belongs to another feature isn't Fable's, and that feature's window stays.
  expect(await shown(sourceWith(fableHeaders, { ...payload, seven_day_sonnet: weekBucket(41), limits: [scopedLimit("Sonnet", 40)] }))).toEqual(["Claude 26", "Claude 5", "Fable 100 reached", "Sonnet 41"]);
  expect(await shown(sourceWith(fableHeaders, { ...payload, limits: [scopedLimit("Opus", 40)] }))).toEqual(["Claude 26", "Claude 5", "Fable 100 reached", "Opus 40"]);
  // A dedicated bucket and its limits[] entry are the same window, used up when either says so.
  expect(await shown(sourceWith(unified, { ...payload, seven_day_opus: weekBucket(99.5), limits: [scopedLimit("Opus", 100)] }))).toEqual(["Claude 26", "Claude 5", "Opus 99.5 reached"]);
  // A header window that says it's allowed is, whatever the account endpoint rounds to.
  const allowedFable = { ...fableHeaders, "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-7d_oi-utilization": "0.995", "anthropic-ratelimit-unified-7d_oi-status": "allowed" };
  expect(await shown(sourceWith(allowedFable, { ...payload, limits: [scopedLimit("Fable", 100)] }))).toEqual(["Claude 26", "Claude 5", "Fable 99.5"]);
  expect(await shown(sourceWith(unified, { ...payload, seven_day_opus: weekBucket(100), limits: [scopedLimit("Opus", 99)] }))).toEqual(["Claude 26", "Claude 5", "Opus 100 reached"]);
  expect(await shown(sourceWith(unified, { ...payload, seven_day_opus: weekBucket(41), limits: [scopedLimit("Opus", 40), scopedLimit("Fable", 98)] }))).toEqual(["Claude 26", "Claude 5", "Opus 41", "Fable 98"]);
});

test("a cached account window is dropped once its reset passes while the endpoint is rate limited", async () => {
  let at = checkedAt.getTime();
  let account = () => Response.json({ limits: [{ ...scopedLimit("Fable", 100), resets_at: new Date(at + 60_000).toISOString() }] });
  const source = createAnthropicUsageSource(async (url) => url.endsWith("/v1/messages") ? new Response("{}", { headers: unified }) : account(), () => at);
  expect(await shown(source)).toEqual(["Claude 26", "Claude 5", "Fable 100 reached"]);
  account = () => new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  at += 2 * 60_000;
  expect(await shown(source)).toEqual(["Claude 26", "Claude 5"]);
});

test("the Fable window keeps its name while the account endpoint is rate limited", async () => {
  const source = createAnthropicUsageSource(async (url) => url.endsWith("/v1/messages") ? new Response("{}", { headers: fableHeaders }) : new Response(null, { status: 429, headers: { "retry-after": "300" } }), () => checkedAt.getTime());
  expect(await shown(source)).toEqual(["Claude 26", "Claude 5", "Fable 100 reached"]);
});

test("a reached account cap without reset timing doesn't pin an allowed header window", async () => {
  const allowedFable = { ...fableHeaders, "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-7d_oi-utilization": "0.4", "anthropic-ratelimit-unified-7d_oi-status": "allowed" };
  const stale = { ...scopedLimit("Fable", 100), resets_at: null };
  expect(await shown(sourceWith(allowedFable, { ...payload, limits: [stale] }))).toEqual(["Claude 26", "Claude 5", "Fable 40"]);
});

test("a used-up Fable header window without a status stays reached over the account endpoint's cap", async () => {
  const { "anthropic-ratelimit-unified-7d_oi-status": _status, ...unsaid } = fableHeaders;
  expect(await shown(sourceWith(unsaid, { ...payload, limits: [scopedLimit("Fable", 100)] }))).toEqual(["Claude 26", "Claude 5", "Fable 100 reached"]);
});

test("a bucket without reset timing doesn't stay reached past its limits[] entry's reset", async () => {
  let at = checkedAt.getTime();
  let account = () => Response.json({ seven_day_opus: { utilization: 99.5, resets_at: null }, limits: [{ ...scopedLimit("Opus", 100), resets_at: new Date(at + 60_000).toISOString() }] });
  const source = createAnthropicUsageSource(async (url) => url.endsWith("/v1/messages") ? new Response("{}", { headers: unified }) : account(), () => at);
  expect(await shown(source)).toEqual(["Claude 26", "Claude 5", "Opus 99.5 reached"]);
  account = () => new Response(null, { status: 429, headers: { "retry-after": "3600" } });
  at += 2 * 60_000;
  expect(await shown(source)).toEqual(["Claude 26", "Claude 5"]);
});
