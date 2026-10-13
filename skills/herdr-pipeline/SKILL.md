---
name: herdr-pipeline
description: Use when running, orchestrating, checking on or unsticking a batch of Beads issues (beads) through the herdr pipeline plugin (stein.pipeline) — the `hpipe` CLI (start, start --single-pr, task, tier, dispatch, submit, batch-check, status, show, decide, answer, rewind, release, forget, next, bead show, escalate, discover, discoveries, close), review tiers, a batch shipped as one PR (land-queue, sync, landing on a batch branch, ship), worker agents in herdr worktrees, escalated or stalled tasks, "stuck input", "waiting on you", or a dead orchestrator/supervisor pane.
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
- **When Claude Code denies a command, stop and ask the user at once.** Name the command, why the run
  needs it, and the allow rule that would cover it. A denial is Claude Code's permission check, not
  GitHub or herdr refusing. Don't work around it or carry on with other steps first: an orchestrator
  always has more queued, and the skipped step stalls the run. A run needs `git push`, `gh pr create`,
  `gh pr merge`, `git pull`, `herdr worktree create`, `herdr agent start` and `hpipe`; ask for them
  before intake.
- `--surface <s>` needs `<repo>/.claude/agents/<s>-dev.md`. A repo may declare an executable
  `.claude/pipeline-bootstrap` to set up fresh worktrees.
- Run Claude with Opus as the default model. The orchestrator, the workers and every reviewer
  inherit it; only `implement`'s coding subagent is pinned, to Sonnet. Effort is pinned by tier
  instead: the `agent start` line in the dispatch block carries the worker's `--effort`, so run it as
  printed, and never drop the flag. Each review prompt names its own `effort:`; a standard task's
  `plan-review` runs at `medium`, below its other reviews, and the `effort:` line says so.

## Running a batch

1. `hpipe start "<title>" [--prefix <p>]` — the first start in a repo sets up its Beads store (needs
   `bd` ≥ 1.3.1; the prefix must start with a letter) and prints the intake prompt. Follow it. A
   second clone of a repo needs its own `--prefix`: the default comes from the repo's name, and
   `start` refuses one another checkout's store already uses, naming that checkout.
   Add **`--single-pr [--batch-branch <name>]`** when the batch should ship as one release: every
   task lands on a batch branch instead of opening a PR, and the run ends with one PR, one CI run and
   one squash merge. The mode is fixed at start. It needs a repo that allows squash merges, and it
   wants an executable `.claude/pipeline-check` (the tests and the typecheck): with no per-task CI,
   that check is the only test a landing gets before the final PR, and without one `status` marks
   every landing unverified. A task whose only deliverable is a document under `docs/superpowers/` cannot
   be submitted in such a run (`submit` counts those as the pipeline's, not as work to land). Its
   pipeline documents still land with its change: the research, spec, plan and review files under
   `docs/superpowers/` reach the batch and ship in the batch PR, as they ship in each task's PR
   per-task. `start`
   refuses beside a supervisor that predates single-PR runs — restart it (see **Recovery**).
2. One bead per task; **the bead's brief is the worker's entire brief** (goal, acceptance criteria,
   `file:line` pointers), captured when the task is registered. Check the backlog first: `hpipe next`
   shows bv's top 10 recommendations among unheld open beads — the picks claimable `now` (capped by
   `--limit`, default 5), then one line per later dependency layer, each waiting on the one before —
   and `hpipe bead show <id>` reads one. A bead `next` omits may still exist: before filing what looks
   like known work, raise `--limit`, `bead show` a known id, or ask the user.
   Register: `hpipe task --branch <b> --bead <id> --surface <s> [--depends-on t1,t2] [--files a/,b/c.ts]`
   — or `--title "<t>" --body-file <path> [--acceptance-file <path>]` instead of `--bead` to file a
   new bead in the same step; it prints `bead: <id> (filed)`. Adoption refuses a bead that is closed,
   assigned, held by a live task (any session), blocked by an open bead, or the parent of open child
   beads. Never run `bd` or `bv` yourself.
   `--files` / `--depends-on` are comma-separated, no spaces. `--files` are path prefixes: two tasks
   whose prefixes overlap never implement at the same time (the second waits in `blocked-on-files`),
   so to keep a task off t3's files, declare prefixes overlapping t3's. Plans can widen them later.
   A path the repo lists in `.claude/pipeline-shared-paths` never locks: declare it anyway (`task`
   prints it `(shared)`, and `start`'s `shared:` line says what is shared and at which commit). A
   broader prefix such as `docs/` still locks the rest of it. The list is read once, at `start`; a
   change to it waits for the next run.
   `hpipe next`'s `now` picks can run in parallel only when their `--files` are disjoint: bv knows
   nothing about files.
   Pick a tier with `--tier light|standard|heavy` (default `standard`). **light**: one surface, a
   handful of files, the brief pins the exact change. **heavy**: a contract another surface
   consumes, a data migration, security/auth, concurrency or state-machine code — or you are
   unsure. **standard**: the rest. When unsure, go higher. A `pipeline:tier-<name>` bead label
   overrides `--tier`; two tier labels are refused. The `tier:` line under `task_id:` says what was
   recorded and why. light skips `plan-review`; every tier gets one combined `pr-review`, except a
   light or standard task with a small change, which skips it (the `pr-review skipped` row under
   **While it runs**); heavy never skips it, and runs its spec review at the highest effort. A heavy task already in `pr-review-intent` or
   `pr-review-quality` from before an upgrade finishes it and goes on to `ci` (or `land-queue`).
3. Registration prints either `queued: waiting on …` (when its gate opens the supervisor sends you a
   `Dispatch tN` prompt carrying the same block — run it then) or a brief with a
   **`dispatch, in order:`** block. **Run that block exactly
   as printed**: `herdr worktree create … --base <commit>` (the fetched commit — never `--base main`;
   the `#` line under it says where its JSON gives the new checkout's path and pane), bootstrap (an
   `# optional:` step when the repo's setup script is not wired in as `.claude/pipeline-bootstrap`),
   `herdr agent start … -- --dangerously-skip-permissions`, then
   `hpipe dispatch --task <id> --pane <root pane>`, which submits the brief and confirms it landed. It claims the task's bead first; if bd refuses, nothing is sent.
   `dispatch --task` only works while the task is in `research`.
4. After the last task: `hpipe dispatch --done`. Until then the run can never finish. Registering
   another task later reopens intake — run `dispatch --done` again afterwards.

The supervisor nudges a silent task with a stall probe (by default workers every 45 min, the
orchestrator every 15; `TASK_STALL_MINUTES` and `STALL_MINUTES` in the plugin's `config.env` change
them, and each probe names the cadence in force). A reply does not answer a probe: only what the
phase waits for does. After 3 probes the next check escalates the phase, unless the pane is busy then
— mid-turn, or running a subagent, shell or monitor that Claude Code lists under its prompt — which
puts it off one cadence at a time, up to 3 times. So end your turn while a subagent you dispatched
works, and carry on when its completion notice arrives: Claude Code runs subagents in the background,
so no prompt asks you to wait for one within your turn. Do not poll or sleep to look busy. Never wait for a phase change with a background shell or monitor
polling `hpipe status`: a phase waits only for a subagent, and for at most 10 minutes once what it
waits for is there, so end your turn and let the next prompt arrive on its own. A pane Claude's usage limit has stopped is neither probed nor
escalated: the supervisor holds what it owes the pane and resumes it at the reset.

## While it runs

| You see | Do |
|---|---|
| A digest line reads `agent:done, background work running (1 shell, ui-dev subagent)` | Nothing: the worker is still at work behind its prompt, and its uncommitted files are not a stop. Its phase waits for a subagent, at most 10 minutes once the phase's artifact is there; it does not wait for a shell or a monitor. A worker's review also waits until the worker has committed its verdict, which it does once its reviewer's completion notice has woken it |
| `YOUR move: worker idle with N uncommitted paths (…)` | `hpipe nudge --task <id>`: it tells the worker, through the supervisor, to commit, push and finish its phase. It refuses while the worker's pane shows background work |
| Workers raise decisions with `hpipe decide`; you get a prompt naming the task and decision id (also under "waiting on you" in `hpipe status`) | — |
| A decision you escalate to the user | Ask it on its own, never bundled with another question: the worker waits for the whole dialog |
| A worker's decision you can settle from the repo | `hpipe answer --task <id> --decision <d> --answer "…" --by orchestrator` |
| A review's process question reaches you as a decision (a shared file, a flagged departure from the spec, rebasing onto a base that moved) | Settle it from the repo, as above. A review sends work back only for a BLOCKER — a defect that would ship, or a call only the owner can make — so these never cost another review pass |
| A decision only the owner can make (product, licence, scope) | Relay question + worker's recommendation + yours to the user, and run `hpipe escalate --task <id> --decision <d> --recommend "…"` so its bead shows blocked on them; record their reply with `--by human` |
| "Ready to merge — PR #n" | Check for conflicts with anything merged since (rebase + re-run bootstrap if needed), then run the printed `gh pr merge`. With CI's green head recorded it carries `--match-head-commit <sha>`, so GitHub refuses a head CI never passed. Merging is yours; nothing merges automatically |
| The merge prompt names a shared path ("This task declares the shared …") | Rebase onto the default branch and keep both sides' additions; CI runs again on the new head. If the two additions collide in meaning (the same id, number or section), don't resolve it by hand: run the printed `hpipe rewind <run> implement --task <id>`. Single-PR, a worker raises the same collision at `sync` as a decision recommending that rewind: answer it, then rewind |
| Workers recorded out-of-scope work (`hpipe discover`) | At branch review: `hpipe discoveries` lists it, `hpipe discoveries --file` files it as beads labelled `discovered` (in order; a failure stops it, and a retry carries on without duplicates) |
| The PR merged | Nothing to do: the supervisor closes the task's bead and moves it on |
| A light or standard task goes from `implement` straight to `ci` (or `land-queue`), and status says `pr-review skipped` | Nothing: its change added under 150 lines outside `docs/`, its design reviews cleared first time, and it touched nothing in the repo's `.claude/pipeline-always-review` (one path prefix per line, read from the base). The merge prompt says the review was skipped; a final branch review, when the run has one, still reads it. To keep a path always reviewed, the user commits it to that file on the default branch, before `hpipe start` for a single-PR run, which reads it from its batch branch. An edit to the file is always reviewed |
| Single-PR: "Land tN on batch/x" | Run the printed `git -C '<repo>' push origin <sha>:refs/heads/<batch>` exactly — that sha, no force, never the branch tip. If the push is refused for any reason, end your turn: the batch moved and the task syncs. Never `git pull` in the repo root, and never push to the task's branch while it waits to land |
| Single-PR: tN waits in `land-queue` | Nothing: one task lands at a time and the slot passes on its own. Only a task with no agent that must sync needs you — status prints the `agent start` line; its brief and sync prompt are already queued |
| Single-PR: "Ship — run …: one PR from batch/x" | Follow the ship prompt: bring the batch checkout up to date, `hpipe batch-check`, then `gh pr create` (or `gh pr edit`) with the printed body file. The PR clears only at a head `batch-check` recorded, so re-run it after any push to the batch: a push during `ship-ci` or `ship-merge` sends the run back to this prompt for it. Never edit the PR's description on GitHub: the merge step replaces it with that file |
| Single-PR: "Merge the batch PR" | Run the two printed commands: `gh pr edit … --body-file`, then `gh pr merge … --squash`. With CI's green head recorded the merge carries `--match-head-commit <sha>`, so GitHub refuses a head CI never passed. Squash only — the release notes come from the override block. Merging is yours |
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
| Workers idle after Claude's usage limit (`paused by Claude's usage limit` in `hpipe status`) | Nothing: the supervisor tells them to carry on at the reset and sends you one note. If one is still idle a few minutes after, `hpipe nudge --task <id>` (or `--all`). Never `rewind` to the same phase for this: that restarts the phase and its reviews. If your own session was stopped, the note says so: pick up what you were doing |
| A task sits in `close` and status shows its bead out of sync | Relay bd's error to the user (never run `bd` yourself), or `hpipe close --task <id>`; `--force` (overrides bd's close guards) only with the user's go-ahead |
| `hpipe start` refuses on bd's version | `brew upgrade beads` (the user's call — ask first); bd ≥ 1.3.1 is required |
| `hpipe next` or the board says `bv` is missing | The pipeline runs without it. Installing it is the user's call — its licence carries a rider (see the README) |
| The repo's `Board: …` tab is gone | `herdr plugin action invoke board --plugin stein.pipeline` from a pane in the repo, or let the supervisor reopen it next tick |
| Stop / restart a whole run | `hpipe abort <run>` / `hpipe resume <run>` |
| Plugin upgraded | Restart the supervisor after upgrading: close the `Pipeline supervisor` pane, then `herdr plugin action invoke supervisor --plugin stein.pipeline` (or restart the session). An old supervisor beside a new CLI routes tasks by the old table |
| Single-PR: red CI on the batch PR | Three routes, in order: an environmental failure gets an empty commit pushed to the batch, then `hpipe batch-check`; a small defect (a few lines, in files the failure names, nothing the release notes would mention) is fixed by a subagent in the batch checkout, then `hpipe batch-check`; a bigger defect becomes a fix task — `hpipe task …` registers it into the run (it moves the run back to `execute`), then `hpipe dispatch --done`. The batch PR gets **one** repair: a second red escalates the run, and `hpipe rewind <run> ship` gives it another |
| Single-PR: a branch-review BLOCKER too big to patch on the batch | Register a fix task the same way; registering works in `branch-review` and every ship phase until the PR merges |
| Single-PR: a sync was not a clean merge | Nothing: the task goes back through its reviews, which read the resolution. That review spends the task's review counter, so a task that already took one BLOCKER escalates on the next |
| Single-PR: anything touching the batch branch | Never force-push, rebase, squash or delete it, and never land anything but the printed sha: every base, every landing check and the release notes read its history |

`hpipe brief --task <id>` reprints a task's brief and `hpipe bead show <id>` a bead as Beads holds it now (both read-only). `forget <workspace>` only unbinds a workspace. `drain` just flushes the plugin's event queue — you
never need it in normal use.
