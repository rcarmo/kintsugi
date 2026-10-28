import { disclosureHtml } from "@kintsugi/design-system/disclosure";
import { response } from "@kintsugi/shared/http";
import { requestAcceptsJson } from "@kintsugi/core";
import { providerUsageFrameId, providersInLastInferenceWindow, selectSubscriptionLimit, estimatedTimeToHitLimitSeconds, type PacedUsageWindow, connectedUsageProviders, getProviderUsageOverview, supportedUsageProviders, type ProviderUsageOverview, type ReportedAllowance } from "@kintsugi/llm/server";
import { actionLinkHtml } from "@kintsugi/design-system/action-link";
import { comparisonRingHtml } from "@kintsugi/design-system/comparison-ring";
import { helpTipHtml } from "@kintsugi/design-system/help-tip";
import { Icons } from "@kintsugi/design-system/icons";
import { escapeHtml, turboStream, turboStreamResponse } from "@kintsugi/shared";

function jsonResponse<Body extends object>(body: Body, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export function renderUsagePaneAction(): string {
  const button = usageButtonHtml();
  const actions = [
    "kintsugi:usage:refreshed@document->usage-button#refresh",
    "visibilitychange@document->usage-button#refresh",
    "focus@window->usage-button#refresh",
  ].join(" ");
  return `<span data-controller="usage-button" data-action="${actions}"><template data-usage-button-target="empty">${button}</template><turbo-frame id="usage_button_content">${button}</turbo-frame></span>`;
}
const number = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 });
const allowanceNumber = (value: number) => value.toLocaleString("en-US", { maximumSignificantDigits: 12 });

/** Two compact units for allowance windows, reset countdowns, and pacing gaps. */
function usageDuration(seconds: number | null): string {
  if (seconds === null) return "Unknown period";
  let remaining = Math.max(0, Math.floor(seconds));
  const parts: string[] = [];
  for (const [size, suffix] of [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]] as const) {
    const count = Math.floor(remaining / size);
    remaining %= size;
    if (count) parts.push(`${count}${suffix}`);
    if (parts.length === 2) break;
  }
  return parts.join(" ") || "0s";
}

/** Display the schedule distance, not a prediction of allowance exhaustion. */
function usagePace(seconds: number | null): string {
  if (seconds === null) return "";
  if (Math.abs(seconds) < 1) return "On pace";
  return `${usageDuration(Math.abs(seconds))} ${seconds > 0 ? "ahead of" : "behind"} pace`;
}

function renderUsageWindow(paced: PacedUsageWindow, allowance?: ReportedAllowance): string {
  const { reported: window, timing } = paced;
  const inferred = window.periodBasis === "calendar-month-estimate";
  const label = window.durationSeconds === null ? window.limitName : `${window.limitName} · ${usageDuration(window.durationSeconds)}${inferred ? " (estimated)" : ""}`;
  const remaining = window.resetsAt === null ? null : (new Date(window.resetsAt).getTime() - Date.now()) / 1000;
  const reset = remaining === null ? "Reset time unavailable" : remaining > 0 ? `Resets in ${usageDuration(remaining)}` : "Reported reset has passed";
  const difference = timing.paceDifferenceSeconds;
  const pace = difference === null ? "—" : Math.abs(difference) < 1 ? "on pace" : `${usageDuration(Math.abs(difference))} ${difference > 0 ? "ahead" : "behind"}`;
  const estimatedTimeToHitLimitSecondsValue = estimatedTimeToHitLimitSeconds(paced);
  const estimatedTimeToHitLimit = window.usedPercent >= 100 ? "Already exhausted" : timing.state !== "active" || (timing.elapsedPercent === 0 && window.usedPercent > 0 && window.usedPercent < 100)
    ? "Unavailable" : estimatedTimeToHitLimitSecondsValue === Infinity ? "Not before reset at this rate" : usageDuration(estimatedTimeToHitLimitSecondsValue);
  // Expired/future periods are not a pacing reference for current consumption. In particular,
  // a full expired time track must never obscure a partially used allowance.
  const elapsed = timing.state === "active" ? timing.elapsedPercent : null;
  return `<article class="usage-limit${allowance ? " usage-limit--allowance" : ""}">
    <div class="usage-limit-title"><h3>${escapeHtml(label)}</h3>
      ${elapsed === null ? usageBarHtml(window.usedPercent) : `<div class="usage-comparison" aria-hidden="true">
        <span class="usage-comparison__time" style="width:${elapsed}%"></span>
        <span class="usage-comparison__usage" style="width:${Math.min(100, window.usedPercent)}%"></span>
        <span class="usage-comparison__shared" style="width:${Math.min(elapsed, window.usedPercent)}%"></span>
      </div>`}
    </div>
    ${allowance ? renderAllowanceDetails(allowance) : ""}
    <div class="usage-metrics usage-caption" tabindex="0" role="group" aria-label="Limit metrics">
      <div class="usage-metrics-row">
      <span>Period elapsed${inferred ? " (est.)" : ""} ${elapsed === null ? "Unknown" : `${number(elapsed)}%`} ${helpTipHtml({ label: "What is period elapsed?", text: inferred ? "For pacing, we assume a one-month period ending at the reported reset. The provider does not supply the period start, so the elapsed time is estimated." : "How much of this allowance period has passed, based on its reset time and duration." })}</span>
      <span>Allowance used ${number(window.usedPercent)}% ${helpTipHtml({ label: "What is allowance used?", text: allowance ? `${allowance.remainingPercentSource === "reported" ? "Based on GitHub’s remaining percentage, which may be rounded." : "Estimated from the allowance quantities GitHub returned."} Includes usage across tools and sessions, not this agent’s token usage or a dollar charge.` : "The share of this account allowance used across tools and sessions. It is not this agent’s token usage or a dollar charge." })}</span>
      <span title="${escapeHtml(window.resetsAt ?? "Reset time not reported")}">${reset}</span>
      </div>
      <div class="usage-metrics-row">
      <span>Allowance runs out (est.): ${estimatedTimeToHitLimit} ${helpTipHtml({ label: "How is allowance exhaustion estimated?", text: "Projects when the included allowance would be used up at the average rate so far. It stops at the next reset. Other tools can change that rate, and permitted overage may let you continue after exhaustion." })}</span>
      <span>Pace ${pace} ${helpTipHtml({ label: "What is pace?", text: "Compares allowance usage with spending it evenly over the period. Ahead means faster spending; behind means slower spending. This is a schedule comparison, not time until access is blocked." })}</span>
      </div>
    </div>
  </article>`;
}

/** Usage alone, for allowances whose period can't be placed on a schedule. */
function usageBarHtml(usedPercent: number): string {
  return `<div class="usage-comparison" aria-hidden="true"><span class="usage-comparison__usage" style="width:${Math.max(0, Math.min(100, usedPercent))}%"></span></div>`;
}

function hasCreditSignal(allowance: ReportedAllowance): boolean {
  return allowance.creditsUsed !== null && (allowance.creditsUsed > 0 || allowance.unit === "credits" || allowance.quotaId.startsWith("premium_") && (allowance.unlimited || allowance.entitlement === 0));
}

function reportedCreditAllowance(reported: ProviderUsageOverview["reported"]): ReportedAllowance | undefined {
  const selected = reported?.allowances?.find((allowance) => allowance.selected);
  return selected && hasCreditSignal(selected) ? selected : reported?.allowances?.find(hasCreditSignal);
}

function creditsUsedCaption({ creditsUsed }: ReportedAllowance): string {
  return creditsUsed === null ? "" : `<p class="usage-caption">Credits used this period: ${allowanceNumber(creditsUsed)}</p>`;
}

function renderAllowanceDetails(allowance: ReportedAllowance): string {
  const { remaining, entitlement, unit, unlimited, overageCount, overagePermitted } = allowance;
  // GitHub reports 0 credits on most request-billed seats too; only show the counter when it says something.
  const credits = hasCreditSignal(allowance) ? creditsUsedCaption(allowance) : "";
  if (unlimited) return `${credits}${overageCount !== null && overageCount > 0 ? `<p class="usage-caption">Reported additional usage: ${allowanceNumber(overageCount)}</p>` : ""}`;
  const quantity = remaining !== null && remaining >= 0 && entitlement !== null && entitlement >= 0
    ? `<p class="usage-caption">Remaining ${allowanceNumber(remaining)} of ${allowanceNumber(entitlement)}${unit === "unknown" ? "" : ` ${unit}`} ${helpTipHtml({ label: "What does remaining mean?", text: "The quantity GitHub reported for this account allowance. It is not reconstructed from a rounded percentage or attributed to this session." })}</p>` : "";
  const policy = overagePermitted === null ? "Overage policy not reported" : overagePermitted ? "Overage permitted" : "Overage not permitted";
  const extra = overageCount === null ? "" : ` · Additional usage reported: ${allowanceNumber(overageCount)}${unit === "unknown" ? "" : ` ${unit}`}`;
  const exhausted = allowance.entitlement !== 0 && allowance.remainingPercent === 0 ? '<p class="usage-caption">Included allowance exhausted.</p>' : "";
  return `${quantity}${credits}${exhausted}<p class="usage-caption">${policy}${extra} ${helpTipHtml({ label: "What is overage?", text: "Usage beyond the included allowance. GitHub’s permission is separate from the balance; extra charges or other limits may still apply. Reported additional usage is not added to the allowance percentage." })}</p>`;
}

function renderCopilotAllowances({ reported, windows }: Pick<ProviderUsageOverview, "reported" | "windows">): string {
  if (!reported) return "";
  const allowances = reported.allowances ?? [];
  const render = (allowance: ReportedAllowance) => {
    const paced = windows.find(({ reported: window }) => window.meteredFeature === allowance.quotaId);
    if (paced) return renderUsageWindow(paced, allowance);
    const status = allowance.unlimited ? "Unlimited" : allowance.entitlement === 0 ? "Included allowance: 0" : allowance.remainingPercent === null ? "Usage not reported" : `Allowance used ${number(100 - allowance.remainingPercent)}%`;
    const reset = allowance.unlimited ? "" : allowance.resetsAt === null ? "Reset not reported" : `Reported reset: ${allowance.resetsAt.replace("T", " ").replace(".000Z", " UTC")}`;
    const bar = allowance.unlimited || allowance.entitlement === 0 || allowance.remainingPercent === null ? "" : usageBarHtml(100 - allowance.remainingPercent);
    return `<article class="usage-limit"><div class="usage-limit-title"><h3>${escapeHtml(allowance.label)}</h3>${bar}</div><p class="usage-caption">${status}</p>${renderAllowanceDetails(allowance)}${reset ? `<p class="usage-caption">${escapeHtml(reset)}</p>` : ""}</article>`;
  };
  const selected = allowances.filter((allowance) => allowance.selected);
  const others = allowances.filter((allowance) => !allowance.selected);
  const checked = reported.checkedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return `<p class="usage-caption">Account allowance · Checked ${escapeHtml(checked)} ${helpTipHtml({ label: "What does account allowance cover?", text: "The account snapshot returned by GitHub, including usage from other IDEs, CLI sessions and agents. Checked is when we fetched it; GitHub’s counters may lag. This is separate from session tokens and per-call billing." })}</p>${selected.length ? selected.map(render).join("") : '<p class="usage-caption">Primary allowance not reported.</p>'}${others.length ? disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: "Other reported allowances" } }, bodyHtml: others.map(render).join("") }) : ""}`;
}

function shownUsageWindows(windows: PacedUsageWindow[]) {
  return {
    used: windows.filter(({ reported }) => reported.usedPercent > 0),
    unused: windows.filter(({ reported }) => reported.usedPercent === 0 && reported.meteredFeature !== "chatpass"),
  };
}

/** A limit of its own, like one model's weekly cap, can run out while the rest of the subscription still works. */
function limitReachedHtml(reported: NonNullable<ProviderUsageOverview["reported"]>): string {
  if (reported.limitReached || reported.allowed === false) return '<p class="usage-error" role="status">Subscription limit reached.</p>';
  const reached = [...new Set(reported.windows.filter((window) => window.limitReached).map((window) => window.limitName))];
  return reached.length ? `<p class="usage-error" role="status">${escapeHtml(reached.join(" and "))} limit reached. Other models still work.</p>` : "";
}

/** A failed usage check says nothing about whether the provider's models work, so it reads as a note, not an alert. */
function renderUsageLimits({ reported, error, windows }: ProviderUsageOverview): string {
  if (error) return `<div class="usage-unavailable" role="status"><p>Couldn’t check usage limits. This only affects the usage shown here; models may still work fine.</p><p class="usage-caption">${escapeHtml(error)}</p></div>`;
  if (!reported) return "<p>Disconnected.</p>";
  if (reported.allowances) return renderCopilotAllowances({ reported, windows });
  const { used, unused } = shownUsageWindows(windows);
  return `${limitReachedHtml(reported)}${used.map((window) => renderUsageWindow(window)).join("")}${unused.length ? disclosureHtml({ summary: { kind: "compact", label: { kind: "text", text: `Unused limits (${unused.length})` } }, open: !used.length, bodyHtml: `<div class="usage-section">${unused.map((window) => renderUsageWindow(window)).join("")}</div>` }) : ""}${(reported.details ?? []).map(detail => `<p class="usage-caption">${escapeHtml(detail.label)}: ${escapeHtml(detail.value)}</p>`).join("")}${used.length || unused.length || reported.balance ? "" : '<p>No limits reported.</p>'}`;
}

function money(amount: number, currency: string): string {
  return amount.toLocaleString("en-US", { style: "currency", currency });
}

function renderUsageAccount({ reported, error }: ProviderUsageOverview): string {
  if (!reported || error) return "";
  const { credits, resets, balance } = reported;
  const rows: string[] = [];
  if (balance) {
    rows.push(`<div class="usage-limit-heading"><dt>Available credit</dt><dd><strong>${money(balance.available, balance.currency)}</strong></dd></div>`);
    if (balance.monthSpend !== null) rows.push(`<div class="usage-limit-heading"><dt>Spent this month</dt><dd><strong>${money(balance.monthSpend, balance.currency)}</strong></dd></div>`);
  }
  if (resets) rows.push(`<div class="usage-limit-heading"><dt>Available resets</dt><dd><strong>${number(resets.available)}</strong></dd></div>`);
  if (credits) rows.push(`<div class="usage-limit-heading"><dt>Credit balance</dt><dd><strong>${credits.unlimited ? "Unlimited" : credits.balance !== null ? Number(credits.balance).toLocaleString("en-US", { maximumFractionDigits: 0 }) : "Not reported"}</strong></dd></div>`);
  if (!rows.length) return "";
  return `<article class="usage-limit"><h3>${balance ? "Credits" : "Account allowance"}</h3><dl class="usage-account">${rows.join("")}</dl></article>`;
}

function usageWindowCaption(window: PacedUsageWindow["reported"]): string {
  const duration = window.durationSeconds === null ? null : usageDuration(window.durationSeconds).split(" ")[0]!;
  // The ring accepts at most three characters. Unknown or unusually long periods use the limit name.
  if (window.meteredFeature === null && duration !== null && duration.length <= 3) return duration;
  const characters = Array.from(window.limitName);
  const name = characters.slice(0, 2).join("");
  return name.length <= 3 ? name : characters[0] ?? "";
}

/** Prepaid providers show their balance instead. One small ring per limit: its length for main allowances ("5h"), the first letters of a feature's name ("Op") otherwise. */
function renderUsageRings({ provider, reported, error, windows }: ProviderUsageOverview, scope: string): string {
  const { used, unused } = shownUsageWindows(windows);
  const rings = reported && !error ? [...used, ...unused].map(({ reported: window, timing }) => comparisonRingHtml({
    caption: usageWindowCaption(window),
    referencePercent: timing.state === "active" ? timing.elapsedPercent : 0,
    valuePercent: Math.min(100, window.usedPercent),
    label: `${window.limitName} · ${usageDuration(window.durationSeconds)}: ${timing.state !== "active" ? "Pacing unavailable" : `Period elapsed${window.periodBasis ? " (est.)" : ""} ${number(timing.elapsedPercent)}%`}, Allowance used ${number(window.usedPercent)}%`,
  })).join("") : "";
  const selectedAllowance = reported?.allowances?.find((allowance) => allowance.selected);
  const creditAllowance = reportedCreditAllowance(reported);
  const creditsUsed = creditAllowance?.creditsUsed ?? null;
  const allowanceStatus = creditsUsed !== null ? `${allowanceNumber(creditsUsed)} credits used` : selectedAllowance?.unlimited ? "Unlimited" : selectedAllowance?.entitlement === 0 ? "No included allowance" : "Usage not reported";
  const balance = reported?.balance && !error ? `<span class="usage-caption">${money(reported.balance.available, reported.balance.currency)} left</span>` : "";
  return `<turbo-frame class="usage-rings" id="${providerUsageFrameId("rings", provider.id, scope)}">${rings || balance || (reported?.allowances && !error ? `<span class="usage-caption">${allowanceStatus}</span>` : "") || `<span class="usage-caption"${error ? ` title="${escapeHtml(error)}"` : ""}>Usage unavailable</span>`}</turbo-frame>`;
}

/** Refresh the card's rings from the same snapshot as its expanded limits. */
function renderUsageProviderLimits(overview: ProviderUsageOverview, scope: string): string {
  return `<turbo-frame id="${providerUsageFrameId("limits", overview.provider.id, scope)}"><section class="usage-section" data-controller="usage-snapshot">${renderUsageLimits(overview)}${renderUsageAccount(overview)}</section>${turboStream("replace", providerUsageFrameId("rings", overview.provider.id, scope), renderUsageRings(overview, scope))}</turbo-frame>`;
}

/** Opens the Models dialog, with the provider whose limit the ring shows already open. */
function usageButtonHtml(comparison?: { referencePercent: number; valuePercent: number }, label = "Usage", caption?: string, provider?: string): string {
  const iconHtml = caption === undefined ? Icons.Usage : `<span class="comparison-ring__caption">${escapeHtml(caption)}</span>`;
  const href = provider ? `/models?focus=${encodeURIComponent(provider)}` : "/models";
  return actionLinkHtml({ href, variant: "secondary", content: { kind: "icon-only", iconHtml, label }, perimeterComparison: comparison, attributesHtml: 'data-turbo-stream="true"' });
}

async function renderUsageButton(): Promise<string> {
  const activity = providersInLastInferenceWindow();
  if (!activity.length) return usageButtonHtml(undefined, "Usage — no subscription inference recorded");
  const overviews = await Promise.all(supportedUsageProviders.filter((provider) => activity.includes(provider.id)).map((provider) => getProviderUsageOverview(provider)));
  const selected = selectSubscriptionLimit(overviews);
  if (!selected) {
    // Pacing may be unavailable while the account still reports real consumption. Keep it visible.
    const unpaced = overviews.flatMap((overview) => overview.windows.map((window) => ({ provider: overview.provider, window }))).filter(({ window }) => window.reported.meteredFeature !== "chatpass" || window.reported.usedPercent > 0).sort((a, b) => b.window.reported.usedPercent - a.window.reported.usedPercent)[0];
    if (unpaced) return usageButtonHtml({ referencePercent: 0, valuePercent: Math.min(100, unpaced.window.reported.usedPercent) }, `Usage — ${unpaced.provider.label}: Allowance used ${number(unpaced.window.reported.usedPercent)}% · Pacing unavailable`, usageWindowCaption(unpaced.window.reported), unpaced.provider.id);
    const creditOverview = overviews.find((overview) => reportedCreditAllowance(overview.reported));
    if (creditOverview) {
      const allowance = reportedCreditAllowance(creditOverview.reported)!;
      return usageButtonHtml(undefined, `Usage — ${creditOverview.provider.label}: ${allowanceNumber(allowance.creditsUsed!)} credits used this period · Percentage unavailable`, undefined, creditOverview.provider.id);
    }
    const unlimited = overviews.find((overview) => overview.reported?.allowances?.some((allowance) => allowance.selected && allowance.unlimited));
    return unlimited ? usageButtonHtml(undefined, `Usage — ${unlimited.provider.label}: Unlimited allowance`, undefined, unlimited.provider.id) : usageButtonHtml(undefined, "Usage — selected subscription limits unavailable");
  }
  const { provider, window: { reported, timing } } = selected;
  if (timing.state !== "active") throw new Error("Selected subscription limit must be active");
  const pace = usagePace(timing.paceDifferenceSeconds);
  return usageButtonHtml({ referencePercent: timing.elapsedPercent, valuePercent: Math.min(100, reported.usedPercent) }, `Usage — ${provider.label} · ${reported.limitName} ${usageDuration(reported.durationSeconds)}${reported.periodBasis ? " (estimated period)" : ""}: Period elapsed ${number(timing.elapsedPercent)}%, Allowance used ${number(reported.usedPercent)}% · ${pace} · Recently used subscriptions`, usageWindowCaption(reported), provider.id);
}

export async function handleUsageRequest(request: Request, url: URL): Promise<Response | undefined> {
  if (request.method !== "GET") return undefined;
  const json = requestAcceptsJson(request);
  const refresh = url.searchParams.has("refresh");
  if (url.pathname === "/usage/button") {
    const button = await renderUsageButton();
    return request.headers.get("accept")?.includes("text/vnd.turbo-stream.html")
      ? turboStreamResponse(turboStream("update", "usage_button_content", button))
      : response(`<turbo-frame id="usage_button_content">${button}</turbo-frame>`);
  }
  if (url.pathname === "/usage" && json) return jsonResponse({ providers: await Promise.all((await connectedUsageProviders()).map((provider) => getProviderUsageOverview(provider, { refresh }))) });
  // The bare provider URL is JSON only; its limits and rings frames are what Models panel cards embed.
  const match = url.pathname.match(/^\/usage\/providers\/([^/]+)(?:\/(limits|rings))?$/);
  if (!match || (!match[2] && !json)) return undefined;
  const provider = supportedUsageProviders.find((provider) => provider.id === match[1]);
  if (!provider) return jsonResponse({ error: { code: "unsupported_usage_provider", message: "Subscription usage is not supported for this provider." } }, 404);
  const overview = await getProviderUsageOverview(provider, { refresh });
  if (!match[2]) return jsonResponse(overview);
  // Each Models panel host names its scope so its frame ids match.
  const scope = url.searchParams.get("scope") ?? "";
  return response(match[2] === "limits" ? renderUsageProviderLimits(overview, scope) : renderUsageRings(overview, scope));
}
