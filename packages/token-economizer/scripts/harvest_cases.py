"""Development-only: harvest public reducers from the pinned TE checkout; never run in production."""
import json
import random
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
source = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(source))
from tokeneconomizer.plugin.fold import enough_evidence
from tokeneconomizer.microskills.lifecycle import Lifecycle
from tokeneconomizer.microskills.envfacts import EnvFact, fold
from tokeneconomizer.loopguard.envelope import EnvelopeTracker, thresholds
from tokeneconomizer.loopguard.rules import scaled_thresholds, gate_for_judge, is_stuck, assess_abort, nudge_text
pin = subprocess.check_output(['git','rev-parse','HEAD'], cwd=source, text=True).strip()
if pin != '81e32e56bb3c4c1b4c9756b429be91e3960116ca':
    raise ValueError('Unexpected upstream revision; review before re-harvesting')
out = Path(__file__).resolve().parents[1] / 'test' / 'fixtures'

def save(name, cases):
    (out / name).write_text(json.dumps(dict(upstream=pin, cases=cases), indent=2, ensure_ascii=False)+'\n')
    print(f'Harvested {len(cases)} pinned cases to {out / name}')

cfg = SimpleNamespace(toolprune_min_sessions=2, toolprune_evidence=10, toolprune_sessions=5)
cases = [dict(kind='enough-evidence', sessions=s, prompts=p, highRisk=r,
              expected=enough_evidence(s,p,cfg,r))
         for s in [0,1,2,4,5,14,15] for p in [0,1,9,10,11,29,30,31] for r in [False,True]]
save('upstream.json', cases)

# Every mechanism fixture has a fixed scope/clock/policy and explicit effects/accounting.
def case(kind, input, expected):
    return dict(kind=kind, sourceRevision=pin, scope=dict(host='fixture', repository='repo', environment='v1'),
                policy=dict(mode='active', version=1), observations=[], catalogue=[], priorState=None,
                input=input, expected=expected, effects=[], accounting=dict(requests=0, cost=0))

sequences = [
    [('confirm', True, True, [f'f{i}.ts']) for i in range(5)],
    [('confirm', True, True, ['same.ts']) for _ in range(5)],
    [('confirm', True, True, []) for _ in range(5)],
    [('confirm', True, True, [f'{i}.ts']) for i in range(3)] + [('contradict', True, True, [])],
    [('confirm', True, True, [f'{i}.ts']) for i in range(4)] + [(None, False, True, []) for _ in range(10)],
    [('contradict', True, True, [])] + [('confirm', False, True, [f'{i}.ts']) for i in range(4)],
    [('confirm', True, True, ['é.ts', '模块.ts', '\U0001F600.ts', '\uE000.ts']), ('confirm', False, True, ['模块.ts']), ('confirm', True, False, []), ('confirm', False, True, ['b.ts'])],
]
lifecycle = []
for high in [False, True]:
    for drift in [False, True]:
        for sequence in sequences:
            life = Lifecycle('fixture', high, drift)
            steps, states = [], []
            for now, (verdict, fired, exercised, files) in enumerate(sequence):
                steps.append(dict(now=now, verdict=verdict, fired=fired, exercised=exercised, files=files))
                life.update(now, verdict, fired, exercised, set(files))
                states.append(dict(life=life.to_dict(), score=life.score(now), injectable=life.injectable(), drifted=life._drifted_confirms()))
                # Snapshot lists rather than retaining the mutable upstream object's references.
                states[-1] = json.loads(json.dumps(states[-1]))
            lifecycle.append(case('lifecycle', dict(high=high, drift=drift, steps=steps), states))
save('lifecycle.json', lifecycle)

envfacts = []
for family in ['form_repair', 'absent_tool']:
    for high in [False, True]:
        for sequence in sequences + [[('contradict', True, True, []), (None, False, False, []), ('contradict', True, True, [])]]:
            fact = EnvFact('fixture', family, high, {})
            steps, states = [], []
            for now, (verdict, fired, exercised, files) in enumerate(sequence):
                steps.append(dict(now=now, verdict=verdict, fired=fired, exercised=exercised, files=files))
                fold(fact, now, verdict, fired, exercised, set(files))
                states.append(json.loads(json.dumps(dict(life=fact.life.to_dict(), contradictionStreak=fact.params.get('contra_streak', 0), family=family))))
            envfacts.append(case('environment-lifecycle', dict(high=high, family=family, steps=steps), states))
save('environment-lifecycle.json', envfacts)

rng = random.Random(81)
envelopes, rules = [], []
for level in ['default', 'conservative', 'aggressive']:
    for turns in [[], [5], [5]*4, [5]*5, [5,10,15,20,25,200], [1,2,3,4,5,6,7], list(range(10,40))]:
        for overrides in [{}, {'backstop_mult': 1.7}, {'envelope_margin': 1.1, 'envelope_min_samples': 2}, {'min_turns': 31, 'stagnation': .35}]:
            snapshots = [dict(turns=t, edit_churn=rng.randint(0,8), distinct_edit_files=rng.randint(0,4), error_outputs=rng.randint(0,10), stagnation=rng.choice([0,.0625,.1,.3,.8125]), repeated_fail_sigs=0, test_runs=0) for t in turns]
            tracker = EnvelopeTracker(level=level, margin=overrides.get('envelope_margin'), min_samples=overrides.get('envelope_min_samples'))
            tracker.resolved_turns, tracker.resolved_snaps = turns, snapshots
            envelopes.append(case('envelope', dict(level=level, history=dict(resolved_turns=turns, resolved_snaps=snapshots), overrides=overrides), dict(envelope=tracker.envelope, thresholds=thresholds(tracker, overrides))))
    for _ in range(28):
        state = SimpleNamespace(turns=rng.choice([0,17,18,19,20,28,50,100]), edit_churn=rng.choice([0,3,4,5]), distinct_edit_files=rng.choice([0,2,3]), error_outputs=rng.choice([0,5,6,8]), stagnation=rng.choice([0,.19,.2,.3]), repeated_fail_sigs=rng.choice([0,1,5]), test_runs=1)
        state.recent_digest = lambda **kw: {}
        thr = scaled_thresholds(level)
        for verdict in [None, {'stuck':False,'confidence':.9,'reason':'productive'}, {'stuck':True,'confidence':.9,'reason':'repeats'}, {'stuck':None,'confidence':.9,'reason':'ambiguous'}]:
            env = rng.choice([None, 10, 30])
            redirect, reason = assess_abort(state, env, None if verdict is None else lambda _: verdict, thr)
            rules.append(case('rules', dict(level=level, state={k:v for k,v in state.__dict__.items() if not callable(v)}, envelope=env, judge=None if verdict is None else dict(verdict=verdict)), dict(redirect=redirect, reason=reason.split(':')[0].split('@')[0], gate=gate_for_judge(state,thr), stuck=is_stuck(state,thr))))
save('envelope.json', envelopes)
save('rules.json', rules)
print('All fixtures use fixed IDs, deterministic input and zero inference.')

from tokeneconomizer.toolprune.stage import ToolingStage
from tokeneconomizer.config import ToolingConfig
catalogues = []
for mask in [[], ['rare']]:
    for incoming in [{}, {'new': 'New tool'}, {'rare': 'Updated description'}]:
        for used in [[], ['rare'], ['new'], ['unknown']]:
            adapter = SimpleNamespace(tool_usage=lambda _, used=used: dict.fromkeys(used,1), parse_catalog_with_source=lambda *_, incoming=incoming: (incoming, 'fixture'))
            stage = ToolingStage(ToolingConfig(evidence=2), 'claude', 'fixture', adapter=adapter)
            stage.catalog_tools = {'rare', 'prior'}
            stage.catalog_desc = {'rare': 'Rare tool', 'prior': 'Prior tool'}
            stage.tool_unused_streaks = {'rare': 3, 'prior': 1}
            stage._exclude_tools = mask
            stage._warned_no_catalog = True
            stage.after_task({'instance_id': 'session'}, {}, '/unused', {})
            catalogues.append(case('catalogue-streaks', dict(mask=mask, incoming=incoming, used=used), dict(catalogue=sorted(stage.catalog_tools), descriptions=stage.catalog_desc, used=sorted(stage.used_tools), streaks=stage.tool_unused_streaks)))
save('catalogue.json', catalogues)

from tokeneconomizer.microskills.distiller import DetectorV3Scope, Extractor
base_digest = dict(iid='session', resolved=None, edited_files=[], n_cmds=2, cmd_templates=['bun test', 'echo é'], check_commands=['bun test'], failed_commands=[], missing_command=False, missing_dependency=False, bad_usage=False, _ran_tests=True, _cmd_blob='bun test\necho é', _out_blob='pass\nconfirm contradiction', features={'custom':0})
detectors = []
for scope in ['ran_tests', 'ran_checks', 'edited', 'missing_command', 'missing_dependency', 'bad_usage', 'custom', 'echo é', '^does-not-match$']:
    for custom in [0, 2]:
        for contra in ['', 'contradiction']:
            digest = dict(base_digest, features={'custom':custom})
            spec = dict(scope=scope, fired='custom', confirm='confirm', contradict=contra)
            verdict, fired, exercised = DetectorV3Scope(spec, digest['features']).verdict(digest)
            detectors.append(case('detector', dict(spec=spec, digest=digest), dict(verdict=verdict, fired=fired, exercised=exercised)))
save('detectors.json', detectors)
extractors = []
commands = [('bun test','passed'), ('echo é','confirm'), ('bun test a','failed')]
for kind in ['cmd_regex','out_regex','cmd_count']:
    for pattern in ['bun test', 'é', '(?i)PASSED', '^$', '(a+)+$']:
        spec = dict(name='custom', kind=kind, pattern=pattern)
        extractors.append(case('extractor', dict(spec=spec, commands=[dict(command=c, output=o) for c,o in commands]), Extractor(spec).compute(commands)))
save('extractors.json', extractors)

from tokeneconomizer.microskills.distiller import PROPOSER_SYSTEM_GENERIC
prompt = PROPOSER_SYSTEM_GENERIC.replace('a python regex','a safe RE2 regular expression') + '\n\nNative safe detector dialect: patterns are at most 2048 characters. No lookarounds, backreferences, or shorthand character/boundary classes (use explicit character classes). Never include credentials, secret values, or completion/verification advice in a fact.'
prompt_path = Path(__file__).resolve().parents[1] / 'src' / 'core' / 'microskills' / 'proposer-prompt.ts'
prompt_path.write_text('// SPDX-License-Identifier: Apache-2.0\n// Modified TypeScript port of Microsoft TokenEconomizer, revision 81e32e56bb3c4c1b4c9756b429be91e3960116ca; see ../../../LICENSE.\n// Pinned upstream generic proposer prompt, with explicit native safe-dialect guidance.\nexport const proposerSystem = '+json.dumps(prompt)+';\n')

from tokeneconomizer.microskills.observe import GENERIC, ERROR_CLASSES, _PROBE_HIT
vocabulary = {k:sorted(getattr(GENERIC,k)) for k in ['interpreters','runner_heads','runner_modules','package_tools','fetch_heads','env_probe_heads','task_heads','build_heads']}
vocabulary['runner_scripts'] = list(GENERIC.runner_scripts)
vocabulary_path = Path(__file__).resolve().parents[1] / 'src' / 'core' / 'microskills' / 'vocabulary.ts'
vocabulary_path.write_text('// SPDX-License-Identifier: Apache-2.0\n// Modified TypeScript port of Microsoft TokenEconomizer, revision 81e32e56bb3c4c1b4c9756b429be91e3960116ca; see ../../../LICENSE.\n// Pinned upstream generic command vocabulary.\nexport const vocabulary = '+json.dumps(vocabulary,indent=2)+';\n')

import tempfile
sys.path.insert(0,str(source/'tests'))
from fixtures import write_codex_transcript
from tokeneconomizer.microskills.observe import observe_task
from tokeneconomizer.microskills.envfacts import EnvFactsDistiller
from tokeneconomizer.trace import load_trajectory

def shell(command, output, code):
    return dict(type='command_execution',command=command,aggregated_output=output,exit_code=code)
scenarios = {
 'form-repair': [[shell('python -m pytest tests/a.py','python: No module named pytest',1),shell('/env/bin/python -m pytest tests/a.py','1 passed in 0.2s',0)]]*4 + [[shell('/env/bin/python -m pytest tests/b.py','2 passed in 0.2s',0)]]*3 + [[shell('python -m pytest tests/a.py','1 passed in 0.2s',0)]]*2,
 'absent': [[shell('ruff check .','bash: ruff: command not found',127)]]*4 + [[shell('eslint .','linted',0)]]*2 + [[shell('ruff check .','all checks passed',0)]],
 'boundary': [[shell('curl https://api.example.org/x','curl: (7) Failed to connect to api.example.org: Connection refused',7)]]*4 + [[shell('curl https://api.example.org/x','response body',0)]],
 'probe': [[shell('git remote -v; git tag --contains HEAD | head','',0)]]*4 + [[shell('git remote -v','origin https://example.org/repo (fetch)',0)]],
 'arg': [[shell('python -m unittest tests.app::Case','Failed to import test module: tests.app::Case',1),shell('python -m unittest tests.app.Case','Ran 1 test\nOK',0)]]*4,
 'environment': [[shell('python -c "import project"',"environment variable 'PYTHONPATH' is required",1),shell('PYTHONPATH=. python -c "import project"','imported',0)]]*4,
 'compound': [[shell('cd tests && python runtests.py | tail -2','Ran 2 tests\nOK',0),shell('python -m pytest -k target; echo done','1 passed in 0.1s',0),shell('git remote -v; echo no','origin url (fetch)',0),shell('curl https://host/x | grep result','result',0)]],
 'heredoc': [[shell("python - <<'PY'\nprint('pytest word, not a command')\nPY",'printed',0),shell("read -r x <<< x\npytest -q\nx=1",'1 passed in 0.1s',0)]],
}
envstreams = []
with tempfile.TemporaryDirectory() as directory:
    for name, sessions in scenarios.items():
        distiller = EnvFactsDistiller('repo',vocab=GENERIC)
        steps = []
        for i, commands in enumerate(sessions):
            path = str(Path(directory)/'trajectory.jsonl')
            items = [dict(type='file_change',changes=[dict(path=f'src/m{i}.py',kind='update')])] + commands
            write_codex_transcript(path,items)
            injected = distiller.injected_ids()
            digest = observe_task(path,GENERIC)
            digest['obs'] = [{key:getattr(o,key) for key in o.__slots__} for o in digest['obs']]
            calls = [dict(tool=t,args=a,output=o,success=ok) for t,a,o,ok in load_trajectory(path)]
            distiller.seed_injected(injected);distiller.update(path,iid=str(i))
            text = distiller.render()
            steps.append(json.loads(json.dumps(dict(calls=calls,injected=injected,digest=digest,expected=dict(now=distiller.now,facts=[f.to_dict() for f in distiller.facts.values()],text=text,ids=distiller.injected_ids())))))
        envstreams.append(case('environment-stream',dict(name=name,steps=steps),None))
save('environment-streams.json',envstreams)

import re
from tokeneconomizer.loopguard import turn as turn_module

def js_regex(pattern):
    pattern = re.sub(r'\(\?[aimsu]+\)', '', pattern)
    result, in_class, i = '', False, 0
    while i < len(pattern):
        c = pattern[i]
        if c == '\\' and i+1 < len(pattern):
            esc = pattern[i+1]
            if esc == 'w': result += r'\p{L}\p{N}_' if in_class else r'[\p{L}\p{N}_]'
            elif esc == 'd': result += r'\p{Nd}'
            else: result += c+esc
            i += 2;continue
        if c == '[': in_class = True
        elif c == ']': in_class = False
        result += c;i += 1
    return result
patterns_path = Path(__file__).resolve().parents[1] / 'src' / 'core' / 'loopguard' / 'verification-patterns.ts'
patterns = '// SPDX-License-Identifier: Apache-2.0\n// Modified TypeScript port of Microsoft TokenEconomizer, revision 81e32e56bb3c4c1b4c9756b429be91e3960116ca; see ../../../LICENSE.\n// Pinned reference verification patterns, Unicode word/digit classes made explicit for JavaScript.\n'
for target, source_name in [('verifyPattern','VERIFY_RE'),('notRunPattern','_NOT_A_RUN_RE'),('prefixPattern','_PREFIX_RE'),('reportPattern','_REPORT_RE'),('runFailedPattern','_RUN_FAILED_RE'),('runPassedPattern','_RUN_PASSED_RE')]:
    compiled = getattr(turn_module,source_name)
    flags = 'u' + ('i' if compiled.flags & re.I else '') + ('m' if compiled.flags & re.M else '')
    patterns += f'export const {target} = new RegExp('+json.dumps(js_regex(compiled.pattern))+','+json.dumps(flags)+');\n'
patterns_path.write_text(patterns)

from tokeneconomizer.loopguard.judge import STUCK_JUDGE_SYSTEM, NUDGE_WRITER_SYSTEM
judge_path = Path(__file__).resolve().parents[1] / 'src' / 'core' / 'loopguard' / 'prompts.ts'
judge_path.write_text('// SPDX-License-Identifier: Apache-2.0\n// Modified TypeScript port of Microsoft TokenEconomizer, revision 81e32e56bb3c4c1b4c9756b429be91e3960116ca; see ../../../LICENSE.\n// Pinned upstream loop judge and redirect writer instructions.\nexport const judgeSystem = '+json.dumps(STUCK_JUDGE_SYSTEM)+';\nexport const writerSystem = '+json.dumps(NUDGE_WRITER_SYSTEM)+';\n')

from tokeneconomizer.loopguard.shell_edits import shell_edit_targets, shell_revert_targets
from tokeneconomizer.loopguard.turn import exit_status_covers, status_of_tests, runner_verdict
shell_commands = [
 'pytest -q', 'pytest | tail -20', 'set -o pipefail; npm test | tee out.log', 'npm test || true', 'python -m unittest; echo "exit=$?"', 'pytest -q; git diff', 'cd web; npx vitest run', 'echo pytest', 'pytest --collect-only',
 'sed -i "s/a/b/" src/main.ts', "sed -i.bak -e 's/a/b/' a.py b.py", "perl -pi -e 's/a/b/' a.rs", 'echo text > src/a.ts', 'echo text > out.log', 'echo text | tee src/a.ts',
 "python - <<'PY'\nfrom pathlib import Path\nPath('src/a.ts').write_text('x')\nPY", "python - <<'PY'\nfor p in ['a.py', 'b.py']:\n p.write_text('x')\nPY", "apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch\nPATCH",
 'git restore src/a.ts', 'git checkout -- src/a.ts', 'git checkout main', 'python repro.py 2>&1 | tail -20', 'rg Error src | head', 'find src -delete; echo done', "bash -lc 'npm test 2>&1 | tail -8'", "read x <<< 'test'\npytest", "python - <<'PY'\nprint('; pytest')\nPY", 'printf "literal >"; pytest',
]
save('shell.json',[case('shell',dict(command=command),dict(edits=shell_edit_targets(command),reverts=shell_revert_targets(command),covers=exit_status_covers(command),status=status_of_tests(command))) for command in shell_commands])
verdict_texts = ['1 passed in 0.1s','2 failed in 0.2s','Ran 1 test\nOK','FAILED (failures=1)','Tests: 1 failed, 2 passed','test result: ok. 2 passed; 0 failed','test result: FAILED','0 passed','source with assert and Error','BUILD SUCCESS','BUILD FAILED','1 passing','1 failing','ok example/pkg (cached)']
save('runner-verdicts.json',[case('runner-verdict',dict(text=text),runner_verdict(text)) for text in verdict_texts])

from tokeneconomizer.loopguard.state import SpiralState
spirals = []
for failed in [None,False,True]:
    state = SpiralState();steps = []
    calls = [('edit',{'path':'src/a.ts'},''),('bash',{'command':'pytest'},'AssertionError: value 42 at /repo/a.ts'),('bash',{'command':'pytest'},'AssertionError: value 43 at /repo/b.ts'),('view',{'path':'a.ts'},'assert Error'),('grep',{'pattern':'Error'},'Error'),('bash',{'command':'echo ok'},'1 passed in 0.1s')]
    for name,args,output in calls:
        state.update(name,args,output,failed)
        steps.append(json.loads(json.dumps(dict(name=name,args=args,output=output,failed=failed,expected=dict(state={key:getattr(state,key) for key in state.__slots__},snapshot=state.snapshot(),digest=state.recent_digest(envelope=8))))))
    spirals.append(case('spiral',dict(steps=steps),None))
save('spirals.json',spirals)

from unittest.mock import patch
from tokeneconomizer.loopguard.turn import TurnGuard
class FixtureJudge:
    def __init__(self): self.effect = None
    def start(self, guard, digest):
        ident = json.dumps([guard.turn_key,guard.segment,guard.judge_calls],separators=(',',':'))
        self.effect = dict(id=ident,runId=guard.turn_key,segment=guard.segment,digest=digest)
        return ident
    def poll(self, guard):
        if not guard.judge_pending: return False,None
        verdict = dict(stuck=guard.judge_calls != 1,confidence=.9,reason='fixture')
        if verdict['stuck']: verdict['_nudge'] = 'Try a different hypothesis.'
        return True,verdict
turns = []
for mode in ['rules','judge']:
    for budget in [1,2]:
        guard, judge, steps = TurnGuard('run'), FixtureJudge(), []
        thr = scaled_thresholds('default');thr.update(min_turns=8,gate_min_turns=8,gate_over_envelope=False,edit_churn=2,error_outputs=3,backstop_turns=1000 if mode == 'judge' else 12)
        for index in range(45):
            edit = index%4 == 0
            name,args,output,code = ('edit',{'path':'src/a.ts'},'',0) if edit else ('bash',{'command':'pytest'},'AssertionError: value 42',1)
            pending = guard.judge_pending
            ready = None
            if pending:
                ready = dict(id=pending['id'],runId='run',segment=guard.segment,verdict=dict(stuck=guard.judge_calls != 1,confidence=.9,reason='fixture'),writer='Try a different hypothesis.' if guard.judge_calls != 1 else None)
            judge.effect = None
            with patch.object(turn_module.time,'time',lambda:index):
                decision = guard.fold(name,args,output,code,envelope=8,thr=thr,judge=judge if mode == 'judge' else None,nudge_budget=budget)
            action = 'redirect' if decision and decision[0] == 'nudge' else 'notice' if decision else None
            body = guard.nudge_body(envelope=8) if action == 'redirect' else None
            if action == 'redirect': guard.after_nudge()
            elif action == 'notice': guard.abort_delivered = True
            expected = dict(st={key:getattr(guard.st,key) for key in guard.st.__slots__},whole={key:getattr(guard.whole,key) for key in guard.whole.__slots__},segment=guard.segment,cum_turns=guard.cum_turns,nudges_done=guard.nudges_done,aborted=guard.aborted,judge_gap=guard.judge_gap,judge_calls=guard.judge_calls,judge_last=guard.judge_last,last_edit=guard.last_edit,last_verify=guard.last_verify,last_verify_failed=guard.last_verify_failed,edits=guard.edits,verifications=guard.verifications)
            steps.append(json.loads(json.dumps(dict(name=name,args=args,output=output,code=code,now=index*1000,ready=ready,effect=judge.effect,action=action,body=body,reason=decision[1].split(':')[0].split('@')[0] if decision else None,expected=expected))))
        turns.append(case('turn',dict(mode=mode,budget=budget,thresholds=thr,steps=steps),None))
save('turns.json',turns)
