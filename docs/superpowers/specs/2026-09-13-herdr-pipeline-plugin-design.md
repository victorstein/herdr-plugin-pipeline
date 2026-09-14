# herdr-plugin-pipeline — design

**Date:** 2026-09-13
**Status:** Design v1
**Plugin id:** `stein.pipeline`
**Target:** herdr 0.9.0+
**Runtime:** Bun + TypeScript, no build step

## Problem

The superpowers pipeline — brainstorm → spec → adversarial review → plan → adversarial review →
subagent execution → final review → finish branch — currently lives as prose in each repo's
`CLAUDE.md`. `nicaraguan-laws/CLAUDE.md` carries roughly 60 lines of it, including a hand-run
dispatch loop with two documented footguns and an instruction to background three
`herdr wait agent-status` calls per worker agent.

That arrangement has four costs:

1. **The pipeline is re-taught every session.** The whole thing loads into context whether or not
   the session is running a pipeline.
2. **It is duplicated per repo.** `nicaraguan-laws` has it; `crosspoint-x4pro` does not, and would
   need a copy.
3. **The orchestrator does its own bookkeeping.** Backgrounded waits, manual pane closes, manual
   issue/PR/worktree correlation — all spent from the context budget of the agent that should be
   thinking about the work.
4. **Failures are silent.** Nothing catches a worker whose pane exited without finishing, and CI is
   gated by hand.

## Goal

A self-contained herdr plugin that owns the pipeline: it holds the run state, decides what happens
next, supplies the instruction text for each phase just in time, watches CI, and keeps a single
orchestrator agent fed so the human never walks the fleet pane by pane.

## Non-goals

- **Driving brainstorming.** It is the one human gate and stays one.
- **Making merge decisions.** The plugin prompts; the orchestrator merges.
- **Shipping Claude Code skills.** All instruction text lives in this package.
- **Replacing `CLAUDE.md`.** Repo-specific architecture, conventions, and footguns stay there. Only
  the *workflow* sections become redundant.
- **Cross-machine coordination.** Single herdr server, single machine.

## Roles

| Role | What it is | What it does |
| --- | --- | --- |
| **Human** | you | Talks to exactly one pane: the orchestrator |
| **Orchestrator** | a Claude Code agent in a herdr pane, one per repo, long-lived across runs | Writes specs and plans, dispatches adversarial reviews, decomposes tasks, merges, talks to the human. Never edits app code |
| **Worker** | a Claude Code agent in a worktree workspace, one per issue | Implements one task, opens one PR |
| **Plugin** | this package | Owns run state, phase sequencing, all prompt text, event transport, CI polling, teardown |

## Architecture

Three layers in one package. Each is independently testable; the plan stages them as milestones
even though this spec covers all three.

- **L1 Transport** — worktree adoption, orphan-pane reaping, agent status events, durable queue,
  coalesced delivery to the orchestrator, workspace token badges.
- **L2 Runner** — the per-run phase state machine, completion predicates, prompt templates.
- **L3 Integration** — CI supervisor pane, PR/CI events into the same queue, merge → close →
  teardown.

### Verified herdr facts this design depends on

Established against the installed `herdr 0.9.0` binary's API schema (`herdr api schema`) and the
v0.9.0 docs. Each is load-bearing; re-verify before changing.

| Fact | Consequence |
| --- | --- |
| `[[events]] on` accepts dotted names: `worktree.created`, `worktree.removed`, `pane.agent_detected`, `pane.agent_status_changed`, `pane.exited` | These are the plugin's five event hooks |
| Event hooks receive `HERDR_PLUGIN_EVENT_JSON` plus `HERDR_PLUGIN_CONTEXT_JSON`, `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_BIN_PATH` | No socket client needed; shell out to `$HERDR_BIN_PATH` |
| **`plugin.action.invoke` accepts no user arguments** — only `action_id`, `plugin_id`, and a fixed `context` object | Anything carrying data must go through the package's own `hpipe` CLI, not an action |
| `workspace.metadata_updated` does **not** invoke plugin event hooks | The plugin's own token writes cannot cause an event loop |
| Workspace/pane tokens are **not restored after a server restart**; ≤32 keys per resource, ≤16 per report, values capped at 80 chars; plugin `source` must be `plugin:<HERDR_PLUGIN_ID>` | Tokens are display only. The ledger is the truth, and the startup hook reapplies badges |
| `WorkspaceInfo.worktree` carries `repo_key`, `repo_root`, `checkout_path`, `is_linked_worktree` | Parent resolution by repo provenance is possible without being told |
| `herdr agent prompt <target> <text>` submits in one call and rejects with `agent_blocked` if the target is already blocked, **before sending any input** | Safe delivery primitive; a blocked orchestrator cannot be corrupted by a half-typed prompt |
| `herdr agent start` **always opens a new pane**, orphaning a worktree's root shell | The reaper exists |
| `plugin.pane.open` accepts an `env` map | The CI supervisor pane is parameterised without a config file |
| Startup hooks are one-shot, not supervised daemons | Long-running work goes in a plugin *pane*, not a background process |

## Package layout

```
herdr-plugin.toml          # herdr manifest
src/
  hooks/                   # one entrypoint per event
    worktree-created.ts
    agent-detected.ts
    agent-status.ts
    pane-exited.ts
    worktree-removed.ts
  actions/                 # argument-less, keybinding-able
    status.ts  claim.ts  drain.ts  ci-pane.ts
  panes/
    ci-watch.ts            # long-lived supervisor loop
  startup.ts               # reconcile, reapply badges, replay queue, link hpipe, open ci pane
  cli.ts                   # `hpipe` — everything that needs arguments
  lib/
    herdr.ts               # typed $HERDR_BIN_PATH wrapper
    store.ts               # atomic JSON read/modify/write
    ledger.ts              # orchestrators + runs
    queue.ts               # append, lock, coalesce, flush
    machine.ts             # phase transitions + completion predicates
    render.ts              # template rendering
    badges.ts              # workspace tokens
    gh.ts                  # typed `gh` wrapper
prompts/
  spec.md  spec-review.md  plan.md  plan-review.md  dispatch.md
  task.md  task-review.md  ci-red.md  merge.md  close.md  branch-review.md
  escalate.md  stall-probe.md  digest.md
test/
  fixtures/                # captured event JSON, gh JSON, workspace lists
  *.test.ts                # bun:test
```

No `[[build]]`. Bun executes `.ts` directly, so `herdr plugin link` is instant during development
and a GitHub install needs no toolchain beyond bun. `bun build --compile` to a single binary stays
available later; it would add a `[[build]]` entry and change manifest commands to the binary path,
and is explicitly out of scope for v1.

## Manifest

```toml
id = "stein.pipeline"
name = "Pipeline"
version = "0.1.0"
min_herdr_version = "0.9.0"
description = "Drives the superpowers pipeline across herdr worktrees"
platforms = ["macos", "linux"]

[[startup]]
command = ["bun", "run", "src/startup.ts"]

[[events]]
on = "worktree.created"
command = ["bun", "run", "src/hooks/worktree-created.ts"]

[[events]]
on = "pane.agent_detected"
command = ["bun", "run", "src/hooks/agent-detected.ts"]

[[events]]
on = "pane.agent_status_changed"
command = ["bun", "run", "src/hooks/agent-status.ts"]

[[events]]
on = "pane.exited"
command = ["bun", "run", "src/hooks/pane-exited.ts"]

[[events]]
on = "worktree.removed"
command = ["bun", "run", "src/hooks/worktree-removed.ts"]

[[actions]]
id = "status"
title = "Pipeline status"
contexts = ["global", "workspace"]
command = ["bun", "run", "src/actions/status.ts"]

[[actions]]
id = "claim"
title = "Claim this pane as orchestrator"
contexts = ["pane"]
command = ["bun", "run", "src/actions/claim.ts"]

[[actions]]
id = "drain"
title = "Drain pending events"
contexts = ["global"]
command = ["bun", "run", "src/actions/drain.ts"]

[[actions]]
id = "ci-pane"
title = "Open the CI watch pane"
contexts = ["global"]
command = ["bun", "run", "src/actions/ci-pane.ts"]

[[panes]]
id = "ci-watch"
title = "CI watch"
placement = "split"
command = ["bun", "run", "src/panes/ci-watch.ts"]
```

`min_herdr_version = "0.9.0"` because the design depends on `agent.prompt`'s pre-send
`agent_blocked` rejection and on `plugin.pane.open`'s `env` map, neither of which is verified on
earlier releases.

## State

All state lives in `$HERDR_PLUGIN_STATE_DIR`. Every write is atomic: write to `<file>.tmp`, then
`rename(2)`. Concurrent hook processes are real — herdr spawns one per event.

```
orchestrators.json      repo_key -> { pane_id, workspace_id, claimed_at, source: "claim" | "provenance" }
runs/<run_id>.json      one pipeline run
queue.jsonl             append-only pending events
flush.lock/             mkdir-based mutex for the debounce window
```

### Run

```jsonc
{
  "run_id": "nicaraguan-laws-20260913-chat-meter",
  "repo_key": "…",
  "repo_root": "/Volumes/stein/Documents/development/personal/nicaraguan-laws",
  "title": "chat meter",
  "phase": "spec-review",
  "pass": 1,
  "orchestrator_pane": "w1:p1",
  "phase_entered_at": 1789000000000,
  "artifacts": {
    "spec": "docs/superpowers/specs/2026-09-13-chat-meter-design.md",
    "plan": null,
    "verdicts": { "spec-review-1": "docs/superpowers/reviews/…-spec-1.md" }
  },
  "tasks": [
    {
      "task_id": "t1", "branch": "feat/chat-t4-chat-meter", "issue": 210,
      "workspace_id": "w7", "pane_id": "w7:p1", "root_pane_id": "w7:p0",
      "status": "working", "pr": null, "ci": null, "phase": "execute",
      "text": "…full task text, supplied by the orchestrator via `hpipe task`…"
    }
  ],
  "history": [{ "at": 1789000000000, "from": "spec", "to": "spec-review", "why": "artifact present" }]
}
```

Tasks carry their own `phase` — workers progress independently and in parallel. The run's `phase`
is the *orchestrator's* phase. During `execute` the run sits still while tasks move.

**One active run per repo.** `hpipe start` refuses to open a second run for a `repo_key` that
already has one whose phase is not `done`, and says which run is in the way. Without this, adoption
by repo provenance could not decide which run a new worktree belongs to. `hpipe abort` clears the
way deliberately.

**How a task's fields are learned.** `branch` and `root_pane_id` come from the `worktree.created`
event; `pane_id` from `pane.agent_detected`; `pr` from `gh pr list --head <branch>`; `issue` from
the closing keyword in that PR's body, or from `hpipe task --issue` if the orchestrator registered
it up front. `issue` stays `null` until one of those resolves, and the `close` phase is skipped for
a task that never had one.

The `execute` predicate makes a `gh` call inside an event hook. At this event rate (a handful per
minute) that is acceptable, but it is the one place the hot path touches the network: a `gh`
failure there resolves to "unknown", which is not "done", so the task holds rather than advancing
on bad information.

## Orchestrator identity

Resolution order, first match wins:

1. **Explicit claim.** `claim` action invoked from inside the orchestrator's pane pins
   `HERDR_PANE_ID` into `orchestrators.json`. `hpipe start` claims implicitly the same way.
2. **Repo provenance.** The workspace for this `repo_key` where `worktree.is_linked_worktree` is
   `false`, then its agent pane from `herdr agent list`.
3. **Focused pane** from `HERDR_PLUGIN_CONTEXT_JSON` at event time.

If none resolves, events are queued parentless — `drain` and `status` still work, and the startup
hook retries resolution. Pinned panes are validated on every use; a vanished pane falls back to
step 2.

**A pane registered as an orchestrator is excluded from the event path.** Without this the
orchestrator's own status changes would wake itself in a loop.

## Phase machine

The plugin advances a phase only when its **completion predicate** is satisfied, evaluated on
`pane.agent_status_changed → idle | done` for a pane it knows.

| Phase | Actor | Completion predicate | On success | On failure |
| --- | --- | --- | --- | --- |
| `spec` | orchestrator | spec file exists at the path the prompt named | `spec-review` | — |
| `spec-review` | orchestrator + adversarial subagent | verdict file exists and parses | `CLEAR` → `plan` | else `spec`, `pass`+1 |
| `plan` | orchestrator | plan file exists | `plan-review` | — |
| `plan-review` | as above | verdict file parses | `CLEAR` → `dispatch` | else `plan`, `pass`+1 |
| `dispatch` | orchestrator | ≥1 `worktree.created` adopted into this run | `execute` | — |
| `execute` | workers (per task) | task agent `done`/`idle` **and** `gh pr list --head <branch>` returns a PR | task → `task-review` | pane exited without PR → `failed` |
| `task-review` | orchestrator | verdict file for that task parses | `CLEAR` → task `ci` | else task → `execute`, re-prompt worker |
| `ci` | CI supervisor pane | `gh pr checks` conclusion is terminal | green → task `merge` | red → task `execute` with the failing check |
| `merge` | orchestrator | `gh pr view` reports `merged` | task → `close` | — |
| `close` | orchestrator | `gh issue view` reports `closed` | task → `teardown` | — |
| `teardown` | **plugin, unattended** | `herdr worktree remove --workspace <ws> --force` succeeded | task `done`; last task → run `branch-review` | removal fails → task `orphaned`, surfaced |
| `branch-review` | orchestrator | verdict file parses | `CLEAR` → `done` | else `branch-review`, `pass`+1 |

`pass` is capped at 2 per phase (`MAX_PASSES`). Exceeding it does not advance and does not retry —
it renders `prompts/escalate.md` to the orchestrator, which matches `CLAUDE.md`'s existing rule that
a genuine BLOCKER is one of only two reasons to reach out mid-pipeline.

### Why inference is safe here

The plugin cannot judge whether a review cleared, and it must not try. Instead, **because the
plugin owns the prompt text, it dictates where the answer goes.** Every review prompt it injects
names an output path and requires a trailer:

```
VERDICT: CLEAR
```
```
VERDICT: BLOCKER
BLOCKERS: 2
```

Accepted values are `CLEAR` and `BLOCKER`. The parser reads the last `VERDICT:` line of the file
and nothing else — not the pane, not the prose.

The governing invariant: **a missing or unparseable artifact means "not done".** The plugin holds
the phase and stays silent. An orchestrator that went idle to ask the human a question has not
written the file, so it cannot be falsely advanced. The failure mode is therefore *stalling*, never
*derailing*.

Stalls are caught by a probe: after `STALL_MINUTES` (default 15) in one phase with at least one
idle transition and no artifact, the plugin injects `prompts/stall-probe.md` once per phase —
naming the phase and the expected path, asking whether it is still working or blocked. Once per
phase, never repeated, so a long human conversation is not nagged.

## Event transport

Every hook follows the same pipeline:

1. Parse `HERDR_PLUGIN_EVENT_JSON`.
2. Resolve the workspace to a run + task. Unknown workspace, or a registered orchestrator pane →
   exit 0.
3. Dedup against the task's stored `status`. Unchanged → exit 0.
4. Update the ledger; update the `$status` badge.
5. Append to `queue.jsonl`.
6. If the transition is wake-worthy, attempt the flush.

**Flush.** Try `mkdir flush.lock`. The winner sleeps `DEBOUNCE_MS` (default 2000), then reads and
truncates the queue, evaluates the state machine for every affected run, renders one message, and
calls `herdr agent prompt`. Losers exit immediately — their events are already on disk and the
winner will carry them.

**Wake-worthiness.** `blocked`, `done`, `idle`, and `exited` ring the doorbell. `working` updates
the ledger and the badge but does not — a six-agent fleet would otherwise interrupt the
orchestrator at every turn boundary. `WAKE_ON` in config controls this.

**Delivery failure.** `agent_blocked` (the orchestrator is itself stuck on a prompt) or a missing
pane leaves the queue intact and schedules a bounded retry with backoff
(`PROMPT_RETRY_MAX`, default 5). After that the events stay queued for the startup hook or a manual
`drain`. Nothing is dropped: the disk queue is the truth and the prompt is only a doorbell.

**Message shape.** One coalesced message per flush, phase transitions first:

```
[pipeline] run nicaraguan-laws-20260913-chat-meter → task-review

3 events:
- feat/be-d3-top-laws (#208, w4) done, PR #412 open
- fix/norma-url-default (#209, w6) blocked
    "Do you want to proceed? ❯ 1. Yes  2. No"
- feat/chat-t4-chat-meter (#210, w7) exited (status 1), no PR

<rendered prompt for the phase the run just entered>
```

`blocked` lines inline up to `BLOCKED_TAIL_LINES` (default 8) of
`herdr pane read <pane> --source visible` so the orchestrator can usually decide without a round
trip.

## Orphan root-pane reaper

`herdr agent start` always opens a new pane, leaving the worktree's root shell orphaned as `p1`.
On `pane.agent_detected` in an adopted workspace the plugin closes it, but only when **all** hold:

- the workspace is in the ledger,
- it has more than one pane,
- the candidate is the `root_pane_id` recorded at `worktree.created`,
- it has no agent,
- `pane.process_info` reports no foreground process other than the login shell.

Any doubt means leave it. Closing a live pane is worse than leaving a dead one, and this replaces a
step the human currently performs by hand.

### Teardown re-entrancy

Teardown is the plugin calling `herdr worktree remove`, which emits `worktree.removed`, which is one
of the plugin's own hooks. That hook must therefore be idempotent: a task already in `done` is a
no-op, not a second transition. The same hook also handles a worktree the human removed by hand,
which marks the task `orphaned` rather than `done`.

## CI supervisor

A `[[panes]]` entrypoint (`placement = "split"`) running a visible poll loop, opened by the startup
hook via `plugin.pane.open` when any run has an open PR. For each task with a PR it polls
`gh pr checks <pr> --json name,state,conclusion` every `CI_POLL_SECONDS` (default 30) and enqueues
an event when a PR's aggregate conclusion changes. It renders a simple table so the state is
legible without asking anyone.

A real herdr pane rather than a background daemon: supervised, restored with the session, and
visibly dead when it dies. Its output is not parsed by anything — the queue is the interface.

## Prompt templates

`prompts/<phase>.md`, rendered by substituting `{{run_id}}`, `{{title}}`, `{{repo_root}}`,
`{{spec_path}}`, `{{plan_path}}`, `{{verdict_path}}`, `{{pass}}`, `{{task_text}}`, `{{branch}}`,
`{{issue}}`, `{{pr}}`, `{{ci_failure}}`. An unresolved placeholder is a hard error, not an empty
string — a prompt that silently renders `{{spec_path}}` as nothing sends an agent to write a file
nowhere.

Each template ends with an explicit statement of where its output must go and, for reviews, the
required `VERDICT:` trailer. Only the current phase is ever injected, which is strictly less
context than today's `CLAUDE.md` loading the whole pipeline every session.

`prompts/dispatch.md` carries the two dispatch footguns verbatim from `nicaraguan-laws/CLAUDE.md`
(pass `--workspace`; close the orphaned root pane) — the reaper handles the second automatically,
but the orchestrator is still told, because a plugin that silently fixes a mistake teaches nothing
when it is absent.

`prompts/digest.md` is not a phase. It is the wrapper for the coalesced flush message — the
`[pipeline] …` envelope around the event list and the next phase's prompt.

### Who owns the worker's prompt

The plugin owns every instruction *except* what the task is, which only the orchestrator knows. The
split is enforced by making the orchestrator register each task rather than compose its own prompt:

```
hpipe task --branch feat/chat-t4-chat-meter --issue 210 --text "<full task text>"
```

`hpipe task` records the task on the run and prints the **fully rendered worker prompt** —
`prompts/task.md` wrapped around the supplied text, carrying the contract the plugin needs back:
where to write the task-review verdict, the requirement that the PR body end in a real closing
keyword (`Closes #N`, never "Implements #N", which does not auto-close), and the escalation rule.
The orchestrator passes that output straight to `herdr agent start`. `prompts/dispatch.md` tells it
to do exactly this.

This keeps the contract in the package and out of the orchestrator's memory, without pretending the
plugin can know the work.

## The `hpipe` CLI

Manifest actions take no arguments, so everything carrying data goes through a CLI the package
ships. The startup hook idempotently symlinks `src/cli.ts` to `~/.local/bin/hpipe`
(`HPIPE_LINK_PATH`, skippable with `HPIPE_LINK=0`).

| Command | Purpose |
| --- | --- |
| `hpipe start "<title>"` | Open a run in the current repo, claim the calling pane as orchestrator, inject `prompts/spec.md` |
| `hpipe task --branch <b> [--issue <n>] --text <t>` | Register a task and print its fully rendered worker prompt |
| `hpipe status [--run <id>]` | Ledger + live agent statuses, human and agent readable |
| `hpipe drain [--run <id>]` | Print and clear queued events in full detail |
| `hpipe abort <run_id>` | Stop driving a run; leaves worktrees and branches alone |
| `hpipe forget <workspace_id>` | Unbind a workspace from its run |

`hpipe start` is the only thing the human or orchestrator must know to begin. Everything after it
is injected.

## Configuration

`$HERDR_PLUGIN_CONFIG_DIR/config.env`:

| Key | Default | Meaning |
| --- | --- | --- |
| `DEBOUNCE_MS` | `2000` | Coalescing window |
| `WAKE_ON` | `blocked,done,idle,exited` | Transitions that prompt the orchestrator |
| `MAX_PASSES` | `2` | Review passes before escalating |
| `STALL_MINUTES` | `15` | Idle-without-artifact before the probe |
| `CI_POLL_SECONDS` | `30` | Supervisor poll interval |
| `PROMPT_RETRY_MAX` | `5` | Delivery retries before leaving it queued |
| `BLOCKED_TAIL_LINES` | `8` | Pane tail inlined for a blocked worker |
| `REAP_ORPHAN_ROOT_PANE` | `1` | Reaper on/off |
| `REPOS_ALLOW` | *(empty = all)* | Repo-key allowlist |
| `HPIPE_LINK` / `HPIPE_LINK_PATH` | `1` / `~/.local/bin/hpipe` | CLI symlink |

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Ambiguous parent resolution | Warn to stderr (visible in `herdr plugin log list`), fall back, else queue parentless |
| Orchestrator pane closed | Prompt fails; queue survives; startup hook re-resolves and replays |
| Orchestrator itself blocked | `agent_blocked` before any input is sent; bounded retry; queue intact |
| Two orchestrators on one repo | `REPOS_ALLOW` plus explicit `claim` disambiguate; provenance alone would pick one arbitrarily |
| Concurrent hook processes | Atomic rename on every write; `mkdir` mutex on the flush |
| Server restart / live handoff | Tokens lost (herdr does not restore them) and reapplied by the startup hook; ledger and queue are on disk and survive |
| `gh` unauthenticated or rate-limited | CI pane surfaces the error and keeps polling; PR predicates report "unknown", which is not "done", so nothing advances |
| Unparseable verdict file | Treated as absent. Phase holds. Stall probe eventually asks |
| Worker pane exited without a PR | Task marked `failed` and surfaced to the orchestrator — a case nothing catches today |

## Testing

`bun:test`, with a fake `herdr` and a fake `gh` earlier on `PATH` than the real ones, both replaying
fixture JSON captured from a live session. The whole state machine is then driven with no server and
no network.

- **Unit:** parent resolution, dedup, coalescing, verdict parsing (including malformed and
  multi-`VERDICT:` files), template rendering (including the unresolved-placeholder error), badge
  clamping to herdr's 80-char/32-key limits.
- **State machine:** every transition in the phase table, driven from fixture events; every failure
  branch; `MAX_PASSES` exhaustion; the stall probe firing exactly once per phase.
- **Concurrency:** N hook processes racing one flush; assert exactly one prompt and no lost events.
- **Integration smoke (one, live):** link the plugin, create a throwaway worktree, assert adoption,
  reaping, and a delivered prompt.

## Deferred

- `$issue` / `$pr` badges before a run's `dispatch` phase — nothing knows the numbers until then.
- `bun build --compile` single-binary distribution.
- Link handlers (clicking a PR URL to jump to its task).
- Marketplace publication (`herdr-plugin` GitHub topic).
- Trimming the now-redundant workflow prose from `nicaraguan-laws/CLAUDE.md` — a separate change to
  a separate repo, made only once this plugin has earned it in practice.
