# Research — issue #21 (with #36 and #38): four commands resolve a run by first match

Established against this worktree at `9e792b5` (branch `fix/21-run-resolution`) and against the live
ledger at `~/.local/state/herdr/plugins/stein.pipeline/runs/`, which still holds every run the three
issues describe. Every claim below is a `file:line` citation or a command whose output is quoted.

Issue #21 was rescoped on 2026-09-18 to be the single shared fix for #21, #36 and #38. This note
covers all three as one defect.

## Installed versions

    $ bun --version   → 1.3.14
    $ node --version  → v24.16.0
    $ herdr --version → herdr 0.9.0
    $ cat version.txt → 1.2.7

Dependencies are dev-only (`package.json:10-12`): `@types/bun@1.4.2`, `typescript@5.9.3` — resolved
versions read from `bun.lock:14` and `bun.lock:20`; `bun x tsc --version` → `Version 5.9.3`. There is
no runtime dependency and no build step. `tsconfig.json` is `strict` with `noUncheckedIndexedAccess`.

Baseline, green before any change:

    $ bun test          → 454 pass, 0 fail, 1072 expect() calls, 34 files
    $ bun run typecheck → tsc --noEmit, no output, exit 0

### The running supervisor cannot see edits made here

    $ herdr plugin list
    - stein.pipeline (Pipeline) enabled [github:victorstein/herdr-plugin-pipeline@9e792b563cf19ba6471c032e9eb8878fcd6e356f]

    $ git rev-parse HEAD
    9e792b563cf19ba6471c032e9eb8878fcd6e356f

The installed plugin is pinned to a GitHub commit that **is** this branch's base, so the CLI driving
this run is byte-identical to the code measured below (`git diff --quiet 9e792b5 HEAD -- src/cli.ts
src/lib/ledger.ts` → no output). Everything here is true of the live binary, and nothing written in
this worktree changes it.

## Which files own the behaviour

All of it is in two files. No supervisor module resolves a run or a task by id.

    $ grep -rn "listRuns(" src/ | grep -v "^src/lib/ledger.ts"

| Site | Command | Filters applied today |
|---|---|---|
| `src/cli.ts:57-61` | `cmdTask` | phase ∈ {intake, dispatch, execute}. **No repo.** |
| `src/cli.ts:161-163` | `cmdBrief` | task id only. **No phase, no repo.** |
| `src/cli.ts:170-173` | `cmdDispatchDone` | phase, when `--run` is absent. **No repo.** |
| `src/cli.ts:228-230` | `cmdRelease` | task id only, then a phase guard on the *task*. **No repo.** |
| `src/cli.ts:247-250` | `cmdDecide` | task id only. **No phase, no repo.** |
| `src/cli.ts:273-276` | `cmdAnswer` | task id only, then a phase guard on the *task* (`:282-284`). |

`src/cli.ts:188`, `:319`, `:331` (`cmdRewind`, `cmdAbort`, `cmdResume`) take an explicit `run_id` and
are not affected. `cmdForget` resolves through `runForWorkspace` (`src/lib/ledger.ts:71-76`), which is
also first-match but is keyed on a globally unique herdr workspace id, not a per-run id.

**The issues name four commands; there are six.** `cmdDispatchDone`'s bare form is the one
`prompts/intake.md` and `prompts/dispatch.md` tell the orchestrator to use, and
`test/cli-commands.test.ts:262-273` pins that fallback as "the path the orchestrator actually takes".
`cmdRelease` is guarded against mutating a live task but not against picking the wrong run's `t1`:
its guard is `!taskRow(task.phase).terminal` (`src/cli.ts:235-237`), so a *terminal* `t1` on a
completed run is exactly what it will happily clear.

Supporting files: `src/lib/ledger.ts` (`listRuns`, `activeRunForRepo`), `src/lib/decisions.ts`
(`openDecision`, `abandonDecisions`), `src/lib/phases.ts` (`runRow().terminal` — **owned by the
sibling task on #19; not to be edited here**).

## The current control flow

1. `dispatch()` builds `ctx` from `HERDR_PLUGIN_STATE_DIR` and `sessionKey()` (`src/cli.ts:391-395`).
   Outside a herdr pane `sessionKey()` returns `'default'` (`src/lib/session.ts:15`).
2. The caller's repo is computed **only for two commands**:

       const needsRepo = command === 'start' || command === 'task'   // src/cli.ts:398

   `repoContext()` (`src/cli.ts:383-389`) shells out to `git rev-parse --show-toplevel` and returns it
   as both `repoKey` and `repoRoot`. It is passed to `cmdStart` (`:410`) and **dropped for `task`**
   (`:418-426`) — `cmdTask`'s input type has no repo field at all (`src/cli.ts:53-56`).
3. `listRuns` reads every `*.json` under `<state>/runs/<session>/` and returns them **sorted by
   filename** (`src/lib/ledger.ts:57`). Run ids are `${repoName}-${YYYYMMDD}-${slug}-${suffix}`
   (`src/lib/ledger.ts:25`), so the sort is by repo name, then date, then title — meaning the
   "first match" is stable, and biased toward the alphabetically-first repo and the **oldest** run.
4. Each command above then takes `.find(...)` over that array.
5. Task ids are minted per run: `t${run.tasks.length + 1}` (`src/cli.ts:100`). Every run with tasks
   therefore has a `t1`. Decision ids are per task the same way (`src/lib/decisions.ts:11`).
6. Completed runs are never deleted. `runsDir` is written by `saveRun` and read by `listRuns`
   (`src/lib/ledger.ts:7`, `:45`, `:51`, `:58`) and by nothing else; every `unlinkSync` in `src/` is
   against the queue, a pidfile or the `hpipe` symlink (`src/lib/queue.ts:48`, `:71`,
   `src/lib/pidfile.ts:36`, `src/startup.ts:95`, `src/lib/install-cli.ts:52`). The population of
   shadowing runs only grows.

## What the live ledger resolves to *today*

Simulating each command's `.find` predicate against the real files (read-only; the ledger was not
modified):

    listRuns order for session `pipeline`
      herdr-plugin-pipeline-20260917-bug-fixing-and-enhancements-qc13.json   [done]      t1=#9,  t2=#15
      herdr-plugin-pipeline-20260917-validate-the-silent-gates-rjms.json     [done]      t1=#10, t2=#13
      herdr-plugin-pipeline-20260918-fix-run-resolution-and-the-last-mile-v0qh.json [execute] t1=#21, t2=#19

    cmdBrief / cmdDecide / cmdAnswer / cmdRelease --task t1 → ...-qc13   (phase done)
    cmdTask                                                 → ...-v0qh   (phase execute)

**This run is live inside that defect.** `t1` of `…-v0qh` is this task. If this worker calls
`hpipe decide --task t1` as its brief instructs, the question is filed onto `…-qc13`'s `t1` —
issue #9, merged in PR #27, worktree torn down — and `enterTaskPhase` moves that finished task to
`blocked-on-decision`. That is #38 reproduced, unchanged, on the current release.

The `personal` session shows the #21 shape as well: three `berean-os-*` runs sort ahead of
`herdr-plugin-pipeline-20260917-…-t5xx` (phase `intake`), and `berean-os-20260917-working-on-open-issues-xilp`
is in `branch-review`, which `cmdTask`'s predicate excludes — but `…-t5xx` only wins because no
berean-os run is currently in intake/dispatch/execute. The filter is doing nothing; the ledger's
current phases are.

## The constraint the fix has to survive: `repo_key` is not what a worker sees

Both #21 and #36 propose filtering by `repo_key`, "already computed in `main()`". That works for the
orchestrator and **breaks for every worker**, because workers run in git worktrees:

    $ pwd
    /Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-21-run-resolution
    $ git rev-parse --show-toplevel
    /Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-21-run-resolution
    $ git rev-parse --path-format=absolute --git-common-dir
    /Volumes/stein/Documents/development/personal/herdr-plugin-pipeline/.git

`repoContext()` uses `--show-toplevel`, so inside a worktree it returns the **worktree path**, which
never equals the run's `repo_key` (`/Volumes/stein/Documents/development/personal/herdr-plugin-pipeline`,
read from the live run file). `hpipe decide` and `hpipe brief` are invoked from worktrees — the brief
itself prints the `hpipe decide` line into the worker's pane (`prompts/worker-brief.md:47-49`) — so a
naive `repo_key === repoContext().repoKey` filter would make `decide` fail for every worker in the
fleet. `dirname` of `--git-common-dir` recovers the main repo root and does equal `repo_key`; that is
the conversion a repo filter needs. `src/actions/claim.ts:12-15` has the same `--show-toplevel`
assumption and the same comment about keeping the two identifications in agreement.

## A repo filter alone does not fix #36 or #38

Every run in the `pipeline` session above shares one `repo_key`. The two runs that shadow this one are
same-repo, and only their **terminal phase** distinguishes them. So of the two proposed filters, the
terminal exclusion is the one carrying the weight for #36/#38, and the repo filter is the one carrying
#21 (two repos, one session). Both are needed; neither is sufficient.

Ambiguity also genuinely remains after both filters: two non-terminal runs in the same repo and
session is possible today (`cmdStart` refuses a second *active* run per repo — `src/cli.ts:30-34`,
`activeRunForRepo` at `src/lib/ledger.ts:64-69` — but `hpipe abort` sets `phase: 'done'` while leaving
`escalated_from` set, and `hpipe resume` puts it back, so a resumed run can coexist with one started
in between). That is the case `--run <run-id>` exists for.

## The guard shape to mirror, and the one that is missing

`cmdAnswer` already refuses a task that is not in the phase the command implies:

    if (task.phase !== 'blocked-on-decision') {
      return fail(`task ${input.task} is not blocked on a decision (phase: ${task.phase})`)
    }                                                              // src/cli.ts:282-284

`cmdDecide` has a sibling guard (`src/cli.ts:259-261`) but it only refuses a task **already** in
`blocked-on-decision` — it does not ask whether the task, or its run, is finished. `enterTaskPhase`
(`src/lib/machine.ts`) is called unconditionally at `src/cli.ts:265`. This asymmetry is exactly what
#38 reports: the corrupting path has no phase guard, the repair path does, so the damage could be
created but not undone by the same class of command.

## `hpipe rewind` and stale decisions (#38's repair path)

`cmdRewind`'s task branch (`src/cli.ts:191-208`) clears `pending_answer` and records the discard, sets
`phase`, `passes`, `delivery_attempts`, `phase_entered_at` and `escalated_from` — and **never touches
`task.decisions`**. So an *open, unanswered* decision survives a rewind, and `openDecisionFor`
(`src/lib/decisions.ts:3-5`) keeps returning it, which is what keeps `hpipe status` printing the
warning (`src/lib/status.ts:29-34`).

The function that closes one out already exists: `abandonDecisions` (`src/lib/decisions.ts:38-46`)
marks every open-or-undelivered decision `answered_by: 'abandoned'` and nulls `pending_answer`. Its
only callers today are the two pane-death paths in the supervisor:

    $ grep -rn "abandonDecisions" src/
    src/supervisor/tick.ts:192, src/supervisor/tick.ts:205

So #38's "give rewind a way to clear a stale decision" needs no new mechanism — it needs
`cmdRewind` to call a function this repo already has, under a rule about when.

## Task-id uniqueness is a schema change

All four run files on disk carry `"schema_version": 2` (`src/lib/ledger.ts:38` mints it; the live
files confirm it). Task ids are stored on each task and referenced from `task.depends_on`
(`src/cli.ts:102`, `detectCycle` in `src/lib/gating.ts`), from `run.history[].task_id`
(`src/cli.ts:197`, `:208`), and from every prompt rendered into a pane (`{{task_id}}` in
`prompts/worker-brief.md:3`, `:47`). Making ids session-unique would rewrite all of those for runs
already saved, and `README.md:104` records that the plugin **refuses** a run from an older schema
rather than migrating it — meaning a bump strands the two live runs in this very session. The
`plugin-dev.md` guide requires a spec to say so explicitly ("A change to `phases.ts` or to
`schema_version` is a change to the format of runs already on disk"). The filter-and-fail-loudly path
needs no schema change at all: no `Run` or `Task` field is added.

## The nearest existing example of this kind of change

**`2006802` — `fix(cli): validate and echo --files at registration (#39)`**, the immediately previous
`cmdTask` fix, is the model to mirror:

- Validation added inside the command, **before** the record is mutated, with a comment giving the
  live-run *why* (`src/cli.ts:63-65`, `:76-80`) — the repo's comment convention, which several
  comments close with `Measured on a live run.`
- Unit coverage in `test/cli-commands.test.ts` (fixture repo with a real `.claude/agents/core-dev.md`,
  `mkTask`/`runWithTasks` helpers, `listRuns` read back to assert nothing was written).
- **A subprocess test through the real argv path**, `test/cli-argv.test.ts` — `dispatch` and `flag`
  are module-private, so this is the only layer that proves the wiring. It pins
  `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_ROOT`, `HERDR_SESSION` and `HERDR_SOCKET_PATH` in the child
  env precisely so a fixture cannot land in the live ledger (`test/cli-argv.test.ts:13-35`). A fix
  that adds run resolution to the argv layer (`--run`, a repo lookup) has the same problem and needs
  the same test.
- Docs updated in the same PR: `prompts/intake.md`, `prompts/dispatch.md`, `README.md`, and a
  hand-run step in `test/integration/smoke.md`.

For the resolver itself, the nearest in-repo pattern is `activeRunForRepo`
(`src/lib/ledger.ts:64-69`) — repo-keyed, terminal-excluding, already used by `cmdStart`
(`src/cli.ts:30`) and `src/actions/claim.ts:30`. It returns the first match rather than failing on
ambiguity, so it is the shape to extend, not to copy verbatim.

## What a fix will disturb in the test suite

`cmdTask`'s input type has no repo field, and every existing caller relies on that:
`test/cli-commands.test.ts:142`, `:163`, `:183`, `:212`, `:281`, `:296`, `:307`, `:324` and
`test/cli.test.ts:55`, `:56`, `:72`, `:85`, `:86`, `:100`, `:112`, `:169`, `:193`, `:213`, `:214`, `:232`.
Note that `test/cli.test.ts` seeds runs with `repoKey: 'k'` while `repoRoot` is a real temp dir
(`test/cli.test.ts:50`), and `test/cli-commands.test.ts:30` uses `repoKey: 'k', repoRoot: '/r'` — so
any filter keyed on repo will need those fixtures made self-consistent. `test/decide.test.ts:87` seeds
`repoKey: 'k'` the same way.

## Carried into the spec

1. Whether the resolver keys on `repo_key` (needing the `--git-common-dir` conversion above) or on
   `task.checkout_path`, which for this task is byte-equal to the worker's cwd
   (`/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-21-run-resolution`, read from the live
   run file) and is already recorded per task.
2. Whether the terminal test is `runRow(run.phase).terminal` — `src/lib/phases.ts` is the sibling's
   file, so the fix must *read* that table, not change it.
3. Whether `cmdDispatchDone` and `cmdRelease` join the shared resolver. They have the same defect and
   the issue's own wording ("stop the next command inheriting the same defect") points at yes.
4. Whether `hpipe rewind` calls `abandonDecisions` when the target phase is terminal, and whether that
   is in scope for this PR or is a fourth issue.
