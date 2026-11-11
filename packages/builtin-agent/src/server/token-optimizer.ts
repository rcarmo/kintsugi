import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { detach } from "../../../token-economizer/src/pi-durable/detach.ts";
import type { Models } from "@earendil-works/pi-ai";
import { AgentDoc, AssistantEntry, CompactionEntry, defineDoc, defineEntry, LiveDoc, SystemEntry, type AgentState, type Conversation, type ConversationId, type Harness, type RegistryReader } from "@earendil-works/pi-durable";
import { escapeHtml } from "@kintsugi/shared";
import type { BuiltinAgentIntegration } from "./integrations.ts";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { createTokenEconomizer, createSdkModelTransport } from "../../../token-economizer/src/pi-durable/index.ts";
import { fingerprint } from "../../../token-economizer/src/core/identity.ts";
import { contextSection, sessionKey } from "../../../token-economizer/src/core/sessions.ts";
import { ContextSnapshotEntry, SessionsDoc } from "../../../token-economizer/src/pi-durable/documents.ts";
import type { HostDomain, HostSession } from "../../../token-economizer/src/pi-durable/domain.ts";
import { nativeOptimizerTool, nativeOptimizerTrajectory, optimizerEntries, optimizerSections, optimizerMessageSections } from "./token-optimizer-source.ts";
import { tokenOptimizerConfiguration, type TokenOptimizerConfiguration } from "./token-optimizer-config.ts";
import { WorkspaceAdmission } from "./durable-lifecycle.ts";
import { WorkspaceAgents } from "./durable-workspace.ts";
import { getWorkspaceTitle } from "@kintsugi/workspace";
import type { DurableAgentRecord } from "./durable-workspace.ts";
const NativeNotices = defineDoc<{ids:string[]}>({kind:"kintsugi.token-optimizer.notices",version:1,scope:"session",initial:() => ({ids:[]}),checkpointWhen:() => false});
const OptimizerNotice = defineEntry<{id:string;text:string;at:number}>("kintsugi.token-optimizer.notice");
export const tokenOptimizerIntegration:BuiltinAgentIntegration = {id:"token-optimizer",transcript:view => ({rows:view.entries.flatMap(entry => OptimizerNotice.is(entry) ? [{type:"extension" as const,key:String(entry.id)+":optimizer",timestamp:entry.data.at,render:() => `<p class="settings-help" role="status">${escapeHtml(entry.data.text)}</p>`}] : [])})};
export const NativeOptimizerSessions = defineDoc<{sessions:Record<string,{host:HostSession;begin:number;end:number|null}>}>({kind:"kintsugi.token-optimizer.sessions",version:1,scope:"session",initial:() => ({sessions:{}}),checkpointWhen:() => false});
const NativeEpoch = defineDoc<{id:string|null}>({kind:"kintsugi.token-optimizer.epoch",version:1,scope:"conversation",history:"latest",fork:"initial",initial:() => ({id:null}),checkpointWhen:() => false});
type Filter = NonNullable<AgentState["tools"]>|null;
const NativeMask = defineDoc<{initialized:boolean;baseline:Filter;rendered:Filter;owned:string[]}>({kind:"kintsugi.token-optimizer.mask",version:1,scope:"conversation",history:"latest",fork:"current",initial:() => ({initialized:false,baseline:null,rendered:null,owned:[]}),checkpointWhen:() => false});
const actorSchema = Type.Tuple([Type.String(),Type.String()]);
function actor(host:HostSession) {const value:unknown = JSON.parse(host.id);Value.Assert(actorSchema,value);return value[0];}
const active = new Map<string,ReturnType<typeof createNativeTokenOptimizer>>();
export function nativeTokenOptimizers() {return [...active.entries()];}
export function createNativeTokenOptimizer(options:{workspaceId:string;harness:() => Harness;models:Models;registry:RegistryReader;configuration:TokenOptimizerConfiguration;workspaceTitle?:() => Promise<string|null>}) {
  const hosts = new Map<ConversationId,HostSession>(), modelFree = new Map<ConversationId,boolean>(), preparing = new Set<ConversationId>();let maintenance:ConversationId|undefined, stop:(() => void)|undefined, observer:(() => void)|undefined;
  let events = Promise.resolve();
  const domain:HostDomain = {integrationId:"kintsugi.builtin",session:async id => {
    const host = hosts.get(id);if (!host) return null;
    if (modelFree.get(id)) return {...host,delegated:true};
    return host;
  },tool:nativeOptimizerTool,arguments:(_name,args) => decodeArguments(args),decode:decodeResult,
    async catalogue(host) {
      const conversation = await options.harness().conversation(host.conversationId,context);if (!conversation) throw new Error("Optimizer conversation is absent");
      const agent = await conversation.agent(context), stored = await options.harness().snapshot(NativeMask,host.conversationId,context), settings = await options.harness().snapshot(AgentDoc,host.conversationId,context), baseline = stored?.initialized ? stored.baseline : settings?.tools ?? null;
      const extensions = new Set(agent.extensions.map(extension => extension.name)), exposed = new Set([...agent.tools,...agent.callable,...agent.deferred].map(tool => tool.name));
      const tools = [...new Map(options.registry.snapshot().tools().filter(item => extensions.has(item.extension.name)).map(item => [item.tool.name,item.tool])).values()].filter(tool => Array.isArray(baseline) ? baseline.includes(tool.name) : !baseline?.remove.includes(tool.name)).map(tool => ({name:tool.name,description:tool.description.slice(0,4096),revision:fingerprint(JSON.stringify([tool.name,tool.description,tool.parameters,tool.callers])),protected:/plan|user|ask|permission|agent|delegat|message|stop|cancel|credential|recover|codemode|tool_search/i.test(tool.name),highRisk:!nativeOptimizerTool(tool.name).readOnly,exposed:exposed.has(tool.name)}));
      return {revision:fingerprint(JSON.stringify(tools.map(({exposed:_exposed,...tool}) => tool))),source:"native-registry-and-agent-filter",complete:true,tools};
    },
    async setTools(host,excluded) {
      const catalogue = await domain.catalogue(host), safe = excluded.filter(name => catalogue.tools.some(tool => tool.name === name && !tool.protected));
      await options.harness().commit(async tx => {
        const owner = await tx.doc(NativeMask,host.conversationId), agent = await tx.doc(AgentDoc,host.conversationId), current:Filter = agent.tools === undefined ? null : detach({value:agent.tools}).value;
        if (!owner.initialized) {owner.baseline = current;owner.rendered = current;owner.initialized = true;}
        if (JSON.stringify(current) !== JSON.stringify(owner.rendered)) throw new Error("The tool filter changed outside the optimizer; refusing to overwrite another owner's restrictions");
        const baseline:Filter = detach({value:owner.baseline}).value, next:Filter = Array.isArray(baseline) ? baseline.filter(name => !safe.includes(name)) : safe.length ? {remove:[...new Set([...(baseline?.remove ?? []),...safe])]} : baseline;
        if (JSON.stringify(current) !== JSON.stringify(next) && !preparing.has(host.conversationId) && (await tx.doc(LiveDoc,host.conversationId)).run) throw new Error("Task preparation expired while the Agent started work");
        if (JSON.stringify(current) !== JSON.stringify(next)) {if (next === null) delete agent.tools;else agent.tools = next;}
        owner.rendered = next;owner.owned = safe;
      },context);
    },
    async trajectory(host,cutoff) {
      const record = (await options.harness().snapshot(NativeOptimizerSessions,context))?.sessions[host.id];if (!record) return {kind:"absent",reason:"No native logical session record"};
      return nativeOptimizerTrajectory(options.harness(),host,record.begin,record.end,cutoff);
    },
  };
  const transport = createSdkModelTransport(options.models);
  const optimizer = createTokenEconomizer({harness:options.harness,backgroundOwner:() => {if (maintenance === undefined) throw new Error("Optimizer maintenance owner is not attached");return maintenance;},domain,...transport,policy:host => options.configuration.policy(options.workspaceId,actor(host)),onNotice:async notice => {const rows = (await options.harness().snapshot(NativeOptimizerSessions,context))?.sessions, host = rows?.[notice.sessionId]?.host;if (host) await options.harness().commit(async tx => {const state = await tx.doc(NativeNotices);if (state.ids.includes(notice.id)) return;await tx.appendEntry(OptimizerNotice,host.conversationId,{data:{id:notice.id,text:notice.text,at:Date.now()}});state.ids.push(notice.id);},context);},onError:error => console.error("Token optimizer observation failed",error)});
  async function start(conversation:Conversation,record:Pick<DurableAgentRecord,"agentId"|"parentId"|"readOnly"|"oneShotCallId">,event:"startup"|"new"|"resume"|"fork" = "startup",parentGroup?:string) {
    if (record.parentId || record.readOnly || record.oneShotCallId) return;
    if (event === "startup" && hosts.has(conversation.id)) return hosts.get(conversation.id)!
    const view = await conversation.context(context), history = await optimizerEntries(conversation), carried = optimizerMessageSections(view.messages);
    const host = await options.harness().commit(async tx => {
      const epoch = await tx.doc(NativeEpoch,conversation.id), sessions = await tx.doc(NativeOptimizerSessions);
      if (epoch.id === null) {
        epoch.id = JSON.stringify([record.agentId,crypto.randomUUID()]);
        const host:HostSession = {id:epoch.id,conversationId:conversation.id,scope:{host:"kintsugi.builtin",repository:options.workspaceId,environment:"native-v1"},repositoryRoot:"/work",environmentRevision:"native-v1",classificationGroup:parentGroup ?? epoch.id,delegated:false};
        // Installing the adapter over old history never imports that history as live learning.
        const ancestors = parentGroup ? Object.values(sessions.sessions).filter(row => row.host.classificationGroup === parentGroup) : [];
        if (event === "fork" && !ancestors.length) throw new Error("Fork classification group has no native source boundary");
        sessions.sessions[epoch.id] = {host,begin:event === "fork" ? Math.min(...ancestors.map(row => row.begin)) : history.at(-1)?.id ?? 0,end:null};
      }
      const row = sessions.sessions[epoch.id];if (!row) throw new Error("Missing native optimizer epoch");return detach(row.host);
    },context);
    hosts.set(conversation.id,host);
    const assistant = view.entries.findLast(entry => AssistantEntry.is(entry));modelFree.set(conversation.id,assistant?.model?.some(message => message.role === "assistant" && message.provider === "kintsugi" && message.model === "codemode-template") ?? false);
    const existing = (await options.harness().snapshot(SessionsDoc,context))?.sessions[sessionKey(host.scope,host.id)];
    const snapshot = history.findLast(entry => ContextSnapshotEntry.is(entry) && entry.data.section === carried[contextSection]);
    const carriedIds = existing?.injectedIds ?? (snapshot && ContextSnapshotEntry.is(snapshot) ? snapshot.data.injectedIds : []);
    const live = await options.harness().snapshot(LiveDoc,conversation.id,context), mask = await options.harness().snapshot(NativeMask,conversation.id,context);
    const runningMask = live?.run && !live.run.afterRun && live.run.inputs.length > 0 ? existing?.frozenMask ?? mask?.owned ?? [] : undefined;
    preparing.add(conversation.id);
    try {await optimizer.sessionStarted(host,{event,visibleHistory:view.entries.some(entry => (entry.model?.length ?? 0) > 0),carriedSections:carried,carriedIds,runningMask});} finally {preparing.delete(conversation.id);}
    return host;
  }
  async function end(id:ConversationId) {
    const host = hosts.get(id);if (!host) return;
    const conversation = (await options.harness().conversation(id,context))!, entries = await optimizerEntries(conversation), live = await options.harness().snapshot(LiveDoc,id,context);
    await options.harness().commit(async tx => {const row = (await tx.doc(NativeOptimizerSessions)).sessions[host.id];if (!live?.run) row.end ??= entries.at(-1)?.id ?? row.begin;},context);
    await optimizer.sessionEnded(host,!live?.run && !live?.runFailure);hosts.delete(id);
  }
  return {optimizer,domain,start,end,
    async attach() {
      maintenance = (await options.harness().root(context)).id;await optimizer.attach();
      const catalogue = await options.harness().snapshot(WorkspaceAgents,context), gates = await options.harness().snapshot(WorkspaceAdmission,context);
      if (!gates?.deleted) for (const record of catalogue?.agents ?? []) if (!record.readOnly && !record.parentId && !record.oneShotCallId && !gates?.closed.includes(record.durableId)) await start((await options.harness().conversation(record.durableId,context))!,record,"resume");
      stop = options.configuration.watch(() => optimizer.updatePolicy(true));active.set(options.workspaceId,this);
      const source = options.harness().observeCommits({advance(publication) {
        for (const change of publication.changes) if (change.type === "entry" && AssistantEntry.is(change.value)) modelFree.set(change.value.conversationId,change.value.model?.some(message => message.role === "assistant" && message.provider === "kintsugi" && message.model === "codemode-template") ?? false);
        for (const change of publication.changes) if (change.type === "entry" && (SystemEntry.is(change.value) || CompactionEntry.is(change.value))) {
          const entry = change.value, host = hosts.get(entry.conversationId);if (!host) continue;
          events = events.then(async () => {
            const compacted = CompactionEntry.is(entry), sections = compacted ? optimizerMessageSections((await (await options.harness().conversation(host.conversationId,context))!.context(context)).messages) : optimizerSections([entry]);
            await optimizer.replaySections(host,sections,compacted);
          }).catch(error => console.error("Token optimizer section replay failed",error));
        }
      },end() {}});observer = () => source.detach();
    },
    async reset(conversation:Conversation,record:Pick<DurableAgentRecord,"agentId"|"parentId"|"readOnly">) {await end(conversation.id);await options.harness().commit(async tx => {(await tx.doc(NativeEpoch,conversation.id)).id = null;},context);return start(conversation,record,"new");},
    async optimizerSessions() {return [...hosts.values()];},
    async prepare(host:HostSession,task:string,requestId:string) {if ((await options.harness().snapshot(LiveDoc,host.conversationId,context))?.run) throw new Error("Wait for the Agent to become idle before preparing a task toolset");return optimizer.prepareTools(host,task,[],requestId,{index:0,reauditEvery:0},async () => hosts.get(host.conversationId)?.id === host.id && !(await options.harness().snapshot(LiveDoc,host.conversationId,context))?.run);},
    lookup(id:ConversationId) {return hosts.get(id);},
    /** Display name for Settings; the catalogue is the source of Agent titles. */
    async title(host:HostSession) {const record = (await options.harness().snapshot(WorkspaceAgents,context))?.agents.find(row => row.durableId === host.conversationId || row.branches?.includes(host.conversationId));return record?.title || record?.label || actor(host);},
    agentId:actor,
    async workspaceTitle() {return await options.workspaceTitle?.() || options.workspaceId;},
    host(id:ConversationId) {const host = hosts.get(id);if (!host) throw new Error("This Agent has no optimizer logical session");return host;},
    async detach() {await events;stop?.();observer?.();await optimizer.close();if (active.get(options.workspaceId) === this) active.delete(options.workspaceId);},
    async close() {await events;for (const id of [...hosts.keys()]) await end(id);await this.detach();},
  };
}
import { decodeArguments, decodeResult } from "../../../token-economizer/src/pi-durable/decode.ts";
export async function nativeOptimizerOptions(workspaceId:string,harness:() => Harness,models:Models,registry:RegistryReader) {const configuration = tokenOptimizerConfiguration();await configuration.load();return createNativeTokenOptimizer({workspaceId,harness,models,registry,configuration,workspaceTitle:() => getWorkspaceTitle(workspaceId)});}
