---
name: herdr-pipeline
description: Use when running, orchestrating, checking on or unsticking a batch of GitHub issues through the herdr pipeline plugin (stein.pipeline) — the `hpipe` CLI (start, task, dispatch, status, show, decide, answer, rewind, release, forget), worker agents in herdr worktrees, escalated or stalled tasks, "stuck input", "waiting on you", or a dead orchestrator/supervisor pane.
---

# herdr pipeline (`hpipe`)

## Overview

The plugin turns a batch of issues into parallel worker agents, one per task, each in its own herdr
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

## Running a batch

1. `hpipe start "<title>"` — prints the intake prompt. Follow it.
2. One GitHub issue per task; **the issue body is the worker's entire brief** (goal, acceptance
   criteria, `file:line` pointers). Register:
   `hpipe task --branch <b> --issue <n> --surface <s> [--depends-on t1,t2] [--files a/,b/c.ts]`
   — or `--title "<t>" --body-file <path>` instead of `--issue` to file the issue in the same step.
   `--files` / `--depends-on` are comma-separated, no spaces. `--files` are path prefixes: two tasks
   whose prefixes overlap never implement at the same time (the second waits in `blocked-on-files`),
   so to keep a task off t3's files, declare prefixes overlapping t3's. Plans can widen them later.
   `--title` prints `issue: #<n> (filed)`.
3. Registration prints either `queued: waiting on …` (when its gate opens the supervisor sends you a
   `Dispatch tN` prompt carrying the same block — run it then) or a brief with a
   **`dispatch, in order:`** block. **Run that block exactly
   as printed**: `herdr worktree create … --base <commit>` (the fetched commit — never `--base main`),
   bootstrap, `herdr agent start … -- --dangerously-skip-permissions`, then
   `hpipe dispatch --task <id> --pane <root pane>`, which submits the brief and confirms it landed.
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
| A decision only the owner can make (product, licence, scope) | Relay question + worker's recommendation to the user; record their reply with `--by human` |
| "Ready to merge — PR #n" | Check for conflicts with anything merged since (rebase + re-run bootstrap if needed), then merge. Merging is yours; nothing merges automatically |
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
| Stop / restart a whole run | `hpipe abort <run>` / `hpipe resume <run>` |

`hpipe brief --task <id>` reprints a task's brief (read-only). `forget <workspace>` only unbinds a workspace. `drain` just flushes the plugin's event queue — you
never need it in normal use.
