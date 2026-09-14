# herdr-plugin-pipeline — design

**Date:** 2026-09-13
**Status:** Design v3 — revised after two adversarial reviews (`reviews/2026-09-13-design-adversarial-1.md`, `-2.md`, both `VERDICT: BLOCKER`)
**Plugin id:** `stein.pipeline`
**Target:** herdr 0.9.0+
**Runtime:** Bun + TypeScript, no build step

> **v3 changes.** Review 2 audited review 1's fixes and found 17 genuinely fixed, **6 cosmetic, 6
> displaced** — one consistent pattern: *v2 fixed defects at the run level and left the identical
> defect at the task level.* Edge-triggered predicates were given to runs and withheld from tasks, so
> the livelock survived in eight rows. A `gh` field was verified for `pr checks` and an unverified one
> written into `pr view` a row above it. The settle check kept its name and changed its subject,
> dropping the agent-status guard it was meant to add — and v2's phase table dropped the agent-idle
> condition entirely, so the supervisor would have advanced on a file alone while the orchestrator was
> still mid-turn.
>
> Four v2 claims are withdrawn as **false, each disproved live**: the startup hook can open the
> supervisor pane on a cold start (it cannot — `no_active_workspace`); a dead supervisor "dies visibly
> in a pane" (the pane *vanishes*); queue rotation loses nothing (a post-rename append lands in the
> rotated file and is unrecoverable after unlink); and "single herdr server" (two are running, with 13
> named sessions on disk — so runs, registries, and the supervisor are now **scoped per session**).

## Problem

The superpowers pipeline — brainstorm → spec → adversarial review → plan → adversarial review →
subagent execution → final review → finish branch — lives as prose in each repo's `CLAUDE.md`.
`nicaraguan-laws/CLAUDE.md` carries ~60 lines of it, including a hand-run dispatch loop and an
instruction to background three `herdr wait agent-status` calls per worker.

1. **Re-taught every session** — loaded whether or not a pipeline is running.
2. **Duplicated per repo** — `nicaraguan-laws` has it; `crosspoint-x4pro` does not.
3. **The orchestrator does its own bookkeeping** — spent from the context budget of the agent that
   should be thinking about the work.
4. **Failures are silent** — nothing catches a worker whose pane exited without finishing.
5. **That prose is now wrong** — it documents a `herdr agent start` signature 0.9.0 rejects. Prose
   drifts; a package with tests does not.

## Goal

A self-contained herdr plugin that owns the pipeline: run state, phase sequencing, just-in-time
instruction text, CI, and teardown — keeping one orchestrator agent fed so the human never walks the
fleet pane by pane.

## Non-goals

- **Driving brainstorming.** The one human gate stays one.
- **Making merge decisions.** The plugin prompts; the orchestrator merges.
- **Shipping Claude Code skills.** All instruction text lives in this package.
- **Replacing `CLAUDE.md`.** Repo-specific architecture and conventions stay there.
- **Fixing `nicaraguan-laws/CLAUDE.md` or `~/.claude/skills/herdr`**, both carrying the stale
  `agent start` signature. Flagged, out of scope, tracked separately.
- **Cross-machine coordination.** Multiple local sessions are supported (see §Sessions); `--remote`
  is not — see the `--remote` row in §Failure modes.

## Roles

| Role | What it is | What it does |
| --- | --- | --- |
| **Human** | you | Talks to exactly one pane: the orchestrator |
| **Orchestrator** | a Claude Code agent in a herdr pane, one per repo per session | Writes specs and plans, dispatches adversarial reviews, decomposes tasks, merges, talks to the human. Never edits app code |
| **Worker** | a Claude Code agent in a worktree workspace, one per issue | Implements one task, opens one PR |
| **Supervisor** | a plugin-owned pane, one **per session** | The only component with a clock. Drains the queue, evaluates predicates, advances phases, delivers prompts, polls CI, runs teardown |
| **Plugin hooks** | five one-shot processes | Write one event file and exit |

## Execution model

This section governs everything below it.

**herdr spawns one process per event hook and caps plugin commands at 32 concurrent. Over the cap it
drops the event** — verified live, including a dropped `worktree.created`. A hook that blocks holds a
slot for its whole duration.

> **A hook parses its event, writes one event file, and exits.** Never sleeps, never calls `gh`,
> never calls `herdr`, never evaluates a predicate, never renders a prompt. Target under 50 ms —
> measured: a warm `bun run` of a trivial script is 10 ms, and 40 concurrent invocations complete in
> 279 ms wall with zero lost writes.

All intelligence lives in the **supervisor**, one long-lived process per session:

```
every TICK_MS (default 1000):
  drain queue           →  glob queue/*.json, read, unlink; dedup; update tasks; refresh badges
  evaluate predicates   →  only for runs in THIS session, edge-triggered, actor-idle gated
  deliver               →  render prompts; herdr agent prompt; retry with backoff across ticks
  every CI_POLL_SECONDS →  gh pr checks for tasks with open PRs
  check stalls          →  artifact-phase runs only (see §Stalls)
  teardown              →  tasks whose issue is confirmed closed
```

One process with a clock replaces v1's in-hook `sleep` and per-hook retry loop, and gives
`STALL_MINUTES` and `PROMPT_RETRY_MAX` somewhere to live.

**The supervisor is mandatory infrastructure. If it is not running, nothing advances.** It is a pane
because a pane is *observable while running* and is restored and supervised by herdr — **not** because
it leaves a visible corpse. It does not: a plugin pane is destroyed when its command exits
(`pane_not_found` after `kill`, verified). Two consequences, both designed for:

- The manifest command wraps the process so a death leaves a readable pane rather than none:
  `sh -c 'bun run src/supervisor/main.ts; echo "[pipeline] supervisor exited — run hpipe status"; exec $SHELL'`.
  The singleton-guard path prints `another supervisor is live (pid N, session S)` before dropping to
  the shell.
- **`hpipe status` is the death detector, not the pane.**

### Startup reconciliation

A startup hook **cannot** simply open the pane. Verified live on a cold start:

```
STARTUP pane open rc=1 out={"error":{"code":"no_active_workspace","message":"no active workspace"}}
```

…and herdr logged that hook as `"status":"succeeded","exit_code":0` — the failure is invisible to
`plugin log list` unless the hook inspects the JSON. Worse, after a server restart the old supervisor
pane is **restored as a plain interactive shell still labelled "Supervisor"** (snapshot restore does
not re-run plugin pane commands), and a blind hook opens a *second* pane beside the ghost.

The startup hook therefore reconciles:

1. `workspace list`; if none carries `PIPELINE_WORKSPACE_LABEL`, `workspace create --label <label>
   --no-focus` — and close the stray root pane it creates.
2. `pane list --workspace <id>`; close every pane labelled as the supervisor whose pid is not the live
   one in `supervisor.<session>.pid`. **This is the one piece of v1's deleted reaper the architecture
   actually needs** — for ghosts, not for worktrees.
3. Only then `plugin pane open --workspace <id> --placement tab --no-focus`, **checking the response
   body for an `error` key** rather than trusting the exit code.

### Sessions

herdr named sessions are separate servers with separate sockets, but **plugins and their state are
global to the user**, and **pane ids are not unique across sessions** — `w1:p1` exists in all of them.
Two servers are running on this machine right now with 13 named sessions on disk, so this is not
hypothetical: an unqualified `orchestrator_pane: "w3:p1"` would send a several-hundred-line prompt
into an unrelated agent in another session, and `agent prompt` submits even while the target is
working.

Everything is therefore session-scoped:

- Run records live under `runs/<session>/`, and each carries `session` and `socket_path`.
- `orchestrators.json` is keyed `<session>/<repo_key>`.
- The pid file is `supervisor.<session>.pid`; one supervisor **per running server**.
- The supervisor skips any run whose `session` is not its own.
- `hpipe` stamps `HERDR_SESSION` on every write — verified present in pane shells alongside
  `HERDR_PANE_ID` and `HERDR_SOCKET_PATH`.

### Verified herdr facts

Re-derived from `herdr 0.9.0` and independently re-verified in review 2. Prose in any `CLAUDE.md` is
**not** a source. Re-verify before changing.

| Fact | Evidence | Consequence |
| --- | --- | --- |
| `herdr agent start <NAME> --kind <KIND> --pane <ID>` adopts an **existing pane at a shell prompt**; `AgentStartParams` requires `name`, `kind`, `pane_id` | `agent start --help`; schema | **No orphaned root pane exists.** Dispatch reuses the worktree's root pane |
| `worktree.created` carries `workspace` + `worktree`, **no pane id** | live capture | Root pane comes from the `worktree create` response or `pane list --workspace` |
| Plugin commands cap at **32 concurrent**; over the cap herdr drops the event | live: `maximum concurrent plugin commands reached (32)` | Hooks must not block |
| `plugin.pane.open` fails with `no_active_workspace` during startup restore, and returns errors in the **body** while the hook exits 0 | live | The reconcile step above |
| A restored session brings a plugin pane back as a **plain shell keeping its label** | `session-state.mdx:33`; live | Ghost-pane reaping, by pid |
| A plugin pane is **destroyed** when its command exits | live `pane_not_found` after `kill` | Wrap the command; `hpipe status` detects death |
| `plugin pane open --placement tab` with no `--workspace` lands in the **active** workspace; `workspace create` also makes a stray root pane | live | Always pass `--workspace`; close the stray |
| Plugins and their state/config dirs are **global to the user**; sockets and pane ids are **per session**; pane shells carry `HERDR_SESSION` | `plugins.mdx:196-197`; live env capture | §Sessions |
| Event-hook context `focused_pane_id` is whatever is focused at event time — during dispatch, the worker | live: focused `w1:p1`, hook reported `w5:p1` | Focused-pane fallback **deleted** |
| `pane.exited` payload is `{type, pane_id, workspace_id}` — **no exit status** | live capture | Digest reports "exited", never "exited (status N)" |
| Claude Code state authority is the **screen manifest**; unmatched prompts fall back to `idle` | `agents.mdx:28,50,60` | §Limits of inference |
| `pane.agent_detected` also fires on agent **release** | docs + live | A release on a task's pane marks it `failed` |
| `herdr agent prompt` rejects with `agent_blocked` **before sending input**; otherwise writes "including while the agent is working" | `agent prompt --help` | Delivery is gated on actor idle, not on hope |
| `gh pr checks --json` → `bucket, completedAt, description, event, link, name, startedAt, state, workflow`. **No `conclusion`.** Exit 8 = pending | `gh pr checks --help`, gh 2.96.0 | Use `bucket`; exit 8 is pending, not failure |
| `gh pr view --json` has **no `merged`** field; it has `state`, `mergedAt`, `headRefOid` | `gh pr view --json merged` → `Unknown JSON field` | Merge = `state == "MERGED"`; `headRefOid` is the work-happened signal |
| `gh issue view --json closed` **does** exist | verified | The `close` predicate is sound |
| `plugin.action.invoke` accepts no user arguments | schema `PluginActionInvokeParams` | Data goes through `hpipe` |
| `workspace.metadata_updated` is **rejected as an unknown event name at link time** | live link warning | Never declare it |
| Tokens are not restored after a server restart; ≤32 keys, ≤16/report, values ≤80 chars; plugin `source` must be `plugin:<HERDR_PLUGIN_ID>` | socket-api.mdx; verified | Display only; supervisor reapplies |
| `WorkspaceInfo.worktree` carries `repo_key`, `repo_root`, `checkout_path`, `is_linked_worktree` | schema | Parent resolution by repo provenance |
| APFS `st_mtime_ns` is nanosecond-granular; no clock skew locally | verified | mtime comparison is sound — settled, do not re-litigate |

`min_herdr_version = "0.9.0"` because `agent start`'s `--kind`/`--pane` signature is the 0.9.0 shape
and the plugin depends on it directly.

## Package layout

```
herdr-plugin.toml
src/
  hooks/        worktree-created.ts  agent-detected.ts  agent-status.ts
                pane-exited.ts       worktree-removed.ts
  supervisor/   main.ts  ci.ts  teardown.ts
  actions/      status.ts  claim.ts  drain.ts  supervisor.ts
  startup.ts    # reconcile workspace + ghosts, reapply badges, link hpipe, open supervisor
  cli.ts        # `hpipe`  (#!/usr/bin/env bun, mode 0755 in git)
  lib/          herdr.ts  gh.ts  store.ts  ledger.ts  queue.ts
                machine.ts  predicates.ts  render.ts  badges.ts
prompts/        spec.md  spec-review.md  plan.md  plan-review.md  dispatch.md
                task.md  task-review-spec.md  task-review-quality.md
                ci-red.md  merge.md  close.md  branch-review.md
                escalate.md  stall-probe.md  digest.md
test/           fixtures/  *.test.ts
```

No `[[build]]` — Bun executes `.ts` directly.

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
# …agent_detected, agent_status_changed, pane.exited, worktree.removed identically

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
id = "supervisor"
title = "Reopen the supervisor"
contexts = ["global"]
command = ["bun", "run", "src/actions/supervisor.ts"]

[[panes]]
id = "supervisor"
title = "Pipeline supervisor"
placement = "tab"
command = ["sh", "-c", "bun run src/supervisor/main.ts; echo '[pipeline] supervisor exited — run hpipe status'; exec $SHELL"]
```

## State

`$HERDR_PLUGIN_STATE_DIR`, every write atomic (`.tmp` → `rename(2)`):

```
orchestrators.json            "<session>/<repo_key>" -> { pane_id, workspace_id, socket_path, claimed_at }
runs/<session>/<run_id>.json
queue/<ts>-<pid>-<rand>.json  one file per event
supervisor.<session>.pid      { pid, started_at_ms, boot_id, session, socket_path, pane_id }
```

**The queue is one file per event, not an appended log.** A hook writes `<name>.json.tmp` then
renames it to `<name>.json`; the supervisor globs `queue/*.json`, reads, and unlinks each processed
file. A partially written event is still `.tmp` and invisible.

v2's rotate-then-read was proved lossy: `rename(2)` moves the directory entry, not an open file
description, so a hook holding an `O_APPEND` fd writes into the *rotated* file — and into a deleted
inode once the supervisor unlinks it. One file per event removes the shared inode entirely and matches
the atomic-rename rule already stated for every other write.

### Run

```jsonc
{
  "run_id": "nicaraguan-laws-20260913-chat-meter-a1b2",
  "session": "personal", "socket_path": "/…/sessions/personal/herdr.sock",
  "repo_key": "…", "repo_root": "/…/nicaraguan-laws",
  "title": "chat meter",
  "phase": "spec-review", "pass": 1, "phase_entered_at": 1789000000000,
  "escalated_from": null,
  "orchestrator_pane": "w1:p1",
  "artifacts": {
    "spec": "docs/superpowers/specs/2026-09-13-chat-meter-design.md",
    "plan": null,
    "verdicts": { "spec-review-1": "docs/superpowers/reviews/…-spec-1.md" }
  },
  "tasks": [{
    "task_id": "t1", "branch": "feat/chat-t4-chat-meter", "issue": 210,
    "surface": "core", "depends_on": [], "files": ["packages/core/src/db/"],
    "keep_worktree": false,
    "workspace_id": "w7", "pane_id": "w7:p1",
    "agent_status": "working",
    "phase": "execute", "pass": 1,
    "phase_entered_at": 1789000090000, "head_sha_at_entry": "9f3c…",
    "pr": null, "ci": null,
    "text": "…full task text, supplied via `hpipe task`…"
  }],
  "history": [{ "at": …, "from": "spec", "to": "spec-review", "why": "actor idle + artifact mtime > phase_entered_at" }]
}
```

**Tasks carry their own `phase_entered_at`, `head_sha_at_entry`, and `pass`.** v2 put these on the run
only, which left v1's livelock intact for every task row: a task bouncing `execute ↔ task-review-spec`
re-satisfied `execute`'s PR predicate immediately, because the PR still existed and the run's
`phase_entered_at` never moved. Verdict paths are keyed per task **and** pass —
`verdicts["<task_id>-task-review-spec-<pass>"]` — so pass 2 cannot read pass 1's file.

`run_id` ends in a random suffix; date + slug alone collide on a same-day retry. `agent_status`
(herdr's view) is deliberately distinct from `phase` (the pipeline's view).

**One active run per repo per session.** `hpipe start` refuses a second and names the one in the way.

**Task field provenance.** `branch`, `workspace_id` from `worktree.created`; `pane_id` from
`pane.agent_detected`; `surface`, `depends_on`, `files`, `issue`, `text`, `keep_worktree` from
`hpipe task`; `pr` from `gh pr list --head <branch>`; `head_sha_at_entry` from
`gh pr view --json headRefOid`; `ci` from `gh pr checks`. `issue` is **required** —
`CLAUDE.md:66` makes an issue per task mandatory.

## Orchestrator identity

1. **Explicit claim** — the `claim` action from inside the orchestrator's pane pins `HERDR_PANE_ID`
   and `HERDR_SESSION`. `hpipe start` claims implicitly.
2. **Repo provenance** — the workspace in *this session* for this `repo_key` with
   `is_linked_worktree == false`, then its agent pane.

No third fallback: v2's `focused_pane_id` fallback resolved to the *worker's* pane. If neither step
resolves, events stay queued, the supervisor retries each tick, and `status` reports it. Two
orchestrators on one repo are disambiguated **only** by explicit `claim` — `REPOS_ALLOW` is a repo
allowlist and cannot distinguish two panes in one repo.

**Waking and evaluation are separate.** The orchestrator pane never generates a prompt *to itself*;
it is emphatically **not** excluded from evaluation — its `idle`/`done` transitions are the trigger
for the ten orchestrator-owned rows below.

## Phase machine

Fourteen rows; **ten are orchestrator-owned**. Every orchestrator-owned predicate is
`actor pane idle|done` **and** `artifact fresh`. v2 dropped the agent condition from the table, which
would have fired `spec-review` one second after the `Write` tool call landed the spec file — while the
orchestrator was still explaining it to the human. That is the normal path, not an edge case.

| Phase | Actor | Completion predicate | Success | Failure |
| --- | --- | --- | --- | --- |
| `spec` | orchestrator | actor idle **and** spec file fresh | `spec-review` | — |
| `spec-review` | orchestrator | actor idle **and** verdict fresh, parses | `CLEAR` → `plan` | else `spec`, `pass`+1 |
| `plan` | orchestrator | actor idle **and** plan file fresh | `plan-review` | — |
| `plan-review` | orchestrator | actor idle **and** verdict fresh, parses | `CLEAR` → `dispatch` | else `plan`, `pass`+1 |
| `dispatch` | orchestrator | ≥1 task registered **and** ≥1 worktree adopted | `execute` | — |
| **t** `queued` | supervisor | `depends_on` all `done`, no in-flight `files` overlap | task `execute`; supervisor delivers the worker prompt | cycle → rejected at registration |
| **t** `execute` | worker | worker idle/done **and** PR exists **and** `headRefOid != head_sha_at_entry` | task `task-review-spec` | pane exited or agent released → task `failed` |
| **t** `task-review-spec` | orchestrator | actor idle **and** verdict fresh, parses | `CLEAR` → `task-review-quality` | else task `execute`, `pass`+1 |
| **t** `task-review-quality` | orchestrator | actor idle **and** verdict fresh, parses | `CLEAR` → task `ci` | else task `execute`, `pass`+1 |
| **t** `ci` | supervisor | `gh pr checks` bucket terminal **and** changed | `pass` → task `merge` | `fail` → task `execute` with the failing check |
| **t** `merge` | orchestrator | `gh pr view --json state` is `MERGED` | task `close` | — |
| **t** `close` | orchestrator | `gh issue view --json closed` is true | task `teardown` | — |
| **t** `teardown` | supervisor | `worktree remove --workspace <ws> --force` succeeded | task `done`; unblocks `queued`; last → run `branch-review` | removal fails → task `orphaned`; `keep_worktree` → skip to `done` |
| `branch-review` | orchestrator | actor idle **and** verdict fresh, parses | `CLEAR` → `done` | else `branch-review`, `pass`+1 |

Two review phases per task, per `CLAUDE.md:46`.

**Delivery is gated too.** Before any `herdr agent prompt`, the supervisor re-reads the actor with
`agent get <pane>` and requires `idle`/`done` both at predicate evaluation and again `SETTLE_MS`
later; a momentary misclassification will have flipped back to `working` or `blocked` by then. This
is round 1's guard, which v2 silently replaced with a file check under the same config key.

### Ordering and collisions

`queued` is every task's entry state. It opens when `depends_on` are `done` and no in-flight task
declares an overlapping `files` prefix.

**`hpipe task` withholds the rendered worker prompt until the gate opens** — it prints `task_id: t1`
and `queued: waiting on t0`, and the supervisor delivers the prompt when the task leaves `queued`.
In v2 the CLI printed the prompt at registration, so the orchestrator would dispatch immediately and
the gate was advisory. Registration rejects a `--depends-on` cycle (Kahn's algorithm, naming the
cycle).

`--files` takes **prefix globs** and is stated plainly as a *declared-intent heuristic, not
enforcement*: `CLAUDE.md:92-94` forbids two agents editing the same files, which is about actual
edits. The real backstop stays the orchestrator's PR-level conflict check before merge.

**`core` first** (`CLAUDE.md:95-97`) is *not* only an ordering rule — it is "let it land **and rebuild
`dist`**". `prompts/task.md` therefore renders one extra line when the task has a `core` dependency:
rebuild `@repo/core` before the first edit and before opening the PR. v2 claimed the rule while
omitting the half that names the failure.

**Surface routing.** `{{surface}}` and `{{agent_file}}` (`.claude/agents/<surface>-dev.md`) render
into `prompts/task.md` per `CLAUDE.md:76`. `hpipe task` **rejects a `--surface` with no matching agent
file** under the run's `repo_root` — all six exist today, which is exactly why a typo would otherwise
render a plausible dead path silently.

### Predicates are edges, not levels — at both levels

Every predicate compares against the **relevant record's** `phase_entered_at` (run for run phases,
task for task phases):

- **file** — `mtime > phase_entered_at`, plus a stability re-read. Stated honestly: this guards
  against reading a file mid-`write(2)`; **it does not prove the artifact is finished.** The real
  completeness signal for a review artifact is that the `VERDICT:` trailer is the **last non-empty
  line**, which a mid-write file will not have.
- **PR** — `headRefOid` must differ from `head_sha_at_entry`. `updatedAt` moves on any comment or
  label change and is not a work-happened signal.
- **CI** — a bucket *change*, not merely a terminal bucket.

### Limits of inference

Claude Code's state authority is the screen manifest, and an unmatched prompt falls back to `idle`
(`agents.mdx:60`). An agent can be reported idle while working.

**The invariant, stated honestly:** the plugin never advances on a stale artifact, never on one still
being written, never without the actor pane reading idle twice `SETTLE_MS` apart, and never invents a
verdict. It can still be early if an agent writes a complete artifact and keeps going. That residual
risk is accepted; the orchestrator is a live agent that can see it, and `hpipe rewind` is the escape.

### The verdict contract

Every review prompt names its output path and requires a trailer as the last non-empty line:

```
VERDICT: CLEAR
```
```
VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 3
```

**`BLOCKER` means: any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or
needs a judgment only the user can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.**
That is `CLAUDE.md:28-30` verbatim, including its qualifier.

v2 flattened it to "any MAJOR", which crossed with `MAX_PASSES` made **escalation the default
outcome** — an adversarial review finds a MAJOR on almost any first draft, so a run would escalate at
the spec gate before dispatching a single task, contradicting `CLAUDE.md:36-37`. This document's own
history is the worked example: under v2's rule, v2 would have escalated.

`escalated` is a real phase, recording `escalated_from`. `hpipe rewind` resets `pass` to 0 for the
phase it rewinds to, so a human who answers an escalation is not immediately re-escalated.

### Stalls

The stall probe fires **only for phases whose predicate is a file** (`spec`, `spec-review`, `plan`,
`plan-review`, `task-review-spec`, `task-review-quality`, `branch-review`), when
`now - phase_entered_at > STALL_MINUTES` and the actor has been idle/done since entry. Once per phase.

v2 fired it on any phase with no artifact — but `dispatch`, `queued`, `execute`, `ci`, `merge`,
`close` and `teardown` have no artifact *by design*, so a healthy six-worker run would have been
probed 15 minutes in, during the phase where the orchestrator is busiest. `execute` gets its own
per-task liveness rule instead: no `agent_status` change and no PR after `TASK_STALL_MINUTES`.

## Event transport

Hooks write one event file and exit. The supervisor each tick drains, drops events for foreign
sessions and unknown workspaces, dedups against the ledger, updates tasks, refreshes `$status` /
`$branch` badges (clamped to 80 chars / 32 keys), evaluates predicates, and renders **one coalesced
message per orchestrator** from `prompts/digest.md`:

```
[pipeline] run nicaraguan-laws-20260913-chat-meter-a1b2 → task-review-spec

3 events:
- feat/be-d3-top-laws (#208, t1) done, PR #412 open
- fix/norma-url-default (#209, t2) blocked
    "Do you want to proceed? ❯ 1. Yes  2. No"
- feat/chat-t4-chat-meter (#210, t3) exited, no PR

<rendered prompt for the phase just entered>
```

Delivery retries with backoff across ticks on `agent_blocked` or a missing pane, up to
`PROMPT_RETRY_MAX`, then holds and reports in `status`.

`WAKE_ON` covers agent **statuses** (`blocked`, `done`, `idle`; `working` updates ledger and badge
only) **plus events** (`exited`, `released`). `unknown` is included — it is what a released or crashed
agent becomes. A release or exit on a task's pane marks that task `failed` and surfaces it.

A `blocked` worker is Claude explicitly asking for a decision. Intervening is the orchestrator's job,
and this is the design's primary signal — not an error case. `blocked` lines inline up to
`BLOCKED_TAIL_LINES` of `herdr pane read --source visible`.

## Supervisor: CI and teardown

CI polls `gh pr checks <pr> --json bucket,name,state,link` every `CI_POLL_SECONDS`, treating **exit
code 8 as pending**. `gh` failures render `unknown`, which is not terminal.

Teardown runs **only** after `gh issue view --json closed` confirms closure, and is skipped for a task
registered `--keep-worktree` (`CLAUDE.md:88-89`: skip if a follow-up still needs the branch). It calls
`worktree remove --workspace <ws> --force`, emitting `worktree.removed` — one of this plugin's own
hooks, whose handler is idempotent: a task already `done` is a no-op. A hand-removed worktree marks
the task `orphaned`.

## The `hpipe` CLI

The startup hook idempotently symlinks `src/cli.ts` to `~/.local/bin/hpipe`, replacing a stale link so
a reinstall at a new managed path still resolves.

| Command | Purpose |
| --- | --- |
| `hpipe start "<title>"` | Open a run in this session, claim the calling pane, **print** the spec prompt |
| `hpipe task --branch <b> --issue <n> --surface <s> [--depends-on <ids>] [--files <globs>] [--keep-worktree] --text <t>` | Register a task; print its `task_id`; print the worker prompt **only if unblocked** |
| `hpipe status [--run <id>]` | Ledger, live agent statuses, and supervisor state: live / stale-pid reclaimed / owned by another session / none |
| `hpipe drain [--run <id>]` | Print and clear queued events |
| `hpipe rewind <run_id> <phase> [--task <id>]` | Move a run or task back; resets `pass` to 0 |
| `hpipe resume <run_id>` | Undo an `abort` |
| `hpipe abort <run_id>` | Stop driving a run; leaves worktrees and branches alone |
| `hpipe forget <workspace_id>` | Unbind a workspace |

`hpipe start` **prints** rather than injects: the orchestrator is by construction mid-turn running the
command, so it reads the output. Injection is only for waking an agent not currently talking to us.

## Recovery

| Situation | Escape |
| --- | --- |
| Advanced a phase early | `hpipe rewind <run> <phase> [--task <id>]` |
| Escalated and answered | `hpipe rewind` — resets `pass` |
| Aborted by mistake | `hpipe resume <run>` |
| Supervisor wedged or dead | `hpipe status` names the state; the `supervisor` action reopens it; delete `supervisor.<session>.pid` if reported stale |
| Plugin misbehaving | `herdr plugin disable stein.pipeline` — hooks stop; worktrees and agents untouched |
| Out permanently | `herdr plugin unlink stein.pipeline`; worktrees, branches, PRs and issues are plain git/GitHub objects |

Nothing the plugin owns is load-bearing for the *work*.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `TICK_MS` | `1000` | Supervisor loop interval |
| `WAKE_ON` | `blocked,done,idle,unknown,exited,released` | Statuses and events that prompt |
| `MAX_PASSES` | `2` | Review passes before escalating |
| `STALL_MINUTES` | `15` | Artifact-phase stall probe |
| `TASK_STALL_MINUTES` | `45` | `execute` per-task liveness |
| `SETTLE_MS` | `750` | File-stability and actor-idle re-read gap |
| `CI_POLL_SECONDS` | `30` | CI poll interval |
| `PROMPT_RETRY_MAX` | `5` | Delivery retries before holding |
| `BLOCKED_TAIL_LINES` | `8` | Pane tail inlined for a blocked worker |
| `REPOS_ALLOW` | *(empty = all)* | Repo-key allowlist |
| `PIPELINE_WORKSPACE_LABEL` | `pipeline` | Supervisor's workspace |
| `GH_BIN` | `gh` | `gh` executable; the test-suite injection point |
| `HPIPE_LINK` / `HPIPE_LINK_PATH` | `1` / `~/.local/bin/hpipe` | CLI symlink |

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Server restart | Supervisor process killed; its pane returns as a mislabelled shell; the startup hook closes the ghost and reopens. Badges lost and reapplied; ledger and queue survive |
| Supervisor dies | Wrapped command leaves a readable pane; `hpipe status` is the detector; `supervisor` action reopens |
| Stale pid after reuse | Liveness requires pid **and** process start time **and** session to match; mismatch means stale — reclaim |
| Two sessions | Runs, registry and pid file are session-scoped; a supervisor skips foreign runs |
| `--remote` | The server, plugin and pid file live on the remote host while `hpipe` runs locally; the pid is remote and local liveness is meaningless. **Unsupported — `hpipe` refuses when `HERDR_SOCKET_PATH` is not local** |
| 32-command cap | Not reachable by this plugin's own hooks in normal operation; asserted by the smoke test |
| Orchestrator unresolvable | Events queue; retried each tick; reported by `status` |
| Orchestrator blocked | `agent_blocked` before input is sent; retried with backoff |
| Agent idle while working | Freshness + double actor-idle check + trailer-last-line; a complete-then-continue artifact can still advance early → `hpipe rewind` |
| `queued` deadlock | Cycles rejected at registration; an unsatisfiable gate is reported by `status` |
| `gh` unauthenticated | Renders `unknown`; not terminal; nothing advances |
| Unparseable verdict | Treated as absent; phase holds; stall probe asks |
| Worker exited / released | Task `failed`, surfaced |
| Hand-removed worktree | Task `orphaned`, surfaced |

## Testing

`bun:test`. Fakes are injected by overriding **`HERDR_BIN_PATH`** and **`GH_BIN`**, not `PATH` order —
the plugin calls `$HERDR_BIN_PATH` by absolute path, which a `PATH` fake cannot intercept. Fixtures are
payloads captured live during review.

- **Unit:** orchestrator resolution (asserting the focused-pane path stays deleted); session scoping;
  verdict parsing (malformed, multiple trailers, trailer not last, MAJOR counts, the qualifier rule);
  freshness and stability; actor-idle double-check; template rendering incl. unresolved-placeholder
  error; badge clamping; `bucket` mapping and `gh` exit 8; `pr view` field names.
- **State machine:** every transition and failure branch; **the livelock case at both run and task
  level** (re-enter a phase whose old artifact still exists — must *not* advance); `MAX_PASSES`
  exhaustion into `escalated` and back out via `rewind`; `queued` gating, cycle rejection, and prompt
  withholding; stall probe firing once per artifact phase and **never** on `execute`.
- **Concurrency:** N hooks writing while the supervisor drains — assert no lost or duplicated events.
- **Integration smoke (live, one):** link, create a worktree, `agent start --kind claude --pane
  <root>`, assert adoption and delivery, assert `plugin log list` shows **zero**
  `plugin_command_limit_reached` entries, then restore.

## Deferred

- `bun build --compile` single-binary distribution.
- Link handlers; marketplace publication.
- Correcting `nicaraguan-laws/CLAUDE.md` and `~/.claude/skills/herdr` (stale `agent start`).
- Trimming redundant workflow prose from `CLAUDE.md` — only once this plugin has earned it. **Until
  then v1 adds a system without removing one**; the payoff is the automation, not yet the deletion.
