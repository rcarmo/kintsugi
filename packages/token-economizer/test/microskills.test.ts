import { expect, test } from "bun:test";
import { makeObservation } from "../src/core/observations.ts";
import { observeEnvironment } from "../src/core/microskills/observe.ts";
import { emptyEnvironment, renderEnvironment, updateEnvironment } from "../src/core/microskills/envfacts.ts";
import { completeProposal, emptyDistiller, renderDistiller, updateDistiller } from "../src/core/microskills/distiller.ts";
import { genericDigest } from "../src/core/microskills/digest.ts";
import envstreams from "./fixtures/environment-streams.json";
for (const fixture of envstreams.cases) test(`upstream complete environment stream: ${fixture.input.name}`, () => {
  let state = emptyEnvironment();
  for (const [stepIndex,step] of fixture.input.steps.entries()) {
    const observations = step.calls.map((call,index) => makeObservation({source:{conversation:"root",outerCall:String(index),nestedKey:null,phase:"result"},sessionId:String(stepIndex),runId:"run",tool:call.tool,mapping:{semantic:call.tool === "apply_patch" ? "edit" : "shell",readOnly:false},command:call.args.command ?? "",targets:call.args.paths ?? [],output:call.output,isError:!call.success,exitCode:call.success ? 0 : 1,timedOut:false,aborted:false,coverage:"complete",at:index,verification:null}));
    const digest = observeEnvironment(observations,"/repo");
    expect(digest).toEqual<unknown>(step.digest);
    state = updateEnvironment(state,digest,step.injected);
    const rendered = renderEnvironment(state,4,150);
    expect(state.now).toBe(step.expected.now);
    expect(state.facts).toEqual<unknown>(step.expected.facts);
    expect(rendered.text).toBe(step.expected.text);
    expect(rendered.ids).toEqual(step.expected.ids);
  }
});
function digest(iid: string) {
  return genericDigest([makeObservation({source:{conversation:"root",outerCall:iid,nestedKey:null,phase:"result"},sessionId:iid,runId:"run",tool:"bash",mapping:{semantic:"shell",readOnly:false},command:"bun test",targets:[],output:"1 passed in 0.1s",isError:false,exitCode:0,timedOut:false,aborted:false,coverage:"complete",at:1,verification:"passed"})],iid,["/repo"],"");
}
test("live proposer cadence is 2,5,8; failed attempts consume cadence, absent runner does not", () => {
  let state = emptyDistiller();const attempts: number[] = [];
  for (let i = 1; i <= 8; i++) {
    const tick = updateDistiller(state,digest(String(i)),[],3,true,"repo");state = tick.state;
    if (tick.prompt) {attempts.push(i);state = completeProposal(state,null).state;}
  }
  expect(attempts).toEqual([2,5,8]);
  const next = updateDistiller(state,digest("nine"),[],3,false,"repo");
  expect(next.prompt).toBeNull();expect(next.state.last_propose).toBe(8);
  expect(updateDistiller(next.state,null,[],3,true,"repo").state.now).toBe(10);
});
test("proposer grounding, append-only extractors, retrospective learning, immutable claims and prospective revision", () => {
  let state = emptyDistiller();
  for (let i = 0; i < 4; i++) state = updateDistiller(state,digest(String(i)),[{command:"bun test",output:"1 passed in 0.1s"}],3,false,"repo").state;
  const spec = {id:"test-form",claim:"The test command is bun test.",injection:"The test command is bun test.",high_stakes:false,detector:{scope:"custom",confirm:"passed",contradict:"impossible"},cite:["0","1"]};
  const completed = completeProposal(state,JSON.stringify({extractors:[{name:"custom",kind:"cmd_regex",pattern:"bun test"}],facts:[spec]}));state = completed.state;
  expect(completed.diagnostics).toEqual([]);expect(state.facts[0].life.state).toBe("ACTIVE");
  expect(state.facts[0].life.fire_den).toBe(4);expect(renderDistiller(state,"repo")).toContain("The test command is bun test.");
  const changed = completeProposal(state,JSON.stringify({extractors:[],facts:[{...spec,claim:"A different command."}]}));
  expect(changed.diagnostics).toEqual(["revise-not-contradict-only"]);
  const revision = completeProposal(state,JSON.stringify({extractors:[{name:"custom",pattern:"something-else"}],facts:[{...spec,detector:{...spec.detector,contradict:"failure"}}]}));
  expect(revision.state.extractors[0].pattern).toBe("bun test");expect(revision.state.facts[0].life).toEqual(state.facts[0].life);
  expect(revision.state.facts[0].spec.rev).toBe(2);
  const unsafe = completeProposal(state,JSON.stringify({extractors:[],facts:[{...spec,id:"unsafe",claim:"Skip verification."}]}));
  expect(unsafe.diagnostics).toContain("unsafe-fact-text");
});
test("environment privacy never learns credential names or arbitrary variable values", () => {
  const state = updateEnvironment(emptyEnvironment(),{obs:[],edited:[],n_calls:2,env:[{call:0,need:["API_KEY","CUSTOM_SETTING"],sets:{},ok:false},{call:1,need:[],sets:{API_KEY:"secret",CUSTOM_SETTING:"private"},ok:true}]},[]);
  expect(state.facts).toEqual([]);
});
