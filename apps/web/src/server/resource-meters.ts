import { createLivePresentation, escapeHtml, formatBytes, type CableChannelSubscription } from "@kintsugi/shared";
import { inspectResourceCounters } from "@kintsugi/workspace";
import { resourceReading, unavailableResourceCounter, type ResourceReading } from "@kintsugi/core/resource-metrics";
import { resourceHistoryReading, resourceHistoryWindowMs, resourceMemoryHeadroom, type ResourceHistory, type ResourceHistorySnapshot } from "@kintsugi/core/resource-history";

import {createResourceMeterCollector, resourceMeterIntervalMs} from "./resource-meter-collector.ts";
export {resourceMeterIntervalMs};

const target = "workspace_resource_meter_readings";
const e = escapeHtml;
const empty = () => resourceReading(unavailableResourceCounter());
type ChartMetric = "cpu" | "memory" | "io";
const bytes = (value: number | null) => value === null ? "—" : formatBytes(Math.round(value));
const rate = (value: number | null) => value === null ? "—" : `${bytes(value)}/s`;
const ramBytes = (value: number | null) => value === null ? "—" : value >= 1_000_000_000 ? `${(value / 1_000_000_000).toFixed(2)} GB` : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)} MB` : bytes(value);

export function renderResourceMetersMount(): string {
  return `<section class="resource-meters" aria-label="Resource usage" data-controller="resource-meters"><div id="${target}">${renderResourceMeters(undefined)}</div></section>`;
}
function latestReading(history: ResourceHistory | undefined, at: number | undefined): ResourceReading {
  return resourceHistoryReading(history, at).reading;
}
function chartValue(reading: ResourceReading, metric: ChartMetric, write = false): number | null {
  if (metric === "cpu") return reading.cpuPercent;
  if (metric === "memory") return reading.memory === null || !reading.memoryLimit ? null : reading.memory / reading.memoryLimit * 100;
  return write ? reading.writePerSecond : reading.readPerSecond;
}
function chartHtml(history: ResourceHistory | undefined, metric: ChartMetric, at: number): string {
  const points = history?.points.filter(point => point.at >= at - resourceHistoryWindowMs && point.at <= at) ?? [];
  const maximum = metric === "io" ? Math.max(1024, ...points.flatMap(point => [point.reading.readPerSecond ?? 0, point.reading.writePerSecond ?? 0])) : 100;
  const ceiling = metric === "io" ? 2 ** Math.ceil(Math.log2(maximum)) : 100;
  function trace(write: boolean): string {
    const segments: string[][] = [];
    let segment: string[] = [];
    for (const point of points) {
      const value = chartValue(point.reading, metric, write);
      if (value === null) {
        if (segment.length) segments.push(segment);
        segment = [];
      }
      if (value === null) continue;
      const x = 2 + (1 - (at - point.at) / resourceHistoryWindowMs) * 116;
      const y = 25 - Math.min(1, Math.max(0, value / ceiling)) * 22;
      segment.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    if (segment.length) segments.push(segment);
    return segments.map(values => values.length === 1
      ? `<circle class="resource-meter-trace${write ? " resource-meter-trace--write" : ""}" cx="${values[0]!.split(",")[0]}" cy="${values[0]!.split(",")[1]}" r="1.5"/>`
      : `<polyline class="resource-meter-trace${write ? " resource-meter-trace--write" : ""}" points="${values.join(" ")}"/>`).join("");
  }
  const description = metric === "io" ? `Block I/O: read solid, write dashed; shared scale 0–${rate(ceiling)}.` : `${metric === "cpu" ? "CPU" : "Memory"} history, 0–100%; values above 100% clip at the chart ceiling.`;
  return `<svg class="resource-meter-chart resource-meter-chart--${metric}" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden="true"><title>${e(description)} Last 2.5 minutes; gaps mean no measurements.</title><path class="resource-meter-chart-grid" d="M2 3H118 M2 14H118 M2 25H118"/>${trace(false)}${metric === "io" ? trace(true) : ""}</svg>`;
}
function rowHtml(label: string, metric: ChartMetric, valueHtml: string, description: string, history: ResourceHistory | undefined, at: number): string {
  return `<div class="resource-meter-row" title="${e(description)}"><span class="resource-meter-label">${label}</span>${chartHtml(history, metric, at)}<span class="resource-meter-value">${valueHtml}</span></div>`;
}
function groupHtml(title: string, context: string, history: ResourceHistory | undefined, sampledAt: number | undefined, at: number, parked = false): string {
  const observed = resourceHistoryReading(history, sampledAt);
  const reading = parked ? empty() : observed.reading;
  const stale = !parked && observed.stale;
  const summary = stale ? `Stale · ${context}` : context;
  const detail = stale && observed.at !== undefined ? `${context}; last good reading ${new Date(observed.at).toLocaleTimeString()}` : context;
  const cpu = reading.cpuPercent === null ? "—" : `${reading.cpuPercent.toFixed(reading.cpuPercent < 1 ? 2 : 1)}%`;
  const memory = `<span class="resource-meter-memory-used">${e(ramBytes(reading.memory))}</span><span class="resource-meter-limit">Limit ${e(ramBytes(reading.memoryLimit))}</span>`;
  const plot = parked ? undefined : history;
  return `<section class="resource-meter-group" data-resource-stale="${stale}" aria-label="${e(title)} resource usage"><header><span>${e(title)}</span><span class="resource-meter-context" title="${e(detail)}">${e(summary)}</span></header>${rowHtml("CPU", "cpu", e(cpu), `CPU use as a percentage of ${reading.cpus ?? "available"} effective CPUs, including ancestor quotas and affinity. Chart scale 0–100%.`, plot, at)}${rowHtml("RAM", "memory", memory, "Used / effective RAM limit. Includes reclaimable cache; the limit is not a reservation. Chart scale 0–100%.", plot, at)}${rowHtml("I/O", "io", `<span class="resource-meter-read">Read ${e(rate(reading.readPerSecond))}</span><span class="resource-meter-write">Write ${e(rate(reading.writePerSecond))}</span>`, "Read (solid) / write (dashed), bytes per second. Sum of kernel device counters; layered storage may count I/O more than once. Not network traffic or disk space.", plot, at)}</section>`;
}
export function renderResourceMeters(state?: ResourceHistorySnapshot, workspace?: { id: string; title: string; parked: boolean }): string {
  const history = workspace ? state?.workspaces.get(workspace.id) : undefined;
  const selected = latestReading(history, state?.sampledAt);
  const workspaceStatus = workspace?.parked ? "Parked" : selected.state === "stopped" ? "Stopped" : selected.state === "unavailable" && state?.sampledAt ? "Unavailable" : "";
  const workspaceContext = workspace ? [workspaceStatus, workspace.title].filter(Boolean).join(" · ") : "None selected";
  const systemContext = state?.scope === "local" ? "Local cgroup totals" : "Installation totals";
  const system = latestReading(state?.system, state?.sampledAt);
  const hostAvailable = state?.hostMemoryAvailable ?? null;
  const at = state?.sampledAt ?? Date.now();
  const status = state?.failed ? "Retrying…" : state?.sampledAt ? `<time datetime="${e(new Date(state.sampledAt).toISOString())}" title="Last sample; refreshes about every 2.5 seconds">${e(new Date(state.sampledAt).toLocaleTimeString())}</time>` : "Reading…";
  const ram = `<dl class="resource-meter-ram"><div title="Unused System cgroup RAM: effective limit minus current usage, excluding any cache reclaim estimate. Not a reservation."><dt>RAM headroom</dt><dd>${e(ramBytes(resourceMemoryHeadroom(system)))}</dd></div><div title="Host Linux MemAvailable, including reclaimable cache. Shared with other workloads; not guaranteed available within the System cgroup limit."><dt>Host available</dt><dd>${e(ramBytes(hostAvailable))}</dd></div></dl>`;
  return `${groupHtml("Workspace", workspaceContext, history, state?.sampledAt, at, workspace?.parked)}${groupHtml("System", systemContext, state?.system, state?.sampledAt, at)}${ram}<div class="resource-meter-status"><span>2.5 min history</span><span class="resource-meter-status-slot">${status}</span></div>`;
}

/** Live presentation is independent of the app-owned collection lifecycle. */
export function createResourceMeters(options: {
  load?: typeof inspectResourceCounters;
  workspaceIds(): readonly string[];
  workspace(id: string): { id: string; title: string; parked: boolean } | undefined;
  onError(error: Error): void;
  intervalMs?: number;
}) {
  const collector = createResourceMeterCollector({...options, load: options.load ?? inspectResourceCounters});
  return {
    start: collector.start,
    stop: collector.stop,
    subscribe(workspaceId: string | undefined, listener: (html: string) => void): CableChannelSubscription {
      const presentation = createLivePresentation(() => [{ target, html: renderResourceMeters(collector.read(), workspaceId ? options.workspace(workspaceId) : undefined) }]);
      const subscription = presentation.subscribe(listener);
      const unwatch = collector.watch(() => presentation.invalidate());
      return { unsubscribe() {unwatch(); subscription.unsubscribe(); presentation.dispose();} };
    },
  };
}
