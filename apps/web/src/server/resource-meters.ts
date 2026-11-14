import { createLivePresentation, escapeHtml, formatBytes, type CableChannelSubscription } from "@kintsugi/shared";
import { comparisonRingHtml } from "@kintsugi/design-system/comparison-ring";
import { inspectResourceCounters } from "@kintsugi/workspace";
import { resourceReading, unavailableResourceCounter, type ResourceReading, type ResourceSnapshot } from "@kintsugi/core/resource-metrics";

const target = "workspace_resource_meter_readings";
export const resourceMeterIntervalMs = 2500;
const e = escapeHtml;
const empty = () => resourceReading(unavailableResourceCounter());
interface MeterState {
  scope: ResourceSnapshot["scope"];
  system: ResourceReading;
  workspaces: Map<string, ResourceReading>;
  sampledAt?: string;
  failed: boolean;
}
export function renderResourceMetersMount(): string {
  return `<section class="resource-meters" aria-label="Resource usage" data-controller="resource-meters"><div id="${target}">${renderResourceMeters(undefined)}</div></section>`;
}
function readingHtml(label: string, caption: string, value: string, percent: number | null, description: string): string {
  const bounded = Math.min(100, Math.max(0, percent ?? 0));
  const ring = percent === null ? `<span class="resource-meter-unavailable" aria-hidden="true">—</span>` : comparisonRingHtml({ caption, label: description, valuePercent: bounded, referencePercent: Math.min(80, bounded) });
  return `<div class="resource-meter-reading" title="${e(description)}">${ring}<span><span class="resource-meter-label">${label}</span><span class="resource-meter-value">${e(value)}</span></span></div>`;
}
function groupHtml(title: string, context: string, reading: ResourceReading): string {
  const cpu = reading.cpuPercent === null ? "—" : `${reading.cpuPercent.toFixed(1)}%`;
  const memory = reading.memory === null || !reading.memoryLimit ? "—" : `${formatBytes(reading.memory)} / ${formatBytes(reading.memoryLimit)}`;
  const percent = reading.memory === null || !reading.memoryLimit ? null : reading.memory / reading.memoryLimit * 100;
  const rate = (value: number | null) => value === null ? "—" : `${formatBytes(Math.round(value))}/s`;
  return `<section class="resource-meter-group" aria-label="${e(title)} resource usage"><header><span>${e(title)}</span><span class="resource-meter-context" title="${e(context)}">${e(context)}</span></header><div class="resource-meter-readings">${readingHtml("CPU", "CPU", cpu, reading.cpuPercent, `CPU use as a percentage of ${reading.cpus ?? "available"} effective CPUs; includes ancestor quotas and affinity.`)}${readingHtml("Memory", "RAM", memory, percent, "Memory includes reclaimable cache; the denominator is the effective cgroup limit, not a reservation.")}</div><div class="resource-meter-io" title="Sum of kernel cgroup device counters; layered storage can count I/O more than once. Not network traffic, disk space or buffered application writes."><span>Block I/O</span><span>Read ${e(rate(reading.readPerSecond))}</span><span>Write ${e(rate(reading.writePerSecond))}</span></div></section>`;
}
export function renderResourceMeters(state?: MeterState, workspace?: { id: string; title: string; parked: boolean }): string {
  const selected = workspace ? state?.workspaces.get(workspace.id) ?? empty() : empty();
  const workspaceStatus = workspace?.parked ? "Parked" : selected.state === "stopped" ? "Stopped" : selected.state === "unavailable" && state?.sampledAt ? "Unavailable" : "";
  const workspaceContext = workspace ? [workspace.title, workspaceStatus].filter(Boolean).join(" · ") : "None selected";
  const systemContext = state?.scope === "local" ? "Local cgroup totals" : "Installation totals";
  const status = state?.failed ? "Unavailable" : state?.sampledAt ? `<time datetime="${e(state.sampledAt)}" title="Last sample; refreshes about every 2.5 seconds">${e(new Date(state.sampledAt).toLocaleTimeString())}</time>` : "Reading…";
  return `${groupHtml("Workspace", workspaceContext, workspace?.parked ? empty() : selected)}${groupHtml("System", systemContext, state?.system ?? empty())}<div class="resource-meter-status">${status}</div>`;
}

/** One clock for all tabs. Requests/subscriptions never advance the CPU or I/O baseline. */
export function createResourceMeters(options: {
  load?: typeof inspectResourceCounters;
  workspace(id: string): { id: string; title: string; parked: boolean } | undefined;
  onError(error: Error): void;
  intervalMs?: number;
}) {
  const load = options.load ?? inspectResourceCounters;
  const interval = options.intervalMs ?? resourceMeterIntervalMs;
  const subscribers = new Set<{ workspaceId?: string; changed(): void }>();
  let state: MeterState | undefined;
  let previous: ResourceSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let collecting: AbortController | undefined;
  let generation = 0;

  async function tick(): Promise<void> {
    if (!subscribers.size || collecting) return;
    const epoch = generation;
    const abort = collecting = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 4000);
    const ids = [...new Set([...subscribers].flatMap(subscriber => subscriber.workspaceId ? [subscriber.workspaceId] : []))].slice(0, 32);
    try {
      const snapshot = await load(ids, abort.signal);
      if (generation !== epoch) return;
      abort.signal.throwIfAborted();
      state = { scope: snapshot.scope, sampledAt: new Date().toISOString(), failed: false,
        system: resourceReading(snapshot.system, previous?.system),
        workspaces: new Map(ids.map(id => [id, resourceReading(snapshot.workspaces[id] ?? unavailableResourceCounter(), previous?.workspaces[id])])),
      };
      previous = snapshot;
    } catch (error) {
      if (generation !== epoch) return;
      options.onError(error instanceof Error ? error : new Error(String(error)));
      previous = undefined;
      state = { scope: state?.scope ?? "system", system: empty(), workspaces: new Map(), failed: true };
    } finally {
      clearTimeout(timeout);
      if (collecting === abort) collecting = undefined;
      if (generation === epoch && subscribers.size) {
        for (const subscriber of subscribers) subscriber.changed();
        timer = setTimeout(() => { timer = undefined; void tick(); }, interval);
        timer.unref?.();
      }
    }
  }
  return {
    subscribe(workspaceId: string | undefined, listener: (html: string) => void): CableChannelSubscription {
      const presentation = createLivePresentation(() => [{ target, html: renderResourceMeters(state, workspaceId ? options.workspace(workspaceId) : undefined) }]);
      const view = { workspaceId, changed: () => presentation.invalidate() };
      const subscription = presentation.subscribe(listener);
      subscribers.add(view);
      if (subscribers.size === 1) void tick();
      let active = true;
      return { unsubscribe() {
        if (!active) return;
        active = false;
        subscription.unsubscribe(); presentation.dispose(); subscribers.delete(view);
        if (subscribers.size) return;
        generation++;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        collecting?.abort(); collecting = undefined;
        state = undefined; previous = undefined;
      } };
    },
  };
}
