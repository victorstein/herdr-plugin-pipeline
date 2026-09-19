# One run resolver for every command that takes a task id — design (#21, #36, #38)

Pass 1. Written against this worktree at `60af84f` (branch `fix/21-run-resolution`), building on
`docs/superpowers/research/2026-09-18-issue-21-research.md` and answering
`docs/superpowers/reviews/issue-21-spec-review-0.md`. Every claim about current behaviour carries a
`file:line` or the command that produced it.

**Modelled on** `activeRunForRepo` (`src/lib/ledger.ts:64-69`) for the resolver — repo-keyed,
terminal-excluding, already the shape `cmdStart` uses; `cmdAnswer`'s phase guard
(`src/cli.ts:282-284`) for the refusals; `cmdStart`'s failure text (`src/cli.ts:31-34`) for an error
that names the way out; the `--files` validation block (`src/cli.ts:63-94`, commit `2006802`) for
where a check sits inside `cmdTask`; `test/ledger.test.ts:33-44` for the resolver's unit tests; and
`test/cli-argv.test.ts:13-42` for the subprocess proof. No new pattern is introduced.

## What changed from pass 0, by finding

Review 0 returned `VERDICT: CLEAR` — 0 BLOCKERs, 3 MAJORs, 6 MINORs. I verified every finding against
the code before accepting it; **all nine hold** and all nine are applied. Nothing was rejected
outright; one sub-claim of MINOR 4 is narrowed below, with evidence.

**MAJOR 1 — an unrecognised `run.phase` becomes fatal for all six commands.** Accepted, and the most
consequential finding. `runRow`/`taskRow` throw (`src/lib/phases.ts:77-81`, `:145-149`), `listRuns`
filters nothing (`src/lib/ledger.ts:48-62`), and `cmdRewind` writes its phase argument unvalidated
(`src/cli.ts:203`, `:214`) — a footgun `test/integration/smoke.md:542-544` already documents. Today
only `cmdStart` maps `runRow` over the ledger; pass 0 handed it to all six, and `dispatch()` has no
`try`/`catch` (`src/cli.ts:391-481`), so the result is an unhandled rejection, not a `fail()`.
Reproduced here independently:

    $ # rewind a fixture run to `dnoe`, then resolve it
    THREW: no run row for phase: dnoe

C1 now specifies a **total** terminal test, C5 gains phase-argument validation, and the Error
handling table has rows for both (A14).

**MAJOR 2 — rule 1 contradicted C3 and opened a new route to an unremovable ghost task.** Accepted.
Pass 0 said `--run` meant "no other filter applies", which drops `cmdTask`'s phase predicate as well
as the terminal test: `hpipe task --run <id>` into a `branch-review` or `escalated` run — both
non-terminal (`src/lib/phases.ts:60-66`, `:70-71`) — would register a task past `execute`, and
`test/integration/smoke.md:104-108` records that no command removes a task. Rule 1 is restated as
"`runId` replaces the **inference** filters, never the **legality** filters", and C3's six-way
refuse/allow column collapses into one `allowTerminal` property of the query, exactly as the review
proposed.

**MAJOR 3 — the headline error message named a recovery that loops.** Accepted. `cmdRewind`'s task
branch never touches `run.phase` (`src/cli.ts:191-208`) and has no terminal-run guard (`:188-190`),
so "`hpipe rewind` is the way in" leaves the resolver excluding the run on the next attempt and
reprinting the identical message. `hpipe resume` only works on a run whose last history entry starts
with `aborted from` (`src/cli.ts:334-337`), so a naturally-completed run has no way in at all. The
messages now name `--run` for the commands that allow it and state plainly that a finished run cannot
be re-entered for the ones that do not; testing item 8b asserts the suggested remedy actually
succeeds.

**MINOR 1 — A1's derivation regresses git submodules.** Accepted; reproduced in a fresh fixture:

    $ cd sm/super/sub
    git-dir    : …/sm/super/.git/modules/sub
    common-dir : …/sm/super/.git/modules/sub      ← equal, unlike a linked worktree
    dirname    : …/sm/super/.git/modules          ← not a repository

C2 now discriminates on `--git-dir` vs `--git-common-dir`, which differ **only** in a linked
worktree (measured: equal in a plain repo and in a submodule, different in this worktree).

**MINOR 2 — `abandonDecisions`' ordering was unspecified.** Accepted. It also nulls `pending_answer`
and its per-decision test reads it (`src/lib/decisions.ts:41`, `:45`), so calling it *before* the
existing discard block (`src/cli.ts:195-201`) would swallow the
`"answer to <id> discarded, undelivered"` history entry. C5 now pins it **after**, and testing item
11 asserts both halves.

**MINOR 3 — Goal 6 was broader than C5.** Accepted; Goal 6 is narrowed to the task form and the run
branch is an explicit non-goal.

**MINOR 4 — C7 stopped at `README.md`.** Accepted for `test/integration/smoke.md:542-544` (stale the
moment C5 validates the phase argument) and for the README escape-hatch rows at `:99-100`.
**Narrowed:** the review also cites `smoke.md:252` and `:531` as going stale because
`hpipe release --task t1` would stop resolving on a terminal run. Checked — both passages describe
releasing a holder inside a **live** run (`:250-254` is §4's file-gate walkthrough, `:531` is the
"stuck behind a holder" row, which says to make the *holder task* terminal, not the run), so the
resolver still finds them. They are left alone. The `hpipe decide`/`answer` passages at `:266-270`
and `:297-301` do gain a note about the git-cwd requirement (A15).

**MINOR 5 — A11 understated the surface.** Accepted. `src/actions/claim.ts` (mandated by A7) and
`test/integration/smoke.md` (MINOR 4) are added to A11's list, and C3 now says `repoKey` is threaded
through every command input, not just `runId`.

**MINOR 6 — two inaccuracies.** Accepted. The mis-pointed `(A2)` citation becomes its own **A15**,
which also records that `dispatch()` must read `flag(rest, 'run')` before the switch
(`src/cli.ts:396-403`). The testing strategy now carries the call-site migration: **40** existing
invocations across five test files, and three fixtures seeding `repoKey: 'k'` beside a real
`repoRoot` that must be made self-consistent.

## Problem

Six commands resolve a run by taking the first match out of a filename-sorted `listRuns`
(`src/lib/ledger.ts:48-62`, sort at `:57`). Task ids are minted per run — `t${run.tasks.length + 1}`
(`src/cli.ts:100`) — so every run with tasks has a `t1`, and completed runs are never pruned
(research §Current control flow, step 6). The population of runs that can shadow `t1` only grows.

| Site | Command | Filters today |
|---|---|---|
| `src/cli.ts:57-61` | `cmdTask` | phase ∈ {intake, dispatch, execute}. No repo. |
| `src/cli.ts:161-163` | `cmdBrief` | task id only. No phase, no repo. |
| `src/cli.ts:170-173` | `cmdDispatchDone` | phase, when `--run` is absent. No repo. |
| `src/cli.ts:228-230` | `cmdRelease` | task id only. No phase, no repo. |
| `src/cli.ts:247-250` | `cmdDecide` | task id only. No phase, no repo. |
| `src/cli.ts:273-276` | `cmdAnswer` | task id only, then a task-phase guard (`:282-284`). |

The three issues are three symptoms of that one line, escalating in severity: #21 registered a task
against another repo's run; #36 rendered a **completed** run's brief and dispatched a worker onto
already-merged work; #38 filed two live decisions onto a **completed** run and moved two torn-down
tasks back to `blocked-on-decision`.

It is live in this session right now. Simulating each predicate against
`~/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/` (research §What the live ledger resolves
to today): `hpipe decide --task t1` from **this pane** resolves to `…-qc13`, phase `done`, issue #9,
merged in PR #27, worktree torn down. The installed plugin is pinned to `9e792b5`, this branch's
base, so that is true of the binary driving this run, not of a hypothetical one.

Two facts decide the shape of the fix, and neither is in the issues:

1. **A `repo_key` filter alone cannot fix #36 or #38.** All three runs in this session share one
   `repo_key`; only their phase separates them. The terminal exclusion carries #36/#38, the repo
   filter carries #21, and neither is sufficient alone.
2. **`repoContext()` returns the wrong thing for every worker.** It shells out to
   `git rev-parse --show-toplevel` (`src/cli.ts:383-389`), which inside a worktree returns the
   *worktree* path, never the run's `repo_key`. Workers are the callers of `hpipe decide` — the brief
   prints that line into their pane (`prompts/worker-brief.md:47-49`) — so the filter both issues
   propose, implemented literally, would make `hpipe decide` fail for every worker in the fleet.

## Goal

After this change, no command can silently act on a run the caller did not mean.

1. Every command that resolves a run does so through **one function**, filtered by the caller's repo
   and excluding terminal runs.
2. Ambiguity **fails loudly**, naming the candidates, instead of taking the first.
3. A no-match failure **names what was searched for** and, when a run was excluded, says which and
   why — so the operator learns that a shadow exists instead of inferring it from a wrong `Closes #n`.
   Where it suggests a recovery, that recovery works (MAJOR 3).
4. `--run <run-id>` selects explicitly, for the case where ambiguity is legitimate — overriding
   *inference*, never *legality* (MAJOR 2).
5. Nothing can move a task in a finished run into a live phase — the guard `cmdAnswer` already has
   (`src/cli.ts:282-284`), extended to the command that lacked it.
6. **`hpipe rewind <run> <terminal-phase> --task <id>`** clears the stale decision it currently
   leaves behind, removing #38's three-command-per-task repair. (The run form is out of scope —
   MINOR 3.)
7. The brief names the run it was rendered from, so a misroute is visible in the pane.
8. A run the phase table cannot read degrades to a named refusal, not a stack trace (MAJOR 1).

## Non-goals

- **No session-unique task ids.** All four runs on disk carry `"schema_version": 2`
  (`src/lib/ledger.ts:38`). Task ids are referenced from `task.depends_on` (`src/cli.ts:102`),
  `run.history[].task_id` (`src/cli.ts:197`, `:208`) and every rendered prompt
  (`prompts/worker-brief.md:3`, `:47`). `README.md:104` records that a run from an older schema is
  **refused, not migrated** — so a bump strands the two live runs in this very session, including
  this one. The filter path needs no schema change (A8).
- **No change to `src/lib/phases.ts`, `src/supervisor/stall.ts`, `test/phases.test.ts` or
  `test/stall.test.ts`.** Those are the sibling task's declared files (#19, read from the live run
  record). This design *reads* `runRow`, `taskRow`, `RUN_ROWS` and `TASK_ROWS` — all already exported
  (`src/lib/phases.ts:51`, `:77`, `:89`, `:145`) — and never edits the table.
- **No change to `activeRunForRepo`.** `cmdStart` (`src/cli.ts:30`) and `src/actions/claim.ts:30` want
  first-match-any-active semantics: any active run for the repo blocks a second `hpipe start`, so
  ambiguity there is not an error (A9).
- **No decision-clearing in `cmdRewind`'s run branch (`src/cli.ts:209-218`) or in `cmdAbort`
  (`src/cli.ts:317-326`).** Both can put a run in `done` while its tasks hold open decisions, leaving
  the same `hpipe status` residue one level up (`src/lib/status.ts:29-34`). #38's reported repair used
  the task form; widening this is a separate change to run teardown that no issue owns (MINOR 3).
- **No repair of ledgers already damaged by #38.** `…-qc13`'s `t1`/`t2` were repaired by hand on
  2026-09-17. This change prevents the next one; it does not migrate the last one.
- **No pruning or archiving of completed runs.**
- **No `--run` on the rendered `hpipe answer` line in `prompts/decision.md:28-30`** (A12).
- **No change to `hpipe status`, `abort`, `resume` or `forget`.** `abort` and `resume` take an
  explicit `run_id` (`src/cli.ts:319`, `:331`); `forget` keys on a globally unique herdr workspace id
  (`src/lib/ledger.ts:71-76`).

## Architecture

Seven components. C1 in `src/lib/ledger.ts`; C2–C5 in `src/cli.ts` (C2 also `src/actions/claim.ts`);
C6 in `src/lib/worker-prompt.ts` + `prompts/worker-brief.md`; C7 in `README.md` +
`test/integration/smoke.md`.

### C1 (load-bearing) — `resolveRun` in `src/lib/ledger.ts`

Modelled on `activeRunForRepo` (`src/lib/ledger.ts:64-69`), which already reads `listRuns`, filters
on `repo_key`, and tests `runRow(r.phase).terminal`. `ledger.ts` already imports `runRow`
(`src/lib/ledger.ts:3`).

```ts
export interface RunQuery {
  runId: string | null
  repoKey: string | null
  phases: readonly RunPhase[] | null
  taskId: string | null
  /** The caller opts into a finished run; never inferred. Default false. */
  allowTerminal: boolean
}

export type RunResolution =
  | { ok: true; run: Run }
  | { ok: false; reason: 'no-such-run' }
  | { ok: false; reason: 'terminal'; run: Run }
  | { ok: false; reason: 'unreadable'; run: Run }
  | { ok: false; reason: 'none'; excluded: Run[] }
  | { ok: false; reason: 'ambiguous'; candidates: Run[] }
```

Semantics, in order:

1. **`runId` set** → exact `run_id` match; `no-such-run` when absent. `runId` replaces the
   **inference** filters — `repoKey` and `taskId` are skipped, because naming a run is the operator
   saying "not the one you would have guessed". It does **not** replace the **legality** filters:
   `phases` and the terminal test still apply, so `hpipe task --run <branch-review run>` is refused
   rather than minting a task into a run past `execute` (MAJOR 2).
2. Otherwise, over `listRuns`: `repo_key === repoKey` (when non-null) → not terminal → `phases`
   (when non-null) → `tasks.some(t => t.task_id === taskId)` (when non-null).
3. **The terminal test is total.** `runRow` throws on a phase with no row
   (`src/lib/phases.ts:77-81`) and nothing validates what is on disk, so the test is wrapped: a run
   whose phase the table cannot read is **not a candidate**, and is surfaced as `unreadable` when it
   was named by `runId`, or in `excluded` otherwise. One typo'd `hpipe rewind` must not make six
   commands throw (MAJOR 1, A14).
4. Exactly one → `{ ok: true }`. Zero → `{ ok: false, reason: 'none', excluded }`. Two or more →
   `{ ok: false, reason: 'ambiguous', candidates }`.

`excluded` is the diagnostic the issues ask for: the runs that matched **repo and task id** but
failed the terminal, phase or readability test, each with the reason. That is what turns
"no such task: t1" into "`t1` exists in `…-qc13`, which is `done`" — the sentence whose absence made
#36 and #38 invisible until a worker read a wrong issue number.

`resolveRun` composes no messages. `CmdResult` (`src/cli.ts:21-24`) is the established error channel
and the caller knows which flags were typed, so the text is built in `src/cli.ts` (A5).

### C2 — `repoContext` derives the repo the way a worktree sees it

Today `git rev-parse --show-toplevel` (`src/cli.ts:383-389`). It becomes: read
`--path-format=absolute --git-dir` and `--git-common-dir`; **equal** → use `--show-toplevel`;
**different** → `dirname(--git-common-dir)`. They differ only in a linked worktree. Measured (git
2.54.0):

| cwd | `--show-toplevel` | `git-dir` vs `common-dir` | derived |
|---|---|---|---|
| plain repo | `…/rt/main` | equal | `…/rt/main` |
| subdir of it | `…/rt/main` | equal | `…/rt/main` |
| repo via a symlink | `…/rt/main` | equal | `…/rt/main` |
| **submodule** | `…/super/sub` | equal | `…/super/sub` — not `…/.git/modules` (MINOR 1) |
| linked worktree | `…/rt/wt` | different | `…/rt/main` |
| **this worker's cwd** | `…/fix-21-run-resolution` | different | `/Volumes/stein/Documents/development/personal/herdr-plugin-pipeline` |

That last value is byte-equal to the `repo_key` stored in the live run file, and in all four live run
files. `--path-format` needs git ≥ 2.31 (A6). Outside a repo, stdout is empty and the existing
`root.length === 0` guard still fires (`src/cli.ts:387`).

`repoContext` gains an `export` so `src/actions/claim.ts` can use it in place of its own inline spawn
(`src/actions/claim.ts:12-20`), whose comment already states the requirement this change enforces:
"Identify the repo the same way `hpipe start` does … so the two agree." Importing from `../cli` is
safe and precedented — `dispatch()` is guarded by `if (import.meta.main)` (`src/cli.ts:483`) and
`test/cli-commands.test.ts:6` already imports the module (A7).

`needsRepo` (`src/cli.ts:398`) widens from `start|task` to every resolving command, conditioned on
`--run` (A15).

### C3 — the six call sites

Each command's input gains **`runId` and `repoKey`** (MINOR 5); none keeps a `.find` of its own.
`allowTerminal` is a property of the query, not a post-hoc check per command (MAJOR 2).

| Command | `phases` | `taskId` | `allowTerminal` |
|---|---|---|---|
| `cmdTask` | intake, dispatch, execute | — | `false` |
| `cmdDispatchDone` | intake, dispatch, execute | — | `false` |
| `cmdDecide` | null | yes | `false` |
| `cmdBrief` | null | yes | `runId !== null` — read-only |
| `cmdAnswer` | null | yes | `runId !== null` — the undo direction |
| `cmdRelease` | null | yes | `runId !== null` — the undo direction |

`allowTerminal: runId !== null` reads as "a finished run is reachable only by naming it". The split is
A3. `cmdAnswer` allowing it is not a loose end: it is precisely how #38's damage was repaired
(`rewind` into `blocked-on-decision`, `answer`, `rewind` back to `done`), and a ledger damaged before
this change still needs that path.

`cmdTask`'s `--surface` check reads `run.repo_root` (`src/cli.ts:71`). Once the run is guaranteed to
be the caller's, #21's reported symptom — this repo's surface validated against berean-os's tree —
disappears as a consequence of C1 rather than as a special case.

### C4 — refuse to move a task in a finished run into a live phase

With `allowTerminal: false` the resolver already refuses a terminal **run** for `cmdDecide`, so C4 is
now one guard, not two: `taskRow(task.phase).terminal` → `task t1 is finished (phase: done) — it
cannot be blocked on a decision`, worded after `src/cli.ts:282-284`. It catches what the run-level
test cannot see: a live run holding a task that has already reached `done`. It is inserted before
`enterTaskPhase` (`src/cli.ts:265`), which rewrites `task.phase` and `phase_entered_at`
(`src/lib/machine.ts:90-96`).

`taskRow` throws on an unknown phase like `runRow` does, so this guard uses the same total lookup as
C1 step 3 (A14).

Note the asymmetry preserved: `escalated` is **not** terminal for a run (`src/lib/phases.ts:70-71`)
or a task (`:130-131`), so an escalated task can still surface a decision — the state a human is most
likely to be untangling (A4). `cmdRelease`'s existing guard (`src/cli.ts:235-237`) is the inverse and
is left exactly as it is.

### C5 — `hpipe rewind`: abandon stale decisions, and validate the phase argument

Two changes, both in `cmdRewind`'s task branch (`src/cli.ts:191-208`).

**C5a — abandon.** The branch clears `pending_answer` with a history entry (`:195-201`) and never
touches `task.decisions`, so an unanswered decision survives and `openDecisionFor`
(`src/lib/decisions.ts:3-5`) keeps `hpipe status` printing the warning (`src/lib/status.ts:29-34`).
That is what made #38's repair three commands per task. `abandonDecisions`
(`src/lib/decisions.ts:38-46`) already does the job and is already exported; `src/cli.ts:4` already
imports from that module. When the rewind target is a terminal task phase, call it — **after** the
existing `pending_answer` block, never before (MINOR 2). Ordering is load-bearing:
`abandonDecisions` nulls `pending_answer` (`:45`) and its per-decision test reads it (`:41`), so
calling it first would abandon an answered-but-undelivered decision silently and lose the
`"answer to <id> discarded, undelivered"` entry the current code guarantees. Called after, only
genuinely open decisions are abandoned. Only on a terminal target — rewinding *into*
`blocked-on-decision` is how the answer path is re-armed (A10).

**C5b — validate.** `cmdRewind` writes its phase argument unvalidated —
`task.phase = input.phase as TaskPhase` (`src/cli.ts:203`), `run.phase = input.phase as RunPhase`
(`:214`) — and `test/integration/smoke.md:542-544` documents the consequence. C5a would make it
worse by calling `taskRow` on that raw string. The fix is a membership check against the exported
`TASK_ROWS`/`RUN_ROWS` (`src/lib/phases.ts:89`, `:51` — a read, not an edit) before anything is
written, failing with the valid names. This is the one piece a reviewer could reasonably cut (A14).

`src/lib/decisions.ts` and `src/lib/phases.ts` are read and called, never edited.

### C6 (most droppable) — the brief names its run

#36's last direction. `renderWorkerPrompt` already receives the whole `Run`
(`src/lib/worker-prompt.ts:10-12`) and builds one var bag for both `worker-brief` and `research`
(`:16-34`), so `run_id: run.run_id` is a one-line addition reaching all three render sites —
`src/cli.ts:151`, `src/cli.ts:166`, `src/supervisor/tasks.ts:152` — with no caller change. A
`{{run_id}}` line is added beside the task id at `prompts/worker-brief.md:3`.

Two guards constrain the prose: `test/prompts.test.ts:68-76` fails any prompt containing a literal
`hpipe` outside `{{hpipe}}`, and `:36-43` pins `{{agent_file}}` and `Closes #{{issue}}`. `render()`
throws on an unresolved placeholder at delivery time in front of an agent (`src/lib/render.ts:11`),
which is why the var is added to the bag in the same edit.

Naming the run also makes the `--run` escape actionable for a worker: if ambiguity ever does fail its
`hpipe decide`, the id it needs is already in its pane.

### C7 — documentation

`README.md`: `--run <run-id>` on the registration and answer forms (`:79-80`, `:89`), plus the
escape-hatch rows for `rewind` and `release` (`:99-100`) and a new row for "two live runs in one
session" (MINOR 4).

`test/integration/smoke.md`: the rewind gotcha at `:542-544` is rewritten — C5b makes "a typo puts
the task in a phase with no row and the next tick throws" false — and the `hpipe decide`/`answer`
passages at `:266-270` and `:297-301` gain a one-line note that these now resolve against the
caller's repo (A15). `:250-254` and `:531` are **not** touched: both describe releasing a holder
inside a live run, so they keep resolving (MINOR 4, narrowed).

## Data and control flow

1. `dispatch()` builds `ctx` from `HERDR_PLUGIN_STATE_DIR` and `sessionKey()` (`src/cli.ts:391-395`).
   Unchanged.
2. **C2: `repoContext()` derives the shared repo root, for six commands rather than two**
   (`src/cli.ts:398`). It is skipped when `--run` was given, which `dispatch()` must therefore read
   before the switch (`flag(rest, 'run')`, `src/cli.ts:396-403`) — A15.
3. **C3: the command calls `resolveRun` with its `RunQuery`** instead of `listRuns(...).find(...)`.
4. **C1: one run, or a typed failure** — `ok` / `no-such-run` / `terminal` / `unreadable` / `none` /
   `ambiguous`, each rendered into a sentence by `src/cli.ts`.
5. **C4: `cmdDecide` tests `taskRow(task.phase).terminal`** before `enterTaskPhase`
   (`src/cli.ts:265`).
6. Everything downstream is unchanged: the `--issue`/`--branch`/`--surface`/`--files` validation
   (`src/cli.ts:63-94`), the task literal (`:99-116`), `detectCycle` (`:126`), `gateStatus` (`:141`),
   `saveRun`, and the returned brief.
7. **C5: `cmdRewind` validates its phase argument, then abandons decisions on a terminal target.**

Nothing machine-parses these commands' stdout: `grep -rn "task_id:" src/ prompts/ test/ bin/` finds
only the two producers in `src/cli.ts`, `history` writes, and `toContain` assertions. The supervisor
never calls a `cmd*` function — it drives `src/supervisor/tick.ts` over `listRuns` directly
(`src/supervisor/main.ts:115`), which this change does not touch.

## Error handling

Every failure is a `fail()` (`src/cli.ts:24`) — exit 1, nothing written, `saveRun` never reached.

| Situation | Today | After |
|---|---|---|
| `hpipe task` in repo A, live run in repo B first | registers into B's run | `no live run for <repoA> in session <s>` + `hpipe start` as the way out |
| `hpipe brief --task t1`, a `done` run sorts first | renders the wrong brief | resolves the live run |
| `hpipe decide --task t1`, a `done` run sorts first | files onto it, task → `blocked-on-decision` | resolves the live run |
| task id exists only in a terminal run, read/undo command | acts on it | `no live run … holds t1` + `t1 is in <id> (done)` + **`--run <id>` to act on it anyway** |
| task id exists only in a terminal run, `task`/`decide` | acts on it | same, minus the suggestion: `a finished run cannot be re-entered` (MAJOR 3) |
| `--run <terminal id>`, `task`/`decide`/`dispatch --done` | n/a | `run <id> is finished (phase: done)` |
| `--run <id>` naming a run past `execute`, `hpipe task` | n/a | `run <id> is in branch-review; a task can only be registered in intake, dispatch or execute` (MAJOR 2) |
| two live runs in one repo+session | first wins, silently | `more than one run matches … → --run <id>` |
| `--run` names nothing | n/a | `no such run: <id>` — the existing wording at `src/cli.ts:176` |
| **a run whose phase has no row** | `cmdStart` throws; the other five ignore it | named and skipped: `<id> has an unrecognised phase: dnoe` (MAJOR 1) |
| `hpipe rewind <run> dnoe` | writes `dnoe`, next tick throws | `no such phase: dnoe — valid task phases are …` (C5b) |
| not in a git repo, no `--run` | resolves across all repos | `hpipe: not inside a git repository` — the existing wording at `src/cli.ts:401` |
| `hpipe rewind <run> done --task t1` with an open decision | decision survives, status nags | abandoned, one history entry |

`hpipe resume` is **not** offered as a recovery: it requires a run whose last history entry starts
with `aborted from` (`src/cli.ts:334-337`), so it does nothing for a naturally-completed run, and
`hpipe rewind --task` is not offered either — it moves the task but leaves `run.phase` untouched
(`src/cli.ts:191-208`), so the resolver would exclude the run again and reprint the same message
(MAJOR 3).

The "excluded" clause is the load-bearing half. #36's brief was wrong for **hours** because nothing
anywhere said a second `t1` existed; a message that names the shadow converts a silent misroute into
a sentence the operator reads before the worker starts.

## Assumptions

Each is a behavioural choice, stated so the review can attack it.

**A1 (revised for MINOR 1) — the caller's repo is `--show-toplevel` when `--git-dir` equals
`--git-common-dir`, and `dirname(--git-common-dir)` when they differ.** The two forms differ only in
a linked worktree, which is exactly the case pass 0 set out to fix; the equality branch keeps plain
repos, subdirectories, symlinked paths and **submodules** on the derivation that is already correct
for them. Verified in a fresh fixture, six cases, table in C2. The residual cost is unchanged:
`hpipe start` run from inside a worktree now records the parent repo, a `cmdStart` behaviour change
this issue did not ask for. Review 0 attacked and cleared that cost —
`repo_root` feeds `worktree create --cwd {{repo_root}}` (`src/supervisor/tasks.ts:151`,
`test/prompts.test.ts:60-66`), where the parent is what herdr should be given, and all four live run
files already carry main-checkout `repo_key`s, so nothing on disk is stranded.

**A2 — One derivation for every command, not "repo for the orchestrator, `checkout_path` for the
worker".** `task.checkout_path` (`src/lib/types.ts:77-78`) is byte-equal to a worker's cwd and would
also work. Rejected because it is a second resolution rule applying to some callers and not others,
it is null until the worktree is bound, and it would make `hpipe decide` behave differently depending
on who typed it. One rule is testable; two are a matrix.

**A3 (revised for MAJOR 2) — a finished run is reachable only by naming it, and only by the commands
that do not move a task forward.** Expressed as `allowTerminal: runId !== null` on
`brief`/`answer`/`release`, and `false` on `task`/`decide`/`dispatch --done`. The line is "does this
move a task forward into a live phase". #38's damage was created by a forward move and undone by
`answer`; refusing both would leave an already-damaged ledger unrepairable by anything but `rewind`.
Attack surface: a reviewer may still prefer "refuse all mutation on a terminal run", at the cost of
breaking the documented repair path (`README.md:99`).

**A4 — `escalated` stays resolvable.** Non-terminal for a run (`src/lib/phases.ts:70-71`) and a task
(`:130-131`), and `cmdRelease` already special-cases it (`src/cli.ts:234-237`). It is the state a
human is most likely to be untangling.

**A5 — `resolveRun` returns a typed failure; `src/cli.ts` writes the sentence.** `ledger.ts` composes
no user-facing text today; returning a formatted string would put message copy in a storage module
and make the resolver untestable without string matching.

**A6 — `--path-format=absolute` is acceptable to require.** git 2.31+ (March 2021); the host runs
2.54.0.

**A7 — `src/actions/claim.ts` imports the exported `repoContext`.** Its comment (`:12-15`) states the
two identifications must agree; leaving it on `--show-toplevel` makes that true only by the
circumstance that the orchestrator pane sits in the main checkout. Review 0 confirmed there is no
import cycle and that `dispatch()` stays dormant behind `import.meta.main`.

**A8 — No schema change.** No `Run` or `Task` field is added or removed; `schema_version` stays 2, so
a run written by this CLI is readable by the pinned supervisor. Confirmed by review 0 against C1–C7.

**A9 — `activeRunForRepo` is left alone rather than reimplemented on `resolveRun`.** `cmdStart` wants
"any active run blocks" (`src/cli.ts:30-34`); folding it in would make `hpipe start` fail where it
should refuse. It keeps its throwing `runRow` call, which is pre-existing and in one command.

**A10 — `rewind` abandons decisions only when the target phase is terminal, and only in the task
branch.** The alternative — abandon on every rewind except into `blocked-on-decision` — would
silently discard an open decision on a rewind to `plan`, where the question may still be the one that
needs answering. Narrow is reversible; broad is not. The run branch and `cmdAbort` are non-goals
(MINOR 3).

**A11 (extended for MINOR 5) — six files this change must touch are in no task's declared `--files`,
and I am taking them rather than surfacing a decision.** My declared set, read from the live run
record, is `src/cli.ts`, `src/lib/ledger.ts`, `test/cli.test.ts`, `test/cli-commands.test.ts`,
`test/cli-argv.test.ts`, `test/ledger.test.ts`. Beyond it: **`test/decide.test.ts`** (its calls stop
compiling once the input type gains `runId`/`repoKey` — `test/decide.test.ts:97-119`, `runWithTask`
at `:86-91`), **`README.md`** and **`test/integration/smoke.md`** (C7), **`src/lib/worker-prompt.ts`**
and **`prompts/worker-brief.md`** (C6), and **`src/actions/claim.ts`** (A7). The sibling task #19
declares `src/lib/phases.ts`, `src/supervisor/stall.ts`, `test/phases.test.ts`, `test/stall.test.ts`
— **no overlap**, so there is no race with anyone; the gap is that the declaration was written before
the design existed. Also relevant: `hpipe decide` from this pane currently files onto a completed run,
so surfacing this would exercise the defect under repair. It is recorded here and will be named in
the PR body.

**A12 — the rendered `hpipe answer` line in `prompts/decision.md:28-30` does not gain `--run`.** The
orchestrator's pane sits in the repo whose run it drives, so C3 resolves it; if two live runs ever
share that repo the command fails loudly and names the ids. Hard-coding the flag would make the
prompt carry state the resolver already derives.

**A13 — ambiguity is a hard failure, not a preference order.** "Newest run wins" would resolve every
case in this session correctly and never bother anyone. Rejected: it is the same class of silent
choice as "first match wins", differing only in being right more often — and #36 is the proof that a
rule which is usually right is indistinguishable from a rule that is wrong until a worker has spent
hours on the wrong issue. Review 0 confirmed the ledger's filename sort is what decides today
(`src/lib/ledger.ts:57`).

**A14 (new, MAJOR 1) — an unreadable phase is a refusal, and `hpipe rewind` stops being able to
create one.** Two halves. The first is defensive and not optional: C1 puts `runRow` in the path of
six commands where today it is in one, `dispatch()` has no `try`/`catch` (`src/cli.ts:391-481`), and
a single typo'd rewind would otherwise turn every command in the session into a stack trace. The
second (C5b) is the narrower judgment: validating `cmdRewind`'s phase argument **changes a command's
accepted input**, rejecting what it accepts today. I take it because C5a would otherwise call
`taskRow` on that unvalidated string, and because the footgun is already written down as a known
hazard (`test/integration/smoke.md:542-544`). **This is the most attackable addition in pass 1** — it
is the one change here that neither #21, #36 nor #38 asks for. If the review disagrees, C5b drops and
C5a keeps the total lookup from A14's first half.

**A15 (new, MINOR 6) — a resolving command outside a git repository fails, unless `--run` names the
run.** Without a repo there is no filter, and falling back to "first match across all repos" is the
bug. `dispatch()` therefore reads `flag(rest, 'run')` before the switch to decide whether
`repoContext()` is required (`src/cli.ts:396-403`). The existing message at `src/cli.ts:401` is
reused and gains the `--run` clause. Cost: `hpipe brief --task t1` typed from `~` stops working; it
was already resolving arbitrarily.

## Testing strategy

TDD throughout: failing test, run it, minimum code, run it again. Baseline to hold —
`bun test` → **454 pass, 0 fail, 1072 expect() calls, 34 files**; `bun run typecheck` → clean.
Measured at `9e792b5` and reproduced by review 0. CI here is a PR-title lint only (#35), so both are
run locally and quoted in the PR body.

**Call-site migration (MINOR 6), the bulk of the diff.** `runId`/`repoKey` on six input types touches
**40** existing invocations: `cmdTask` 20, `cmdDecide` 7, `cmdAnswer` 5, `cmdRelease` 3,
`cmdDispatchDone` 3, `cmdBrief` 2, across `test/cli.test.ts`, `test/cli-commands.test.ts`,
`test/decide.test.ts`. Three fixtures seed `repoKey: 'k'` beside a real `repoRoot`
(`test/cli-commands.test.ts:30`, `test/cli.test.ts:50`, `test/decide.test.ts:87`) and must be made
self-consistent or every repo-filtered test fails for the wrong reason. `typecheck` is the driver
here: the compiler names every site.

**Resolver units, `test/ledger.test.ts`** — modelled on `test/ledger.test.ts:33-44`:

1. picks the live run when a terminal run sorts first (the #36/#38 shape, same `repo_key`);
2. picks this repo's run when another repo's sorts first (the #21 shape);
3. `ambiguous` with both ids when two live runs share repo and session;
4. `none` with the terminal run in `excluded` when the only `t1` is in a `done` run;
5. `runId` skips the repo and task filters but **still applies `phases`** — a `branch-review` run
   named by `--run` is refused for a `cmdTask` query (MAJOR 2's regression test);
6. `runId` + `allowTerminal: true` returns a `done` run; `allowTerminal: false` returns `terminal`;
7. a run whose phase has no row is skipped, not thrown over, and appears in `excluded`; named by
   `runId` it returns `unreadable` (MAJOR 1's regression test).

**Command level, `test/cli-commands.test.ts`** — modelled on `release refuses a task that is still in
flight` (`:108-118`), which asserts `ok === false`, the message, and an unchanged ledger:

8. `cmdDecide` refuses a task in a terminal run and **writes nothing** — `decisions` still empty,
   `phase` still `done`. The #38 regression test; "writes nothing" is what proves the guard sits
   before `enterTaskPhase`.
   8b. the remedy the message names actually works: `cmdBrief`/`cmdAnswer`/`cmdRelease` with
   `--run <that id>` succeed on the same fixture, and `cmdDecide`'s message does **not** name
   `rewind` or `resume` (MAJOR 3).
9. `cmdBrief` renders the live run's brief when a completed run holds the same task id — #36's exact
   reproduction, asserting on the issue number.
10. `cmdTask` registers into this repo's run with another repo's run present — #21's reproduction.
11. each of the six reports ambiguity with both run ids and the string `--run`.
12. `cmdRewind` to `done` abandons an open decision (`openDecisionFor` → null) **and still records
    the `"discarded, undelivered"` history entry for a separate answered-but-undelivered decision** —
    MINOR 2's ordering, both halves in one fixture. Rewinding to `plan` leaves the open decision
    alone.
13. `cmdRewind` with a phase that is in no row fails and writes nothing (C5b).
14. `cmdAnswer` still works on a terminal run named by `--run` — A3's repair path, pinned.

**Through the real argv path, `test/cli-argv.test.ts`** — the layer this bug lived in. `dispatch`,
`flag` and `repoContext` are reachable only as a subprocess; `:13-35` already builds a real git repo
and pins `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_ROOT`, `HERDR_SESSION` and `HERDR_SOCKET_PATH` so a
fixture cannot land in the live ledger. Three additions, needing a real worktree — **no change to
`test/helpers/git-worktree.ts`**: it already exports a raw `git(args, cwd)` runner (`:7-10`) which
`test/cli-argv.test.ts:22` uses, so the worktree is one more `git(['worktree', 'add', …], repo)` call
inside the test's own `fixture()`. (`repoWithWorktree` at `:24-39` is not reusable — it returns only
the worktree path and seeds no agent file at a caller-chosen surface.)

15. `hpipe task` run **from inside a `git worktree`** resolves the run whose `repo_key` is the parent
    repo — the C2 proof, and the assertion no unit test can make;
16. `hpipe decide --task t1` from a second fixture repo does not reach the first repo's run;
17. a resolving command outside any git repo fails with the `--run` clause, and succeeds when `--run`
    is supplied (A15).

`.claude/agents/plugin-dev.md` records that DI-faked unit tests "have passed clean over real defects
twice", which is why 15–17 are mandatory rather than optional.

**Live verification.** This change touches none of startup, gating, delivery or pane I/O, so the
plugin-dev guide's live-session requirement is not triggered. It is still verifiable against real
data without writing to the ledger: copy
`~/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/` into a scratch state dir and run the
built CLI against the copy with `HERDR_PLUGIN_STATE_DIR` pinned. Before the change `--task t1`
resolves `…-qc13` (`done`); after it, `…-v0qh` (`execute`). The live directory is never the target —
the pinned env is the whole safety argument, the same one `test/cli-argv.test.ts:13-19` makes.

**Regression guards already present that must stay green:** `test/cli-commands.test.ts:262-273`
(bare `dispatch --done` finds the active run — the path both prompts take), `:304-319` (`brief`
mutates nothing), `test/cli.test.ts:37-46` (`start` refuses a second run for the same repo),
`test/prompts.test.ts:36-43` and `:68-76` (C6's prose).

## Rejected alternatives

**Prune or archive completed runs.** Removes the shadowing at its root. Rejected: it destroys the
record `hpipe status` and every post-mortem read — the 2026-09-16 berean-os ledger is still on disk
and is the evidence base for this batch — and it fixes #36/#38 while leaving #21 untouched.

**Session-unique task ids.** The issues' own third direction, and the only fix that removes the
ambiguity rather than filtering it. Rejected under A8: a schema change against a ledger the plugin
refuses rather than migrates (`README.md:104`), it would strand this very run, and it leaves #21
unfixed — a `t1` unique to its run still resolves into the wrong repo without a repo filter.

**Resolve by `process.cwd()` prefix-matching `repo_root` or `checkout_path`.** No git shell-out at
all. Rejected: prefix matching is wrong at directory boundaries (`…/foo-2` prefix-matches `…/foo`) and
would need path-segment-aware comparison, a new utility where `git rev-parse` is an existing trusted
one (`src/cli.ts:383-389`, `src/actions/claim.ts:14`).

**Newest run wins.** Rejected under A13.

**Validate the brief against the task it was requested for, downstream.** #36 observes that "nothing
in the pipeline compares a brief against the task it was requested for". Rejected as the primary fix
— it detects what C1 makes impossible — but C6 is its cheap half.

**Leave `cmdDispatchDone` and `cmdRelease` alone, fix only the four commands the issues name.**
Rejected: both resolve the same way, `cmdDispatchDone`'s bare form is the one both prompts instruct
(`test/cli-commands.test.ts:262-273`), and #38's own direction is to stop "the next command
inheriting the same defect".

**Keep `--run` as a total override (pass 0's rule 1).** Rejected under MAJOR 2: it drops the phase
predicate along with the repo filter, and `hpipe task --run <branch-review run>` would mint a task no
command can remove (`test/integration/smoke.md:104-108`).
