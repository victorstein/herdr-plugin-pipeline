# Adversarial spec review — issue #21 (with #36, #38), pass 0

Target: `docs/superpowers/specs/2026-09-18-issue-21-design.md` (475 lines), reviewed against
`docs/superpowers/research/2026-09-18-issue-21-research.md`, `gh issue view 21|36|38`, and the
worktree at `60af84f`.

## What I verified before attacking

Every `file:line` in the spec that I sampled resolves. Spot-checked and correct: `src/cli.ts:57-61`,
`:161-163`, `:170-173`, `:228-230`, `:247-250`, `:273-276`, `:282-284`, `:259-261`, `:235-237`,
`:265`, `:383-389`, `:398`, `:401`, `:176`, `:483`; `src/lib/ledger.ts:3`, `:48-62` (sort at `:57`),
`:64-69`, `:71-76`; `src/lib/phases.ts:70`, `:130`; `src/lib/decisions.ts:3-5`, `:38-46`;
`src/lib/status.ts:29-34`; `src/lib/machine.ts:90-96`; `src/lib/worker-prompt.ts:10-12`, `:16-34`;
`README.md:79-80`, `:89`, `:99-104`; `test/cli-commands.test.ts:108-118`, `:262-273`, `:304-319`;
`test/cli-argv.test.ts:13-35`; `test/helpers/git-worktree.ts:7-10`, `:24-39`;
`test/prompts.test.ts:36-43`, `:60-66`, `:68-76`; `test/decide.test.ts:86-91`, `:97-119`.

Baseline reproduced exactly:

    $ bun test          → 454 pass, 0 fail, 1072 expect() calls, 34 files
    $ bun run typecheck → tsc --noEmit, no output, exit 0

A1/C2's measured table reproduced in a fresh fixture (git 2.54.0):

| cwd | `--show-toplevel` | `dirname(--path-format=absolute --git-common-dir)` |
|---|---|---|
| plain repo | `…/rt/main` | `…/rt/main` |
| subdir of it | `…/rt/main` | `…/rt/main` |
| via a symlink | `…/rt/main` | `…/rt/main` |
| linked worktree | `…/rt/wt` | `…/rt/main` |
| this worktree | `…/fix-21-run-resolution` | `/Volumes/stein/Documents/development/personal/herdr-plugin-pipeline` |

That last value is byte-equal to `repo_key` in all four live `pipeline`/`personal` run files. Outside
a repo the command writes to stderr and leaves stdout empty, so `repoContext`'s `root.length === 0`
guard still fires. `bin/hpipe:43` `exec`s without changing directory, so the caller's cwd does reach
`repoContext`. A1 and A2 survive on their stated ground; the attacks below are elsewhere.

The design is sound in its core choice and unusually well evidenced. The findings are three real
holes plus six smaller ones, none of which reverse a decision.

---

## MAJOR 1 — C1 makes an unrecognised `run.phase` fatal for all six commands, and `hpipe rewind` can write one

**Claim.** C1, semantics step 2: the resolver filters `listRuns` with `!runRow(r.phase).terminal`,
and C5 has `cmdRewind` test whether the rewind target "is a terminal task phase".

**Problem.** `runRow`/`taskRow` **throw** on a phase with no row (`src/lib/phases.ts:77-81`,
`:145-149`), and `listRuns` applies no `schema_version` or phase filter — it returns every `*.json`
in the session directory (`src/lib/ledger.ts:48-62`). `cmdRewind` does **not** validate its phase
argument: `run.phase = input.phase as RunPhase` (`src/cli.ts:210`) and
`task.phase = input.phase as TaskPhase` (`src/cli.ts:203`). The repo already knows this —
`test/integration/smoke.md:542-544`: "`hpipe rewind` does **not** validate its phase argument against
the phase table. A typo puts the task in a phase with no row and the next tick throws."

Today that blast radius is one command: only `cmdStart`, via `activeRunForRepo`, maps `runRow` over
the ledger. The other five compare phase strings literally (`src/cli.ts:59-60`, `:172-173`) and never
touch the table. C1 hands the `runRow` call to **all six**, and `dispatch()` has no `try`/`catch`
(`src/cli.ts:391-481`), so the failure is an unhandled rejection with a stack trace rather than a
`fail()`.

**Evidence.** Measured against this worktree's `src/`:

    rewind result: true "rewound r-20260919-a-rnw0 to dnoe; counters cleared"
    saved phase: dnoe
    cmdBrief today: no such task: tX          ← plain string compare, survives
    activeRunForRepo THREW: Error: no run row for phase: dnoe   ← the shape C1 adopts

C5 makes it worse in `cmdRewind` itself: `taskRow(input.phase)` on an unvalidated string turns the
documented recovery at `smoke.md:543-544` ("rewind again to a real phase name") into a command that
throws on the typo that created the mess. Nothing in the spec mentions any of this; the Error
handling table has no row for it.

**Fix.** Two lines, neither touching the sibling's `src/lib/phases.ts`:

1. In `resolveRun`, make the terminal test total — a local helper that catches the throw and treats
   an unrecognised phase as *not a candidate*, surfacing it in `excluded` with the reason
   (`"<id> has an unrecognised phase: <phase>"`). An unreadable run then degrades to a named refusal
   instead of a stack trace, which is exactly the Goal-3 contract.
2. Validate `cmdRewind`'s phase argument up front against the exported `RUN_ROWS`/`TASK_ROWS`
   (`src/lib/phases.ts:51`, `:89` — both already `export`ed, so this is a read, not an edit) and
   `fail()` with the valid names. Add it to C5 and to the Error handling table, and delete the now
   -stale gotcha at `smoke.md:542-544`.

---

## MAJOR 2 — C1's rule 1 ("`--run` bypasses every other filter") contradicts C3 and opens a new way to mint an unremovable task

**Claim.** C1 semantics step 1: "**`runId` set** → exact `run_id` match, and **no other filter
applies**. An explicit id is the operator overriding inference." C3's table then gives a per-command
column "On a terminal run named by `--run`" with values *refuse* / *allow*.

**Problem.** The two are inconsistent, and the inconsistency is not only cosmetic. If no other filter
applies, `resolveRun` returns `{ok:true}` for a terminal run under `--run`, so the refusals in C3's
last column must be re-implemented per command — yet C4 specifies the guard only for `cmdDecide`
("Two guards are added before it", i.e. before `enterTaskPhase` at `src/cli.ts:265`). `cmdTask` and
`cmdDispatchDone` are told to refuse with no component saying where.

More seriously, C3's carve-out covers only **terminal** runs, so rule 1 also drops `cmdTask`'s
**phase** predicate. `hpipe task --run <id>` against a run in `branch-review` or `escalated` — both
non-terminal (`src/lib/phases.ts:60-72`) — would register a task into a run that is past `execute`.
That predicate (`src/cli.ts:58-60`) is the only thing preventing it today, and the damage is
permanent: `test/integration/smoke.md:104-105` records that "no command removes a task", which is why
a single ghost registration forces `hpipe abort` and a restart. The design would introduce a second
route to the exact failure that runbook step exists to catch.

**Evidence.** `cmdTask`'s predicate, `src/cli.ts:57-61`; the non-terminal rows for `branch-review`
(`src/lib/phases.ts:60-66`) and run `escalated` (`:70-72`); no task-removal command in
`dispatch()`'s switch (`src/cli.ts:404-476`); `smoke.md:104-108`.

**Fix.** Restate rule 1 as "`runId` replaces the *inference* filters (repo, task id), not the
*legality* filters". Concretely: when `runId` is set, skip `repoKey` and `taskId`, but still apply
`phases` and the terminal test, and let the caller decide — `brief`/`answer`/`release` pass
`phases: null` and opt into terminal runs explicitly via a `allowTerminal` flag on `RunQuery`, while
`task`/`dispatch --done`/`decide` do not. That collapses C3's six-way "refuse/allow" column into one
property of the query and removes the need for per-command re-checks.

---

## MAJOR 3 — the headline error message points the operator at a recovery that does not work

**Claim.** Error handling table: "task id exists only in a terminal run → `no live run … holds t1` +
`t1 is in <id> (done)` + **`hpipe rewind` as the documented way in**". The Goal-3 argument is that
this sentence is "the load-bearing half" of the whole change.

**Problem.** `hpipe rewind <done-run> <phase> --task t1` moves the *task* to a live phase but leaves
`run.phase === 'done'` — `cmdRewind`'s task branch never touches `run.phase` (`src/cli.ts:191-208`),
and it has no terminal-run guard at all (`:188-190` checks only `no such run`). The resolver excludes
on the **run's** phase before it ever reaches the task filter (C1 step 2). So the operator follows the
advice, the command still fails with the identical message, and they are in a loop. For `cmdDecide`
it is worse: C4 refuses a terminal run unconditionally, and `hpipe resume` only works on a run whose
last history entry starts with `aborted from` (`src/cli.ts:333-337`), so a naturally-completed run has
**no** documented way in at all.

**Evidence.** `src/cli.ts:188-208` (rewind's task branch, no run-phase write, no terminal guard);
`src/cli.ts:330-344` (`cmdResume` requires an abort); C1 step 2 ordering; C4.

**Fix.** Make the message name the thing that actually works: `--run <id>` for the commands C3 marks
*allow* (`brief`, `answer`, `release`), and for `task`/`decide` say plainly that a finished run cannot
be re-entered and name `hpipe resume <id>` with its abort precondition. Add a test — the testing
strategy's items 7 and 8 assert the refusal but nothing asserts the suggested remedy succeeds, which
is how a message like this stays wrong.

---

## MINOR 1 — A1's derivation regresses submodules, and the fix is one comparison

`dirname(--path-format=absolute --git-common-dir)` inside a git submodule yields
`<super>/.git/modules`, which is not a repository. Measured:

    $ cd sm/super/sub
    toplevel:   …/sm/super/sub
    git-dir:    …/sm/super/.git/modules/sub
    common-dir: …/sm/super/.git/modules/sub
    dirname:    …/sm/super/.git/modules        ← recorded as repo_key AND repo_root

`hpipe start` there would write that as `repo_root`, and the very next `hpipe task --surface X` would
look for `…/.git/modules/.claude/agents/X-dev.md`. `--show-toplevel` is correct in this case. A1's
measured table has rows for plain repo, symlink and worktree but no submodule row.

Fix: discriminate on `--git-dir` vs `--git-common-dir`, which differ **only** in a linked worktree
(measured above: equal in a plain repo and in a submodule, different in `rt/wt`). Use
`--show-toplevel` when they are equal, `dirname(--git-common-dir)` when they differ. Same single
derivation rule A2 argues for, one comparison wider.

## MINOR 2 — C5 does not say where `abandonDecisions` sits relative to the existing `pending_answer` block

`cmdRewind` already discards an undelivered answer and writes a history entry for it
(`src/cli.ts:195-201`). `abandonDecisions` (`src/lib/decisions.ts:38-46`) *also* nulls
`task.pending_answer`, and its per-decision test at `:41`
(`if (d.answer !== null && task.pending_answer !== d.id) continue`) reads `pending_answer`. Call it
**before** the existing block and an answered-but-undelivered decision is abandoned silently, losing
the `"answer to <id> discarded, undelivered"` history entry the current code guarantees; call it
**after** and only genuinely open decisions are abandoned. The spec says only "with a history entry
matching the shape at `src/cli.ts:196-199`". Name the order, and pin it in testing item 11.

## MINOR 3 — Goal 6 says "rewind to a terminal phase"; C5 implements only the task branch

`cmdRewind`'s run branch (`src/cli.ts:209-218`) can put a whole run in `done` while its tasks still
hold open decisions, leaving `openDecisionFor` warnings in `hpipe status` (`src/lib/status.ts:29-34`)
— the same residue #38 complains about, one level up. `hpipe abort` (`src/cli.ts:318-327`) does the
same. #38's reported repair used the task form, so the narrow rule covers the reported case, but the
spec should say the run branch is deliberately out of scope rather than leave Goal 6 broader than C5.

## MINOR 4 — C7 stops at `README.md`; `test/integration/smoke.md` is left stale

The research note names commit `2006802` as the model and lists "`prompts/intake.md`,
`prompts/dispatch.md`, `README.md`, and a hand-run step in `test/integration/smoke.md`" as what that
change updated. C7 covers only `README.md`. After this change `smoke.md` is wrong in at least three
places: `:542-544` (the rewind gotcha, see MAJOR 1), `:252` and `:531` (`hpipe release --task t1`
with no `--run`, which stops resolving once the run is terminal), and `:268`/`:299` (`hpipe decide`
/`hpipe answer` now require a git cwd or `--run`). Also: the README escape-hatch rows at `:99-100`
for `rewind` and `release` are not in C7's list either.

## MINOR 5 — C3 and A11 understate the surface

C3 says "Each command gains `runId` on its input" — but the resolver also needs `repoKey` threaded
through every command input, which only A11 mentions in passing. And A7 states plainly that
`src/actions/claim.ts` will be edited ("gains an `export` so `src/actions/claim.ts` can use it"),
while A11's enumeration of files taken outside the declared `--files`
(`src/cli.ts`, `src/lib/ledger.ts`, `test/cli.test.ts`, `test/cli-commands.test.ts`,
`test/cli-argv.test.ts`, `test/ledger.test.ts` — confirmed against the live run record) lists
`test/decide.test.ts`, `README.md`, `src/lib/worker-prompt.ts` and `prompts/worker-brief.md` but
**not** `src/actions/claim.ts`, nor `test/integration/smoke.md` from MINOR 4. Since A11 exists
precisely to be the honest ledger of that overreach, it should be complete. (The no-overlap claim
against #19's declared set is correct: `src/lib/phases.ts`, `src/supervisor/stall.ts`,
`test/phases.test.ts`, `test/stall.test.ts`, read from `…-v0qh.json`.)

## MINOR 6 — two smaller inaccuracies

- Data-and-control-flow step 2 cites **(A2)** for "Failure to find a git repo is fatal only when
  `--run` was not given". A2 is about one derivation rule versus `task.checkout_path` and makes no
  claim about that; the statement is unlabelled and unjustified anywhere else. It is also the one
  place `dispatch()` must peek at `flag(rest, 'run')` **before** the switch (`src/cli.ts:398-403`),
  which is worth saying explicitly.
- The Testing strategy never mentions that ~28 existing call sites must gain `repoKey`
  (`grep -c` → 8 `cmdTask(ctx()` plus 20 across `cmdBrief`/`cmdDecide`/`cmdAnswer`/`cmdRelease`/
  `cmdDispatchDone`), nor that fixtures seeding `repoKey: 'k'` beside a real `repoRoot`
  (`test/cli-commands.test.ts:30`, `test/cli.test.ts:50`, `test/decide.test.ts:87`) must be made
  self-consistent — a point the research note carried forward explicitly and the spec dropped. It is
  mechanical, but it is the bulk of the diff and belongs in the plan.

---

## Counts

0 BLOCKER, 3 MAJOR, 6 MINOR.

## Not findings (attacked and cleared)

- **A1's cost to `cmdStart`.** Recording the parent repo when `hpipe start` runs inside a worktree is
  strictly better: `repo_root` feeds `worktree create --cwd {{repo_root}}`
  (`src/supervisor/tasks.ts:151`, `test/prompts.test.ts:60-66`), and the parent is what herdr should
  be given. All four live run files already carry main-checkout `repo_key`s, so no run on disk is
  stranded by the change.
- **A7's import direction.** `src/actions/claim.ts` importing `repoContext` from `../cli` is safe:
  `dispatch()` is behind `if (import.meta.main)` (`src/cli.ts:483`), which is false when `claim.ts`
  is the entry module, and there is no cycle.
- **A8.** No `Run`/`Task` field is added by C1–C7; `schema_version` does not move. Correct.
- **A13 and the rejected "newest run wins".** The argument is right and the live ledger proves it:
  `…-qc13` (`done`) sorts ahead of `…-v0qh` (`execute`) purely on filename (`src/lib/ledger.ts:57`).
- **C6.** `run_id` is genuinely absent from `renderWorkerPrompt`'s bag
  (`src/lib/worker-prompt.ts:16-31`), there are exactly the three render sites named, and
  `worker-brief` is rendered from nowhere else (`grep -rn "worker-brief" src/`). The two
  `test/prompts.test.ts` guards are correctly identified.
- **Machine-parsed stdout.** `grep -rn "task_id:" src/ prompts/ test/ bin/` confirms the spec's claim:
  only the two producers, `history` writes, and `toContain` assertions. `prompts/dispatch.md:27` is
  read by an agent, not parsed.

VERDICT: CLEAR
MAJORS: 3
