import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { getKintsugiRuntimeContext, isNotFoundError, writeJsonAtomic } from "@kintsugi/core";
import { defaultPolicy, effectivePolicy, modelFor, oversightPolicy, PolicySchema } from "@kintsugi/token-economizer/core";
const purposeLabels = {proposer:"model-written facts",loopJudge:"the stuck-run judge",writer:"redirect writing",toolJudge:"task-aware tool picks",loopClassifier:"the stuck-run classifier",toolClassifier:"the tool classifier"} satisfies Record<keyof ReturnType<typeof defaultPolicy>["models"],string>;
const override = Type.Enum(["inherit","off","observe","active"]);
export const optimizerConfigSchema = Type.Object({version:Type.Literal(1),hasEnabled:Type.Boolean(),policy:PolicySchema,workspaces:Type.Record(Type.String({maxLength:256}),override),agents:Type.Record(Type.String({maxLength:512}),override),oversightWorkspaces:Type.Optional(Type.Record(Type.String({maxLength:256}),override)),oversightAgents:Type.Optional(Type.Record(Type.String({maxLength:512}),override))},{additionalProperties:false});
export type OptimizerConfig = Static<typeof optimizerConfigSchema>;
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Persisted and HTTP settings enter through this complete schema boundary.
export function parseOptimizerConfig(value:unknown):OptimizerConfig {Value.Assert(optimizerConfigSchema,value);return structuredClone(value);}
// Freeze the old combined choices before either of the independent forms edits them.
export function splitOptimizerPolicy(config:OptimizerConfig) {
  if (config.policy.oversightMode === undefined) {
    config.policy.oversightMode = oversightPolicy(config.policy).mode;
    config.policy.oversightInferenceInObserve = config.policy.inferenceInObserve;
    config.oversightWorkspaces = {...config.workspaces};config.oversightAgents = {...config.agents};
  }
}
export class TokenOptimizerConfiguration {
  private state:OptimizerConfig|undefined;
  private loading:Promise<void>|undefined;
  private tail:Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => Promise<void>>();
  constructor(private readonly dataDir:string) {}
  async load() {
    this.loading ??= (async () => {try {this.state = parseOptimizerConfig(await Bun.file(join(this.dataDir,"token-optimizer/config.json")).json());} catch (error) {if (!isNotFoundError(error)) throw error;this.state = {version:1,hasEnabled:false,policy:defaultPolicy(),workspaces:{},agents:{}};}})();
    await this.loading;return this.snapshot();
  }
  snapshot() {if (!this.state) throw new Error("Token optimizer settings have not loaded");return structuredClone(this.state);}
  policy(workspaceId:string,agentId:string) {
    if (!this.state) throw new Error("Token optimizer settings have not loaded");
    const state = this.state, key = JSON.stringify([workspaceId,agentId]);
    const policy = effectivePolicy(state.policy,state.workspaces[workspaceId] ?? "inherit",state.agents[key] ?? "inherit");
    if (state.policy.oversightMode !== undefined) policy.oversightMode = effectivePolicy(oversightPolicy(state.policy),state.oversightWorkspaces?.[workspaceId] ?? "inherit",state.oversightAgents?.[key] ?? "inherit").mode;
    return policy;
  }
  watch(listener:() => Promise<void>) {this.listeners.add(listener);return () => {this.listeners.delete(listener);};}
  async configure(config:OptimizerConfig) {
    const replacement = parseOptimizerConfig(config);
    return this.update(() => replacement);
  }
  /** Apply a partial update to the latest committed config, inside the write queue. */
  async update(edit:(current:OptimizerConfig) => OptimizerConfig) {
    const update = this.tail.then(async () => {
      await this.load();
      const next = parseOptimizerConfig(edit(this.snapshot()));
      if (next.policy.enabled && !this.state!.hasEnabled) {
        if ([...Object.values(next.workspaces),...Object.values(next.agents)].includes("active")) throw new Error("Start in Watch only (Observe) first: a workspace or Agent override is already set to On");
        next.policy.mode = "observe";
      }
      const policy = next.policy, required:(keyof typeof policy.models)[] = [];
      if (policy.enabled && ["both","distiller"].includes(policy.microSkills)) required.push("proposer");
      if (oversightPolicy(policy).enabled && policy.loop === "judge") {if (["generative","cascade"].includes(policy.judge)) {required.push("loopJudge");if (!policy.savers.templates) required.push("writer");}if (["classifier","cascade"].includes(policy.judge)) required.push("loopClassifier");}
      if (policy.enabled && policy.pruning !== "off") {if (["generative","cascade"].includes(policy.toolJudge)) required.push("toolJudge");if (["classifier","cascade"].includes(policy.toolJudge)) required.push("toolClassifier");}
      for (const purpose of required) if (!modelFor(policy,purpose)) throw new Error(`Pick a model for ${purposeLabels[purpose]}, or turn that feature off`);
      if (policy.enabled && policy.offloadOutputs && policy.outputSummaries && !policy.generativeModel) throw new Error("Pick a model for optimizer calls to summarise stored outputs, or turn summaries off");
      next.hasEnabled = this.state!.hasEnabled || next.policy.enabled;
      await writeJsonAtomic(join(this.dataDir,"token-optimizer/config.json"),next,{mode:0o600});this.state = next;
      await Promise.all([...this.listeners].map(listener => listener()));
    });this.tail = update.catch(() => {});await update;return this.snapshot();
  }
}
let configuration:TokenOptimizerConfiguration|undefined, directory:string|undefined;
export function tokenOptimizerConfiguration() {const data = getKintsugiRuntimeContext().kintsugiDataDir;if (directory !== data) {directory = data;configuration = new TokenOptimizerConfiguration(data);}return configuration!;}
