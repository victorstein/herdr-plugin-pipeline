# herdr-plugin-pipeline — design

**Date:** 2026-09-13
**Status:** Design v2 — revised after adversarial review (`docs/superpowers/reviews/2026-09-13-design-adversarial-1.md`, VERDICT: BLOCKER)
**Plugin id:** `stein.pipeline`
**Target:** herdr 0.9.0+
**Runtime:** Bun + TypeScript, no build step

> **v2 changes.** v1 was built on two false premises and had no liveness owner. `herdr agent start`
> does not open a pane in 0.9.0 — it adopts an existing one — so v1's orphan-pane reaper solved a
> problem that does not exist. herdr caps plugin commands at **32 concurrent and drops events over
> the cap**, so v1's `sleep`-inside-a-hook debounce was itself a cause of dropped events. v1 also
> excluded the orchestrator pane from the event path to stop it waking itself, which also excluded
> it from *evaluation* — seven of twelve phases are evaluated on its idle, so the run dead-stopped
> at `spec`. Every predicate was level-triggered, so every failure branch livelocked.
>
> The resolution is one architectural flip: **event hooks become thin append-and-exit writers, and a
> single always-on supervisor pane owns all evaluation, delivery, and timing.** Every claim in the
> facts table below has been re-derived from the 0.9.0 binary, not from prose.

## Problem

The superpowers pipeline — brainstorm → spec → adversarial review → plan → adversarial review →
subagent execution → final review → finish branch — currently lives as prose in each repo's
`CLAUDE.md`. `nicaraguan-laws/CLAUDE.md` carries roughly 60 lines of it, including a hand-run
dispatch loop and an instruction to background three `herdr wait agent-status` calls per worker.

Four costs:

1. **The pipeline is re-taught every session** — it loads into context whether or not the session is
   running a pipeline.
2. **It is duplicated per repo.** `nicaraguan-laws` has it; `crosspoint-x4pro` does not.
3. **The orchestrator does its own bookkeeping** — backgrounded waits and manual issue/PR/worktree
   correlation, spent from the context budget of the agent that should be thinking about the work.
4. **Failures are silent.** Nothing catches a worker whose pane exited without finishing.

A fifth, discovered during review: **that prose is now wrong.** It documents a `herdr agent start`
signature that 0.9.0 rejects. Prose drifts; a package with tests does not.

## Goal

A self-contained herdr plugin that owns the pipeline: run state, phase sequencing, just-in-time
instruction text, CI, and teardown — keeping one orchestrator agent fed so the human never walks the
fleet pane by pane.

## Non-goals

- **Driving brainstorming.** It is the one human gate and stays one.
- **Making merge decisions.** The plugin prompts; the orchestrator merges.
- **Shipping Claude Code skills.** All instruction text lives in this package.
- **Replacing `CLAUDE.md`.** Repo-specific architecture, conventions, and footguns stay there.
- **Fixing `nicaraguan-laws/CLAUDE.md` or `~/.claude/skills/herdr`**, both of which carry the stale
  `agent start` signature. Flagged, deliberately out of scope, tracked separately.
- **Cross-machine coordination.** Single herdr server, single machine.

## Roles

| Role | What it is | What it does |
| --- | --- | --- |
| **Human** | you | Talks to exactly one pane: the orchestrator |
| **Orchestrator** | a Claude Code agent in a herdr pane, one per repo, long-lived across runs | Writes specs and plans, dispatches adversarial reviews, decomposes tasks, merges, talks to the human. Never edits app code |
| **Worker** | a Claude Code agent in a worktree workspace, one per issue | Implements one task, opens one PR |
| **Supervisor** | a plugin-owned pane in its own workspace | The only component with a clock. Drains the queue, evaluates predicates, advances phases, delivers prompts, polls CI, runs teardown |
| **Plugin hooks** | five one-shot processes | Append raw events to the queue and exit |

## Execution model

This section governs everything below it.

**herdr spawns one process per event hook and caps plugin commands at 32 concurrent. Over the cap it
drops the event** — verified live during review, including a dropped `worktree.created`. A hook that
blocks holds a slot for its whole duration.

Therefore:

> **A hook parses its event, appends one line to the queue, and exits. It never sleeps, never calls
> `gh`, never calls `herdr`, never evaluates a predicate, never renders a prompt.** Target: under
> 50 ms.

All intelligence lives in the **supervisor**, a single long-lived process in a plugin-owned pane:

```
every TICK_MS (default 1000):
  rotate + drain queue        →  dedup against ledger, update tasks, refresh badges
  evaluate due predicates     →  advance phases (edge-triggered, see below)
  render + deliver prompts    →  herdr agent prompt, with retry/backoff across ticks
  every CI_POLL_SECONDS       →  gh pr checks for tasks with open PRs
  check stalls                →  STALL_MINUTES since phase_entered_at with no artifact
  run teardown                →  for tasks whose issue is confirmed closed
```

One process with a clock replaces v1's in-hook `sleep`, `flush.lock`, and per-hook retry loop. It
also gives `STALL_MINUTES` and `PROMPT_RETRY_MAX` somewhere to live — v1 had no component capable of
implementing either.

**The supervisor is mandatory infrastructure.** If it is not running, nothing advances. It lives in
its own unfocused workspace (`PIPELINE_WORKSPACE_LABEL`, default `pipeline`), opened unconditionally
by the startup hook and reopenable with the `ci-pane` action. Singleton-guarded by a PID file with a
liveness check; a second instance exits immediately.

Consequence accepted deliberately: the plugin now has a component that can die. It dies *visibly*,
in a pane you can look at, which is why it is a pane and not a detached daemon.

### Verified herdr facts

Re-derived from `herdr 0.9.0` — `herdr api schema`, `--help` output, and live probe-plugin runs
during review. Prose in any `CLAUDE.md` is **not** a source. Re-verify before changing.

| Fact | Evidence | Consequence |
| --- | --- | --- |
| `herdr agent start <NAME> --kind <KIND> --pane <ID>` adopts an **existing pane at a shell prompt**; `AgentStartParams` requires `name`, `kind`, `pane_id` | `agent start --help`; schema | **No orphaned root pane exists.** The reaper is deleted. Dispatch reuses the worktree's root pane |
| `worktree.created` payload carries `workspace` + `worktree` and **no pane id** | live hook capture | Root pane comes from the `worktree create` CLI response or `pane list --workspace` |
| Plugin commands cap at **32 concurrent**; over the cap herdr drops the event | live: `maximum concurrent plugin commands reached (32)` | Hooks must not block. See execution model |
| Event hook context's `focused_pane_id` is whatever is focused **at event time** — during dispatch that is the worker | live: focused `w1:p1`, hook reported `w5:p1` | Focused-pane fallback for orchestrator resolution is **deleted** |
| `pane.exited` payload is `{type, pane_id, workspace_id}` — **no exit status** | live hook capture | The digest reports "exited", never "exited (status N)" |
| Claude Code agent state authority is the **screen manifest**; unmatched prompts fall back to `idle` | `agents.mdx:28,50,60` | Inference can fire on an agent that is not done. See "Limits of inference" |
| `pane.agent_detected` also fires on agent *release* | docs + live | Handler must check the payload, not assume attach |
| `herdr agent prompt` rejects with `agent_blocked` **before sending input**; otherwise writes "including while the agent is working", and success acknowledges the write, not a turn | `agent prompt --help` | Safe against a blocked target; mid-turn behaviour is an accepted open risk, mitigated below |
| `gh pr checks --json` fields are `bucket, completedAt, description, event, link, name, startedAt, state, workflow` — **no `conclusion`**; exit code 8 means pending | `gh pr checks --help`, gh 2.96.0 | CI uses `bucket` (`pass`/`fail`/`pending`/`skipping`/`cancel`) and treats exit 8 as pending, not failure |
| `plugin.action.invoke` accepts no user arguments — only `action_id`, `plugin_id`, a fixed `context` | schema `PluginActionInvokeParams` | Anything carrying data goes through `hpipe`, not an action |
| `workspace.metadata_updated` is **rejected as an unknown event name at link time** | live link warning | Never declare it. The five names this plugin uses all validate clean |
| Workspace/pane tokens are not restored after a server restart; ≤32 keys, ≤16 per report, values capped at 80 chars; plugin `source` must be `plugin:<HERDR_PLUGIN_ID>` | socket-api.mdx | Tokens are display only; the ledger is truth; supervisor reapplies badges |
| `WorkspaceInfo.worktree` carries `repo_key`, `repo_root`, `checkout_path`, `is_linked_worktree` | schema | Parent resolution by repo provenance |
| `plugin.pane.open` accepts an `env` map | schema `PluginPaneOpenParams` | Supervisor is parameterised without a config file |
| Startup hooks are one-shot, not supervised daemons | plugins.mdx | The clock lives in a pane |

`min_herdr_version = "0.9.0"` because `agent start`'s `--kind`/`--pane` signature is the 0.9.0 shape
and the plugin depends on it directly. (v1 justified this by *not knowing* whether older releases
worked — an argument from ignorance, and it named the wrong reasons.)

## Package layout

```
herdr-plugin.toml
src/
  hooks/                   # append-and-exit only
    worktree-created.ts  agent-detected.ts  agent-status.ts
    pane-exited.ts       worktree-removed.ts
  supervisor/
    main.ts                # tick loop, singleton guard, render
    ci.ts                  # gh polling
    teardown.ts
  actions/                 # argument-less, keybinding-able
    status.ts  claim.ts  drain.ts  ci-pane.ts
  startup.ts               # reconcile, reapply badges, link hpipe, open supervisor workspace
  cli.ts                   # `hpipe`
  lib/
    herdr.ts  gh.ts  store.ts  ledger.ts  queue.ts
    machine.ts  predicates.ts  render.ts  badges.ts
prompts/
  spec.md  spec-review.md  plan.md  plan-review.md  dispatch.md
  task.md  task-review-spec.md  task-review-quality.md
  ci-red.md  merge.md  close.md  branch-review.md
  escalate.md  stall-probe.md  digest.md
test/
  fixtures/                # live-captured event JSON, gh JSON, workspace lists
  *.test.ts
```

No `[[build]]`. Bun executes `.ts` directly. `src/cli.ts` carries a `#!/usr/bin/env bun` shebang and
mode `0755` in git, because the startup hook symlinks it onto `PATH` and a symlink to a non-executable
file is not runnable.

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
title = "Reopen the supervisor"
contexts = ["global"]
command = ["bun", "run", "src/actions/ci-pane.ts"]

[[panes]]
id = "supervisor"
title = "Pipeline supervisor"
placement = "tab"
command = ["bun", "run", "src/supervisor/main.ts"]
```

## State

All state in `$HERDR_PLUGIN_STATE_DIR`. Every write is atomic (`<file>.tmp` → `rename(2)`).

```
orchestrators.json   repo_key -> { pane_id, workspace_id, claimed_at }
runs/<run_id>.json
queue/               rotated segments; hooks append, supervisor rotates then reads
supervisor.pid
```

The queue is a **directory of rotated segments**, not one truncated file. The supervisor renames the
active segment aside before reading it, so a hook appending concurrently writes to the new segment
and nothing is lost. v1's read-then-truncate raced every late appender.

### Run

```jsonc
{
  "run_id": "nicaraguan-laws-20260913-chat-meter-a1b2",
  "repo_key": "…", "repo_root": "/…/nicaraguan-laws",
  "title": "chat meter",
  "phase": "spec-review", "pass": 1,
  "phase_entered_at": 1789000000000,
  "orchestrator_pane": "w1:p1",
  "artifacts": {
    "spec": "docs/superpowers/specs/2026-09-13-chat-meter-design.md",
    "plan": null,
    "verdicts": { "spec-review-1": "docs/superpowers/reviews/…-spec-1.md" }
  },
  "tasks": [{
    "task_id": "t1", "branch": "feat/chat-t4-chat-meter", "issue": 210,
    "surface": "core", "depends_on": [], "files": ["packages/core/src/db/usage.ts"],
    "workspace_id": "w7", "pane_id": "w7:p1",
    "agent_status": "working", "phase": "execute",
    "pr": null, "ci": null,
    "text": "…full task text, supplied by the orchestrator via `hpipe task`…"
  }],
  "history": [{ "at": …, "from": "spec", "to": "spec-review", "why": "artifact 2026-…-design.md mtime > phase_entered_at" }]
}
```

`run_id` ends in a random suffix; date + slug alone collide on a same-day retry. A task's
`agent_status` (herdr's view of the pane) is kept distinct from its `phase` (the pipeline's view) —
v1 overloaded one field for both.

**One active run per repo.** `hpipe start` refuses a second run for a `repo_key` whose existing run
is not `done`, naming the one in the way. Without it, adoption by repo provenance cannot decide
which run a new worktree belongs to.

**Task field provenance.** `branch` from `worktree.created`; `workspace_id` likewise; `pane_id` from
`pane.agent_detected`; `surface`, `depends_on`, `files`, `issue`, `text` from `hpipe task`; `pr` from
`gh pr list --head <branch>`; `ci` from `gh pr checks`. `issue` is **required** — `hpipe task`
rejects a task without one, because `CLAUDE.md:83` makes an issue per task mandatory and v1 quietly
made it optional.

## Orchestrator identity

1. **Explicit claim** — the `claim` action from inside the orchestrator's pane pins `HERDR_PANE_ID`.
   `hpipe start` claims implicitly the same way.
2. **Repo provenance** — the workspace for this `repo_key` with `is_linked_worktree == false`, then
   its agent pane.

There is no third fallback. v1 fell back to the event's `focused_pane_id`, which during dispatch
resolves to the *worker's* pane — verified live. If neither step resolves, events stay queued and the
supervisor retries each tick; `status` reports the unresolved state.

Two orchestrators on one repo are disambiguated **only** by explicit `claim`. `REPOS_ALLOW` is a repo
allowlist and cannot distinguish two panes within one repo; v1 claimed it could.

**Waking and evaluation are separate concerns.** The orchestrator pane is excluded from *waking* —
its own status changes never generate a prompt to itself. It is **not** excluded from *evaluation*:
its `idle`/`done` transitions are exactly the trigger for seven of the twelve phases. v1 conflated
the two and dead-stopped at `spec`.

## Phase machine

| Phase | Actor | Completion predicate | Success | Failure |
| --- | --- | --- | --- | --- |
| `spec` | orchestrator | spec file, fresh | `spec-review` | — |
| `spec-review` | orchestrator + adversarial subagent | verdict file, fresh, parses | `CLEAR` → `plan` | else `spec`, `pass`+1 |
| `plan` | orchestrator | plan file, fresh | `plan-review` | — |
| `plan-review` | as above | verdict file, fresh, parses | `CLEAR` → `dispatch` | else `plan`, `pass`+1 |
| `dispatch` | orchestrator | ≥1 task registered via `hpipe task` **and** ≥1 worktree adopted | `execute` | — |
| **task** `queued` | supervisor | all `depends_on` tasks `done`, and no in-flight task shares a `files` entry | task `execute`; prompt orchestrator to dispatch it | — |
| **task** `execute` | worker | worker `done`/`idle` **and** `gh pr list --head <branch>` returns a PR | task `task-review-spec` | pane exited with no PR → task `failed` |
| **task** `task-review-spec` | orchestrator | verdict file, fresh, parses | `CLEAR` → `task-review-quality` | else task `execute`, re-prompt worker |
| **task** `task-review-quality` | orchestrator | verdict file, fresh, parses | `CLEAR` → task `ci` | else task `execute`, re-prompt worker |
| **task** `ci` | supervisor | `gh pr checks` bucket is terminal | `pass` → task `merge` | `fail` → task `execute` with the failing check |
| **task** `merge` | orchestrator | `gh pr view` reports `merged` | task `close` | — |
| **task** `close` | orchestrator | `gh issue view` reports `closed` | task `teardown` | — |
| **task** `teardown` | supervisor | `worktree remove --workspace <ws> --force` succeeded | task `done`; unblocks `queued` tasks; last task → run `branch-review` | removal fails → task `orphaned`, surfaced |
| `branch-review` | orchestrator | verdict file, fresh, parses | `CLEAR` → `done` | else `branch-review`, `pass`+1 |

Two review phases per task, not one — `CLAUDE.md:46` mandates spec-compliance then code-quality, and
v1 collapsed them.

**Ordering and collisions.** `queued` is the entry state for every task. A task leaves it only when
its `depends_on` are `done` and no in-flight task declares an overlapping `files` entry. This
implements two `CLAUDE.md` rules v1 dropped: *core first* (`core` tasks are depended on by app tasks,
because apps consume the built `dist`) and *never two agents editing the same files in parallel*.
`hpipe task` requires `--surface` and accepts `--depends-on` and `--files`.

**Surface routing.** `{{surface}}` and `{{agent_file}}` (`.claude/agents/<surface>-dev.md`) are
rendered into `prompts/task.md`, so each worker is pointed at its scoped agent definition as
`CLAUDE.md:76` requires.

`pass` caps at `MAX_PASSES` (default 2). Exceeding it renders `prompts/escalate.md` and advances
nothing.

### Predicates are edges, not levels

Every predicate compares against `phase_entered_at`:

- a **file** predicate requires `mtime > phase_entered_at`, plus a settle check — read twice
  `SETTLE_MS` apart and require identical size and mtime, so a half-written artifact is not read as
  complete;
- a **PR** predicate requires the PR's `createdAt`/`updatedAt` to postdate phase entry;
- a **CI** predicate requires a bucket change, not merely a terminal bucket.

v1 checked levels. Re-entering `spec` after a BLOCKER found the *old* spec file still present and
immediately re-advanced, so every failure branch livelocked and burned `MAX_PASSES` in one tick.

### Limits of inference

v1 claimed the design "stalls, never derails". **That claim was false and is withdrawn.** Claude
Code's state authority in herdr is the screen manifest, and a prompt that matches no rule falls back
to `idle` (`agents.mdx:60`). An agent can therefore be reported idle while working.

What the freshness and settle rules actually buy: a stale artifact cannot satisfy a re-entered phase,
and a partially written one cannot satisfy any phase. What they do not buy: immunity to an agent that
writes a complete artifact and then keeps going. That case advances the phase early, and the
orchestrator — a live agent, not a script — is the recovery path; it can see the situation and use
`hpipe rewind`.

The honest statement of the invariant: **the plugin never advances on an artifact that is stale or
still being written, and never invents a verdict.** It can still be early. That is a real residual
risk, accepted, with `hpipe rewind` as the escape.

### The verdict contract

Every review prompt names its output path and requires a trailer:

```
VERDICT: CLEAR
```
```
VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 3
```

The parser reads the last `VERDICT:` line and the counts. **`BLOCKER` means any BLOCKER *or* MAJOR
finding** — the prompt says so explicitly. v1's binary CLEAR/BLOCKER discarded the MAJOR rank that
`CLAUDE.md:38` actually gates on. MINOR findings are fixed inline by the reviewing agent, per the
same rule; the prompt instructs this.

This spec's own review is the worked example: the trailer parsed, and `VERDICT: BLOCKER` is why you
are reading v2.

## Event transport

Hooks append one JSON line and exit. The supervisor, each tick:

1. Rotates and drains queue segments.
2. Drops events for unknown workspaces and for orchestrator panes' *waking*, keeping them for
   evaluation.
3. Dedups against the ledger's stored `agent_status`.
4. Updates tasks; refreshes `$status` / `$branch` badges (clamped to herdr's 80-char, 32-key limits).
5. Evaluates predicates, advances phases, renders one coalesced message per orchestrator.
6. Delivers with `herdr agent prompt`; on `agent_blocked` or a missing pane, retries next tick with
   backoff up to `PROMPT_RETRY_MAX`, then holds the events and reports it in `status`.

`blocked`, `done`, `idle`, and `exited` are wake-worthy. `working` updates the ledger and badge only
(`WAKE_ON`).

**Message shape:**

```
[pipeline] run nicaraguan-laws-20260913-chat-meter-a1b2 → task-review-spec

3 events:
- feat/be-d3-top-laws (#208, w4) done, PR #412 open
- fix/norma-url-default (#209, w6) blocked
    "Do you want to proceed? ❯ 1. Yes  2. No"
- feat/chat-t4-chat-meter (#210, w7) exited, no PR

<rendered prompt for the phase just entered>
```

`blocked` lines inline up to `BLOCKED_TAIL_LINES` (default 8) of `herdr pane read --source visible`,
so the orchestrator can usually answer without a round trip. A `blocked` worker is Claude explicitly
asking for a decision — intervening is the orchestrator's job, and this is the design's primary
signal, not an error case.

## Supervisor: CI and teardown

CI polls `gh pr checks <pr> --json bucket,name,state,link` for tasks with open PRs every
`CI_POLL_SECONDS` (default 30), treating **exit code 8 as pending**, never as failure, and mapping
`bucket` — not the nonexistent `conclusion` field v1 specified. `gh` failures render as `unknown`,
which is not terminal, so nothing advances on a broken `gh`.

Teardown is the only unattended destructive action and runs **only** after `gh issue view` confirms
the issue closed. It calls `herdr worktree remove --workspace <ws> --force`, which emits
`worktree.removed` — one of this plugin's own hooks. That handler is idempotent: a task already
`done` is a no-op. A worktree removed by hand marks the task `orphaned`, not `done`.

## The `hpipe` CLI

Manifest actions take no arguments, so data goes through a CLI the package ships. The startup hook
idempotently symlinks `src/cli.ts` to `~/.local/bin/hpipe` (`HPIPE_LINK_PATH`; `HPIPE_LINK=0` to
skip), replacing a stale symlink so a reinstall at a new managed path still resolves.

| Command | Purpose |
| --- | --- |
| `hpipe start "<title>"` | Open a run, claim the calling pane, **print** the spec prompt to stdout |
| `hpipe task --branch <b> --issue <n> --surface <s> [--depends-on <ids>] [--files <paths>] --text <t>` | Register a task; print its rendered worker prompt |
| `hpipe status [--run <id>]` | Ledger, live agent statuses, supervisor liveness, stuck deliveries |
| `hpipe drain [--run <id>]` | Print and clear queued events in full |
| `hpipe rewind <run_id> <phase>` | Move a run or task back to a phase; the escape hatch when the plugin advanced wrongly |
| `hpipe abort <run_id>` | Stop driving a run; leaves worktrees and branches alone |
| `hpipe forget <workspace_id>` | Unbind a workspace from its run |

`hpipe start` **prints** rather than injects. v1 had it prompt the orchestrator that was, by
construction, mid-turn running the command — so the orchestrator simply reads the command's output.
Injection is reserved for waking an agent that is not currently talking to us.

## Recovery

The plugin can be wrong. Every layer has an exit:

| Situation | Escape |
| --- | --- |
| Advanced a phase early | `hpipe rewind <run> <phase>` |
| Driving a run you no longer want | `hpipe abort <run>` |
| Supervisor wedged | Close its pane; `ci-pane` action reopens it; state is on disk |
| Plugin misbehaving entirely | `herdr plugin disable stein.pipeline` — hooks stop, worktrees and agents are untouched |
| Want out permanently | `herdr plugin unlink stein.pipeline`; the worktrees, branches, PRs and issues are all plain git and GitHub objects |

Nothing the plugin owns is load-bearing for the *work*. Runs are bookkeeping; the artifacts are files
in the repo and objects on GitHub.

## Configuration

`$HERDR_PLUGIN_CONFIG_DIR/config.env`:

| Key | Default | Meaning |
| --- | --- | --- |
| `TICK_MS` | `1000` | Supervisor loop interval |
| `WAKE_ON` | `blocked,done,idle,exited` | Transitions that prompt the orchestrator |
| `MAX_PASSES` | `2` | Review passes before escalating |
| `STALL_MINUTES` | `15` | Idle-without-artifact before the probe |
| `SETTLE_MS` | `750` | Artifact stability re-read gap |
| `CI_POLL_SECONDS` | `30` | CI poll interval |
| `PROMPT_RETRY_MAX` | `5` | Delivery retries before holding |
| `BLOCKED_TAIL_LINES` | `8` | Pane tail inlined for a blocked worker |
| `REPOS_ALLOW` | *(empty = all)* | Repo-key allowlist |
| `PIPELINE_WORKSPACE_LABEL` | `pipeline` | Supervisor's workspace |
| `HPIPE_LINK` / `HPIPE_LINK_PATH` | `1` / `~/.local/bin/hpipe` | CLI symlink |

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Supervisor dies | Nothing advances; visible dead pane; `hpipe status` says so; `ci-pane` reopens; queue and ledger intact |
| Two supervisors | PID file + liveness check; the second exits |
| 32-command cap reached | Hooks are sub-50 ms and hold no slot; the cap is no longer reachable by this plugin's own design |
| Orchestrator unresolvable | Events queue; retried each tick; reported by `status` |
| Orchestrator blocked | `agent_blocked` before any input is sent; retried with backoff |
| Agent reported idle while working | Freshness + settle prevent stale/partial reads; a complete-then-continue artifact can still advance early → `hpipe rewind` |
| Server restart / live handoff | Badges lost (herdr does not restore them), reapplied by the startup hook; ledger and queue survive on disk |
| `gh` unauthenticated or rate-limited | Renders `unknown`; not terminal; nothing advances |
| Unparseable verdict file | Treated as absent; phase holds; stall probe eventually asks |
| Worker exited with no PR | Task `failed` and surfaced — a case nothing catches today |
| Hand-removed worktree | Task `orphaned`, surfaced |

## Testing

`bun:test`. The fake `herdr` and `gh` are injected by **overriding `HERDR_BIN_PATH` and a `GH_BIN`
indirection**, not by `PATH` order — the plugin calls `$HERDR_BIN_PATH` by absolute path, which a
`PATH` fake cannot intercept. Fixtures are the event payloads captured live during review.

- **Unit:** orchestrator resolution (including the deleted focused-pane path staying deleted), dedup,
  verdict parsing (malformed, multiple `VERDICT:` lines, MAJOR counts), freshness and settle logic,
  template rendering including the unresolved-placeholder error, badge clamping, `bucket` mapping and
  `gh` exit 8.
- **State machine:** every transition and every failure branch; `MAX_PASSES` exhaustion; the
  livelock case (re-enter a phase whose old artifact still exists — must *not* advance); `queued`
  gating on `depends_on` and on `files` overlap; stall probe firing exactly once per phase.
- **Concurrency:** N hooks appending while the supervisor rotates and drains — assert no lost or
  duplicated events.
- **Integration smoke (live, one):** a probe-style throwaway session — link, create a worktree,
  `agent start --kind claude --pane <root>`, assert adoption and delivery, then restore.

## Deferred

- `bun build --compile` single-binary distribution.
- Link handlers (click a PR URL to jump to its task).
- Marketplace publication (`herdr-plugin` topic).
- Correcting `nicaraguan-laws/CLAUDE.md` and `~/.claude/skills/herdr`, both of which teach the
  pre-0.9.0 `agent start` signature.
- Trimming the now-redundant workflow prose from `CLAUDE.md` — only once this plugin has earned it.
  **Until then v1 of this plugin adds a system without removing one**; the payoff is the automation,
  not yet the deletion.
