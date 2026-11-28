# Subagents

Implementation: `@kintsugi/subagents`. See [Agent delegation integration](agent-delegation.md) for assembly, lifecycle, and disabling the module.

A **Subagent** is a collaborator created by an Agent for delegated work in the same Workspace. **Subagents** is the feature for inspecting their activity and messages.

The Subagents module contributes system-prompt instructions for root agents and subagents to delegate only
when the user explicitly requests subagents or delegation to other agents. This
includes spawning and assigning follow-up tasks; possible speed or parallelism
is not authorization. This is a model instruction, not a runtime permission gate,
and does not change the pinned tool descriptions below.

## Pinned model-facing contract

Reference: OpenAI Codex [`574a36ff99f0807a24f5b043f593122bf151908d`](https://github.com/openai/codex/tree/574a36ff99f0807a24f5b043f593122bf151908d), cloned at `/persistent/kintsugi-codex-reference` in the implementation workspace. Source descriptions and schemas are attributed in NOTICE; the Apache-2.0 license is in `docs/licenses/codex-LICENSE`.

Kintsugi uses the **MultiAgentV2** tools with role overrides and nickname metadata hidden. `spawn_agent` supports optional model and thinking-level choices:

| Tool | Input | Result |
| --- | --- | --- |
| `spawn_agent` | `task_name`, `message`, optional `fork_turns`, `model` and `thinkingLevel` | `{ task_name: "/root/child" }` |
| `send_message` | `target`, `message` | Empty text acknowledgement |
| `followup_task` | `target`, `message` | Empty text acknowledgement |
| `list_agents` | Optional `path_prefix` | `{ agents: [{ agent_name, agent_status }] }`, including `/root` |
| `wait_agent` | Optional `timeout_ms` | `{ message, timed_out }`, **without duplicating message contents** |
| `interrupt_agent` | `target` | `{ previous_status }` |

Descriptions are copied from the pinned `multi_agents_spec.rs`. Input property descriptions and provider-facing output schemas use the same contract. Encryption annotations are deliberately omitted: all agent-to-agent payloads remain plaintext. The earlier mixed-in v1 `close_agent` and `resume_agent` are no longer exposed to the model; internal close remains available for Agent/Workspace disposal.

Canonical names are `/root`, `/root/review`, `/root/review/check`, etc. Relative references resolve beneath the caller. The same leaf name can exist under different parents. IDs remain internal correlation data rather than part of the message text. A non-root agent can receive follow-up tasks or interruption from another agent in the same tree. Other root trees/workspaces remain isolated.

Pass an enabled, available chat model as `provider/modelId`, for example `github-copilot/mai-code-2`. Omit `model` to inherit the parent’s model. Set `thinkingLevel` to a level supported by the child’s effective model, or omit it to inherit the parent’s level; a changed model clamps inherited thinking to a supported level. Invalid explicit levels fail before a child is created. The Subagents pane shows each main Agent and child’s configured model and thinking level. Follow-up turns retain both settings.

Use **Clear finished** in the Subagents pane to move settled subagents into **Cleared**. Their transcripts and follow-ups remain available, and new activity brings them back to the main list. Active branches stay visible.

`fork_turns` defaults to `all`; `none` starts from the explicit task, and a positive integer string selects recent user turns. Selection happens before filtering, matching the pinned Codex fork policy: user messages and turn-triggering tasks count as turns, but inherited agent traffic is then removed. The child retains user messages and assistant final-answer text, not reasoning, intermediate commentary, tool calls or tool results (including completed exchanges). A numeric mode with no turn boundaries inherits nothing; an oversized count starts at the first boundary, not an earlier summary preamble. Pi supplies the effective post-navigation, compaction-aware context. Its opaque compaction/branch summaries are retained when selected and seeded as child-local summary entries. Host instructions are rebuilt for the child. For providers without Codex phase metadata, final answers use Kintsugi's existing terminal-stop/no-tool-call classification. This matches the filtering policy over Pi's representation; it does not implement Codex-specific rollout metadata or guardian authorization state. Existing sessions are not re-forked on reload. Children inherit model and Thinking level settings, tools, skills and workspace instructions. They share the workspace filesystem—not separate worktrees.

`followup_task` starts an idle child directly from its attributed task message; while running, it steers at message boundaries rather than waiting behind the entire run. There is no fabricated “Carry out the task above” user prompt. `send_message` and automatic completions do not start idle recipients. Wait defaults to 30 seconds, clamps short requests to 10 seconds, and permits up to one hour. It observes undrained session input: pending user steering takes priority over agent mail, including input queued before the wait starts. Waiting never drains input. Pi adding mail to context removes it from wait activity; historical receipts, initial tasks already in context, and child-control operations cannot satisfy a later wait. Clearing the Pi queue removes pending activity; abort cancels the wait. No wait read position is persisted or reconstructed from history.

## Native model delivery—not user-role text

The plaintext payload uses Codex's exact envelope:

```text
Message Type: MESSAGE
Task name: /root
Sender: /root/review
Payload:
The actual message text.
```

Tasks use `NEW_TASK`; final results use `FINAL_ANSWER`. Failure completions include Codex's failure/action wording. The ordinary completion body is the child's final text, without an additional `[completed]` prefix.

Pi persists these as attributed `custom_message` entries. For inference, `SubagentModelInput` bridges Pi's standard message pipeline to a **native Codex Responses input item**:

```json
{
  "type": "agent_message",
  "author": "/root/review",
  "recipient": "/root",
  "content": [{ "type": "input_text", "text": "Message Type: MESSAGE\n..." }]
}
```

On Codex Responses, this is not a `user` message with a decorative prefix. Per-conversion opaque placeholders keep the typed identity through Pi's conversion, and the provider payload hook replaces them before transmission. No placeholder or UUID enters the textual envelope. Ordinary user text, even if it looks like the envelope, does not acquire agent-message semantics. The payload hook also supplies the pinned tool output schemas.

**Provider mapping:** `openai-codex-responses` receives native agent-message items. Other transports, including Anthropic, receive ordinary user messages containing the same attributed plaintext envelope. This mapping happens before Pi serializes the provider request; no native placeholder reaches those APIs. Delivery records retain which format was used. Ordinary conversations without subagent traffic are unchanged. This implementation does not claim to reproduce Codex's entire Rust runtime, provider-independent compaction machinery, role configuration, or residency scheduler. Kintsugi bounds execution to six concurrent children per tree and depth three.

## Presentation is separate from model delivery

Open **Subagents** from the Work-view launcher to see every Agent in the workspace, whether or not an Agent tab is selected. Delegated subagents appear beneath their parents. Expand a subagent to read its transcript. **Clear finished** applies to the Agent whose section it appears in.

Incoming messages appear in the recipient transcript from the durable routing ledger, immediately after receipt is persisted—not only when Pi incorporates them into model context. They are foldable content-rows with a green incoming-message dot and labels such as “Incoming message from: /root/review type: update”. Message, completion and task traffic display as update, completed and task. Expanding the row reveals the body and delivery state, without transport IDs. A subtle **Pending context** label distinguishes queued traffic; failure remains visible. Updating delivery changes the same identified entry, rather than inserting a second copy. Arrival order is a presentation timeline; it is not a claim about provider message ordering or that a model read/acted on a message.

Outgoing messages remain visible as their actual tool calls. Automatic outgoing completion is correlated with the Subagent’s final response. The “Open subagent” action inside an expanded incoming entry opens the Subagents Work view (including if it was closed), expands the corresponding subagent, its parents and **Cleared** if needed, and reveals the related tool call or final response. UUIDs are carried internally for reliable navigation, not shown as prose.

All HTML is server-rendered. The view uses one workspace-wide Cable subscription to keep each delegation tree current. Expanded Subagents use the existing Agent live-presentation streams, including streamed text and tool activity. Collapsed descendants, hidden views and background browser tabs release subscriptions; opening and reconnecting obtain fresh snapshots. There is no polling timer and historical inspection or text selection does not pause other updates. Status updates never replace child transcript DOM. Turbo Frames remain available for explicit historical details and source-navigation requests.

## Persistence and lifecycle

```text
session-shares/<share-key>/subagents/<workspace-id>/state.json       # tree, plaintext messages, delivery
session-shares/<share-key>/subagents/<workspace-id>/<agent-id>.jsonl # native Pi session
```

Ledger writes are serialized and atomically renamed. Task/message IDs connect the sender's tool call, routing event, recipient context and visualization. They remain accessible in the JSON representation for debugging. No application-layer encryption is used; ordinary provider transport security remains unchanged. Do not send secrets in inter-agent messages.

Closing a root Agent stops its descendants. Interrupting a child stops that child's current turn, clears pending input, and retains its transcript and availability. Unacknowledged discarded messages become failed rather than lingering as supposedly deliverable. Workspace removal shuts down coordination and disposes all sessions.

After a server restart, previously running/starting children become interrupted. Unacknowledged traffic becomes failed with an explicit explanation; tasks are not silently replayed. Inspect the retained transcript before resending.

## Automation and verification

Follow [automation.md](automation.md) and discover the running instance's `/openapi.json`.

- `subagents.open` opens `{ "type": "subagents" }`.
- `GET /workspaces/:id/subagents?agent=:agentId` with `Accept: application/json` inspects the tree and ledger.
- A browser workspace URL can select the root and view with `?agent=:agentId&workView=subagents:workspace`.
- `subagent=:childId&message=:messageId` additionally reveals a correlated message after the view is open.

Non-UI tests cover native request serialization, envelopes, tool schemas, output schemas, plaintext-only behavior, provider user-message mapping, paths, history forks, wait/steer/abort, lifecycle, routing isolation and persistence. No UI tests are added. The running instance has been exercised with real model calls using native `agent_message`, both fresh and inherited child contexts, progress messages, final results, follow-up tasks and `list_agents`.

Incoming message disclosures start expanded; user folding survives delivery updates.
They stay outside Working blocks because receipt is independent of a model turn.
The muted **Find source** action reveals the sender's tool call (including spawn and
follow-up task calls); automatic completions reveal its final response instead.
Dedicated spawn/message/follow-up details show the plaintext payload and **Find message
recipient**, which reveals the matching receipt in the destination root or child.

Communication disclosures use the standard tool-card shell with labelled table
rows. Outgoing cards contain Body and Recipient; incoming cards contain Type,
Source and Body, plus Context when pending or failed. Trace navigation expands
and scrolls to its target without adding an outline.

Receipt is persisted before session delivery, so its incoming card appears
immediately outside Working groups. The queued/delivered transition acknowledges
Pi's custom-message `message_end` event (added to session context), not a provider
request or proof that the model read it. Pending context disappears on that
acknowledgement. A separate delivery batch now records the first inclusion in a
prepared provider request, as described below. An idle recipient can have the message in context without a
new inference turn. Outgoing calls stay inside the sender's Working group;
automatic final responses and incoming receipts stay outside it.


### Model-input delivery batches

For delivery accounting, the pending-message queue means messages routed to this
recipient which have not been recorded in a prepared model request. This is distinct
from the live input queue observed by `wait_agent`, which drains when Pi adds input
to context, before provider request preparation. At the Codex payload hook, new messages
are recorded together in a `subagent_model_delivery` session metadata entry. It
contains the plaintext envelopes and a point-in-time remaining count. Metadata is
not itself sent to the model. Normal history replay and request retries do not
create duplicate queue-drain entries. Forked ancestor traffic is not a new receipt
for the child. These records follow session branches and survive restart.

The transcript says “Delivered N messages from queue. Queue is now empty.” (or
reports the remaining count). Each card links to the original receipt and shows
the delivered plaintext envelope. The first request of a run is outside Working;
subsequent requests during the activity go inside Working. This is the provider
payload preparation boundary, **not** HTTP acceptance, successful inference, or a
read receipt; a subsequent request failure does not undo that recorded event.

Native `agent_message` is the Codex Responses input contract. Other transports
use the user-message mapping above. This deliberately provides attribution as
plaintext, not the native transport's typed agent-message identity.

An idle spawn/follow-up task starts inference immediately. Its incoming card is
updated in place with **Delivered as** once the provider payload is prepared;
there is no separate queue-drain item. Ordinary messages waiting for the next
user turn and traffic steered during an active run remain separate receipt and
delivery events. The distinction is recorded when dispatching, not inferred from
elapsed time. Older records without that distinction remain separate.
The source action is one link: **Sent from /root/path here**.


Incoming cards include a **Handling** row. Dispatch records retain the reason at
arrival: an idle task can start inference immediately; an idle ordinary message
waits for a later turn; an active recipient queues traffic for a model-request
boundary; and an active `wait_agent` is identified separately. Waiting in a tool
is not equivalent to idle inference. Delivery does not rewrite that historical
reason. Old records without a reason say it was not recorded rather than guessing
from the recipient's current state. Receipt remains visible before dispatch is
decided, and immediate delivery is only described as completed once its prepared
model-request envelope is recorded.

## Discovering historical delegated sessions

Root and child transcripts remain separate, but both are inside the same durable
read-only session share. From a workspace:

```text
/kintsugi/session-share/
  builtin--<topic>--<workspace-id>--agent-<number>--<root-id>.jsonl
  SUBAGENTS.md
  subagents/<workspace-id>/
    state.json
    <child-id>.jsonl
    <grandchild-id>.jsonl
```

The root's `subagent_history` custom entry supplies the relative directory and root
ID. Older files without it, including filenames without the `builtin--` prefix, use the workspace ID and final conversation UUID in their
filename (including `.archived.jsonl`). In `state.json`, select all `agents` with that
`rootId`; each `id` names a JSONL file and `parentId` links immediate parents. The
ledger's `messages` provide timestamps and originating tool-call IDs for correlation.
The lookup includes closed agents and nested descendants, not unrelated root trees.

These histories survive workspace deletion. Startup preserves older saved Subagents
directories from workspace-private storage before any workspace is deleted. It does
not recreate files already lost to earlier deletion. A child interrupted before session
creation can have a ledger record without a transcript. Session replacement keeps the
same root/tree identity, so use message timestamps/tool-call IDs to identify its run.
