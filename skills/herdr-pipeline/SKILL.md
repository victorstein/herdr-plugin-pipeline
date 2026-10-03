---
name: herdr-pipeline
description: Use when running, orchestrating, checking on or unsticking a batch of Beads issues (beads) through the herdr pipeline plugin (stein.pipeline) — the `hpipe` CLI (start, task, tier, dispatch, status, show, decide, answer, rewind, release, forget, next, bead show, escalate, discover, discoveries, close), review tiers, worker agents in herdr worktrees, escalated or stalled tasks, "stuck input", "waiting on you", or a dead orchestrator/supervisor pane.
---

# herdr pipeline (`hpipe`)

## Overview

The plugin turns a batch of beads into parallel worker agents, one per task, each in its own herdr
worktree going research → spec → plan → reviews → implement → PR → CI → merge → teardown. The
supervisor drives every phase by prompting panes. **You orchestrate: intake, dispatch, decisions,
merges, recovery. Everything else is prompted to you — follow the text `hpipe` prints and the
prompts you receive instead of improvising.** The one-line `--help` strings do not explain
behaviour; this skill does.

## Ground rules

- **Run every `hpipe` command inside a pane of the herdr session that owns the run**, cd'd into the
  repo. From a plain terminal it silently uses the `default` session's ledger — check
  `echo $HERDR_SESSION`; if empty, `herdr session list`, attach the owning session, open a pane there.
- One live run per repo per session (`hpipe start` refuses a second; several repos in one session
  are fine). Commands resolve the run from the repo you stand in; pass `--run <run-id>` only when
  told the choice is ambiguous. Run ids (for `rewind`/`abort`/`resume`) are printed by `hpipe status`.
- herdr events bind panes and worktrees to tasks automatically (`worktree create`/`open` on the
  task's branch, an agent detected in its pane) — there is no bind command.
- Never type into a worker's pane, and never use `pane send-text`/`send-keys` to hand over prompts.
- `--surface <s>` needs `<repo>/.claude/agents/<s>-dev.md`. A repo may declare an executable
  `.claude/pipeline-bootstrap` to set up fresh worktrees.
- Run Claude with Opus as the default model. The orchestrator, the workers and every reviewer
  inherit it; only `implement`'s coding subagent is pinned, to Sonnet.

## Running a batch

1. `hpipe start "<title>" [--prefix <p>]` — the first start in a repo sets up its Beads store (needs
   `bd` ≥ 1.3.1; the prefix must start with a letter) and prints the intake prompt. Follow it.
2. One bead per task; **the bead's brief is the worker's entire brief** (goal, acceptance criteria,
   `file:line` pointers), captured when the task is registered. Check the backlog first: `hpipe next`
   lists unheld open beads as bv ranks them — the picks claimable `now`, then one line per later
   dependency layer, each waiting on the one before — and `hpipe bead show <id>` reads one.
   Register: `hpipe task --branch <b> --bead <id> --surface <s> [--depends-on t1,t2] [--files a/,b/c.ts]`
   — or `--title "<t>" --body-file <path> [--acceptance-file <path>]` instead of `--bead` to file a
   new bead in the same step; it prints `bead: <id> (filed)`. Adoption refuses a bead that is closed,
   assigned, held by a live task (any session), blocked by an open bead, or the parent of open child
   beads. Never run `bd` or `bv` yourself.
   `--files` / `--depends-on` are comma-separated, no spaces. `--files` are path prefixes: two tasks
   whose prefixes overlap never implement at the same time (the second waits in `blocked-on-files`),
   so to keep a task off t3's files, declare prefixes overlapping t3's. Plans can widen them later.
   `hpipe next`'s `now` picks can run in parallel only when their `--files` are disjoint: bv knows
   nothing about files.
   Pick a tier with `--tier light|standard|heavy` (default `standard`). **light**: one surface, a
   handful of files, the brief pins the exact change. **heavy**: a contract another surface
   consumes, a data migration, security/auth, concurrency or state-machine code — or you are
   unsure. **standard**: the rest. When unsure, go higher. A `pipeline:tier-<name>` bead label
   overrides `--tier`; two tier labels are refused. The `tier:` line under `task_id:` says what was
   recorded and why. light skips `plan-review`; light and standard get one combined `pr-review`;
   heavy runs `pr-review-intent` then `pr-review-quality`.
3. Registration prints either `queued: waiting on …` (when its gate opens the supervisor sends you a
   `Dispatch tN` prompt carrying the same block — run it then) or a brief with a
   **`dispatch, in order:`** block. **Run that block exactly
   as printed**: `herdr worktree create … --base <commit>` (the fetched commit — never `--base main`),
   bootstrap, `herdr agent start … -- --dangerously-skip-permissions`, then
   `hpipe dispatch --task <id> --pane <root pane>`, which submits the brief and confirms it landed. It claims the task's bead first; if bd refuses, nothing is sent.
   `dispatch --task` only works while the task is in `research`.
4. After the last task: `hpipe dispatch --done`. Until then the run can never finish. Registering
   another task later reopens intake — run `dispatch --done` again afterwards.

The supervisor nudges a silent task with a stall probe (workers every 45 min, the orchestrator every
15); 3 unanswered probes escalate it.

## While it runs

| You see | Do |
|---|---|
| Workers raise decisions with `hpipe decide`; you get a prompt naming the task and decision id (also under "waiting on you" in `hpipe status`) | — |
| A worker's decision you can settle from the repo | `hpipe answer --task <id> --decision <d> --answer "…" --by orchestrator` |
| A decision only the owner can make (product, licence, scope) | Relay question + worker's recommendation + yours to the user, and run `hpipe escalate --task <id> --decision <d> --recommend "…"` so its bead shows blocked on them; record their reply with `--by human` |
| "Ready to merge — PR #n" | Check for conflicts with anything merged since (rebase + re-run bootstrap if needed), then merge. Merging is yours; nothing merges automatically |
| Workers recorded out-of-scope work (`hpipe discover`) | At branch review: `hpipe discoveries` lists it, `hpipe discoveries --file` files it as beads labelled `discovered` (all or nothing) |
| The PR merged | Nothing to do: the supervisor closes the task's bead and moves it on |
| A task turns out bigger than its tier (research or a decision finds a contract, a migration, another surface) | `hpipe tier --task <id> <higher> --why "…"`. The current phase completes; only the next step changes. Never lower a tier: it is refused from pipeline panes, so the user runs it from their own. `hpipe show --task <id>` prints `tier:`, `tier log:` and `visited:` |
| Anything else | `hpipe status` (fleet, "waiting on you", held deliveries); `hpipe show --task <id>` for one task |

## Recovery

| Situation | Do |
|---|---|
| Task `escalated` | `hpipe rewind <run> <phase> --task <id>` resumes it (status prints the exact command); `hpipe rewind <run> failed --task <id>` abandons it. `release` is NOT for this |
| `⚠ stuck input in <pane>` | A human's unsubmitted text sits in that pane's input box (often the user's own draft in the orchestrator pane); the supervisor holds prompts rather than overwrite it. Tell the user — it's their text to submit or clear (ctrl+c). Don't send keys to it yourself. Delivery resumes the next tick after the box is empty |
| Worker pane closed / task `failed` | A closed pane fails the task (in `merge`/`close` it only releases the pane). `hpipe rewind <run> <phase> --task <id>`, then follow the advice `hpipe status` prints (`herdr worktree open`, or `create` if no checkout exists; `agent start`; `dispatch --task` only if back in `research`). The rewind queues the brief + phase prompt for the new agent — don't also paste a brief. Base for any new worktree: the `base:` line `hpipe show --task <id>` prints |
| Orchestrator pane died / replaced | Run inside the new orchestrator pane (it claims the pane it runs in): `herdr plugin action invoke claim --plugin stein.pipeline`. Held prompts and a catch-up digest follow |
| Supervisor dead | `herdr plugin action invoke supervisor --plugin stein.pipeline` |
| Task blocked behind a failed sibling's `--files` | `hpipe release --task <id>` |
| A task sits in `close` and status shows its bead out of sync | Fix what bd's error names, or `hpipe close --task <id>` (`--force` only to override bd's close guards) |
| `hpipe start` refuses on bd's version | `brew upgrade beads` (the user's call — ask first); bd ≥ 1.3.1 is required |
| `hpipe next` or the board says `bv` is missing | The pipeline runs without it. Installing it is the user's call — its licence carries a rider (see the README) |
| The repo's `Board: …` tab is gone | `herdr plugin action invoke board --plugin stein.pipeline` from a pane in the repo, or let the supervisor reopen it next tick |
| Stop / restart a whole run | `hpipe abort <run>` / `hpipe resume <run>` |
| Plugin upgraded | Restart the supervisor after upgrading: close the `Pipeline supervisor` pane, then `herdr plugin action invoke supervisor --plugin stein.pipeline` (or restart the session). An old supervisor beside a new CLI routes tasks by the old table |

`hpipe brief --task <id>` reprints a task's brief and `hpipe bead show <id>` a bead as Beads holds it now (both read-only). `forget <workspace>` only unbinds a workspace. `drain` just flushes the plugin's event queue — you
never need it in normal use.
