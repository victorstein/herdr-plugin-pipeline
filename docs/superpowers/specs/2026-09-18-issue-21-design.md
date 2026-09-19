# One run resolver for every command that takes a task id — design (#21, #36, #38)

Pass 0. Written against this worktree at `c382008` (branch `fix/21-run-resolution`), building on
`docs/superpowers/research/2026-09-18-issue-21-research.md`. Every claim about current behaviour
carries a `file:line` or the command that produced it. No review exists for this issue yet
(`ls docs/superpowers/reviews/ | grep 21` → only `issue-10-pr-review-quality-0.md`).

**Modelled on** `activeRunForRepo` (`src/lib/ledger.ts:64-69`) for the resolver — repo-keyed,
terminal-excluding, already the shape `cmdStart` uses; `cmdAnswer`'s phase guard
(`src/cli.ts:282-284`) for the refusals; `cmdStart`'s failure text (`src/cli.ts:31-34`) for an error
that names the way out; the `--files` validation block (`src/cli.ts:63-94`, commit `2006802`) for
where a check sits inside `cmdTask`; `test/ledger.test.ts:33-44` for the resolver's unit tests; and
`test/cli-argv.test.ts:13-42` for the subprocess proof. No new pattern is introduced.

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
4. `--run <run-id>` selects explicitly, for the case where ambiguity is legitimate.
5. Nothing can move a task in a finished run into a live phase — the guard `cmdAnswer` already has
   (`src/cli.ts:282-284`), extended to the command that lacked it.
6. `hpipe rewind` to a terminal phase clears the stale decision it currently leaves behind, removing
   #38's three-command-per-task repair.
7. The brief names the run it was rendered from, so a misroute is visible in the pane.

## Non-goals

- **No session-unique task ids.** All four runs on disk carry `"schema_version": 2`
  (`src/lib/ledger.ts:38`). Task ids are referenced from `task.depends_on` (`src/cli.ts:102`),
  `run.history[].task_id` (`src/cli.ts:197`, `:208`) and every rendered prompt
  (`prompts/worker-brief.md:3`, `:47`). `README.md:104` records that a run from an older schema is
  **refused, not migrated** — so a bump strands the two live runs in this very session, including
  this one. The filter path needs no schema change: no `Run` or `Task` field is added, `phases.ts` is
  not touched, `schema_version` does not move (A8).
- **No change to `src/lib/phases.ts`, `src/supervisor/stall.ts`, `test/phases.test.ts` or
  `test/stall.test.ts`.** Those are the sibling task's declared files (#19, read from the live run
  record). This design *reads* `runRow().terminal` and `taskRow().terminal`; it never edits the table.
- **No change to `activeRunForRepo`.** `cmdStart` (`src/cli.ts:30`) and `src/actions/claim.ts:30` want
  first-match-any-active semantics: any active run for the repo blocks a second `hpipe start`, so
  ambiguity there is not an error (A9).
- **No repair of ledgers already damaged by #38.** `…-qc13`'s `t1`/`t2` were repaired by hand on
  2026-09-17. This change prevents the next one; it does not migrate the last one.
- **No pruning or archiving of completed runs.** That would also remove the shadowing, and it is a
  larger change to the ledger's lifecycle that no open issue owns.
- **No `--run` on the rendered `hpipe answer` line in `prompts/decision.md:28-30`.** After C3 the
  orchestrator's bare call resolves inside its own repo and fails loudly on ambiguity, which is the
  contract this change establishes; hard-coding the flag into a prompt is redundancy to maintain
  (A12).
- **No change to `hpipe status`, `abort`, `resume`, `forget` or `rewind`'s run lookup.** `rewind`,
  `abort` and `resume` already take an explicit `run_id` (`src/cli.ts:188`, `:319`, `:331`);
  `forget` keys on a globally unique herdr workspace id (`src/lib/ledger.ts:71-76`). Only `rewind`
  changes, and only in what it does to `task.decisions` (C5).

## Architecture

Seven components. C1 is in `src/lib/ledger.ts`; C2–C5 in `src/cli.ts`; C6 in
`src/lib/worker-prompt.ts` + `prompts/worker-brief.md`; C7 in `README.md`.

### C1 (load-bearing) — `resolveRun` in `src/lib/ledger.ts`

Modelled on `activeRunForRepo` (`src/lib/ledger.ts:64-69`), which already reads `listRuns`, filters
on `repo_key`, and tests `runRow(r.phase).terminal`. `ledger.ts` already imports `runRow`
(`src/lib/ledger.ts:3`), so the terminal test needs no new dependency.

```ts
export interface RunQuery {
  runId: string | null
  repoKey: string | null
  phases: readonly RunPhase[] | null
  taskId: string | null
}

export type RunResolution =
  | { ok: true; run: Run }
  | { ok: false; reason: 'no-such-run' }
  | { ok: false; reason: 'none'; excluded: Run[] }
  | { ok: false; reason: 'ambiguous'; candidates: Run[] }

export async function resolveRun(
  stateDir: string, session: SessionKey, query: RunQuery,
): Promise<RunResolution>
```

Semantics, in order:

1. **`runId` set** → exact `run_id` match, and **no other filter applies**. An explicit id is the
   operator overriding inference; re-filtering it would make the escape hatch unusable in exactly the
   situations it exists for. `no-such-run` when absent.
2. Otherwise, over `listRuns`: `repo_key === repoKey` (when non-null) → `!runRow(r.phase).terminal`
   → `phases.includes(r.phase)` (when non-null) → `tasks.some(t => t.task_id === taskId)` (when
   non-null).
3. Exactly one → `{ ok: true }`. Zero → `{ ok: false, reason: 'none', excluded }`. Two or more →
   `{ ok: false, reason: 'ambiguous', candidates }`.

`excluded` is the diagnostic the issues ask for: the runs that matched **repo and task id** but
failed the terminal or phase test. That is what turns "no such task: t1" into "`t1` exists in
`…-qc13`, which is `done`" — the sentence whose absence made #36 and #38 invisible until a worker
read a wrong issue number.

`resolveRun` composes no messages. `CmdResult` (`src/cli.ts:21-24`) is the established error channel
and the caller knows which flags were typed, so the text is built in `src/cli.ts` (A5).

### C2 — `repoContext` derives the repo the way a worktree sees it

Today (`src/cli.ts:383-389`):

```ts
const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], …)
```

Becomes `git rev-parse --path-format=absolute --git-common-dir`, with `dirname` applied. Measured, in
the scratchpad and in this worktree:

| cwd | `--show-toplevel` | `dirname(--git-common-dir)` |
|---|---|---|
| plain repo | `…/rt/main` | `…/rt/main` |
| repo via a symlink | `…/rt/main` | `…/rt/main` |
| a worktree of it | `…/rt/wt` | `…/rt/main` |
| **this worker's cwd** | `…/.herdr/worktrees/…/fix-21-run-resolution` | `/Volumes/stein/Documents/development/personal/herdr-plugin-pipeline` |

That last value is byte-equal to the `repo_key` stored in the live run file. One derivation serves
both callers: identical to today's in a main checkout, correct in a worktree. `--path-format` is
required — the bare `--git-common-dir` returns the relative `.git` in a plain repo (measured above);
it needs git ≥ 2.31, and the host runs 2.54.0 (A6).

`repoContext` gains an `export` so `src/actions/claim.ts` can use it in place of its own inline spawn
(`src/actions/claim.ts:12-20`), whose comment already states the requirement this change enforces:
"Identify the repo the same way `hpipe start` does … so the two agree." Importing from `../cli` is
safe and precedented — `dispatch()` is guarded by `if (import.meta.main)` (`src/cli.ts:483`) and
`test/cli-commands.test.ts:6` already imports the module (A7).

`needsRepo` (`src/cli.ts:398`) widens from `start|task` to every resolving command.

### C3 — the six call sites

Each command gains `runId` on its input and passes a `RunQuery`. No command keeps a `.find` of its
own.

| Command | `phases` | `taskId` | On a terminal run named by `--run` |
|---|---|---|---|
| `cmdTask` | intake, dispatch, execute | — | **refuse** |
| `cmdDispatchDone` | intake, dispatch, execute | — | **refuse** |
| `cmdDecide` | null (any live) | yes | **refuse** |
| `cmdBrief` | null | yes | allow — read-only |
| `cmdAnswer` | null | yes | allow — it is the undo direction |
| `cmdRelease` | null | yes | allow — it is the undo direction |

The split is A3. `cmdAnswer` allowing it is not a loose end: it is precisely how #38's damage was
repaired (`hpipe rewind` into `blocked-on-decision`, `hpipe answer`, `hpipe rewind` back to `done`),
and a ledger damaged before this change still needs that path to work.

`cmdTask`'s `--surface` check reads `run.repo_root` (`src/cli.ts:71`). Once the run is guaranteed to
be the caller's, #21's reported symptom — this repo's surface validated against berean-os's tree —
disappears as a consequence of C1 rather than as a special case. Nothing about the check changes.

### C4 — refuse to move a task in a finished run into a live phase

`cmdDecide` today checks only that the task is not *already* blocked (`src/cli.ts:259-261`) and then
calls `enterTaskPhase` unconditionally (`src/cli.ts:263-266`), which rewrites `task.phase` and
`phase_entered_at` (`src/lib/machine.ts:90-96`). Two guards are added before it, both mirroring the
wording of `src/cli.ts:282-284`:

- `runRow(run.phase).terminal` → `run <id> is finished (phase: done) — a task in it cannot be
  blocked on a decision`
- `taskRow(task.phase).terminal` → `task t1 is finished (phase: done) …`

The run-level guard is what #38 asks for; the task-level guard is what catches the case where a live
run holds a task that has already reached `done`, which the run-level test cannot see. Note the
asymmetry this preserves: `escalated` is **not** terminal for either a run (`src/lib/phases.ts:70-71`)
or a task (`:130-131`), so an escalated task can still surface a decision — which is the state a
human is most likely to be untangling (A4).

`cmdRelease`'s existing guard (`src/cli.ts:235-237`) is the inverse — it *requires* a terminal or
escalated task — and is left exactly as it is.

### C5 — `hpipe rewind` to a terminal phase abandons the task's open decisions

`cmdRewind`'s task branch (`src/cli.ts:191-208`) clears `pending_answer` with a history entry
(`:195-201`) and never touches `task.decisions`, so an unanswered decision survives and
`openDecisionFor` (`src/lib/decisions.ts:3-5`) keeps `hpipe status` printing the warning
(`src/lib/status.ts:29-34`). That is what made #38's repair three commands per task.

`abandonDecisions` (`src/lib/decisions.ts:38-46`) already does exactly this job and is already
exported; `src/cli.ts:4` already imports from that module. The rule: **when the rewind target is a
terminal task phase, abandon the task's open and undelivered decisions**, with a history entry
matching the shape at `src/cli.ts:196-199`. Only when terminal — rewinding *into*
`blocked-on-decision` is how the answer path is re-armed, so abandoning on every rewind would break
the repair it is meant to shorten (A10). `src/lib/decisions.ts` is read and called, not edited.

### C6 (most droppable) — the brief names its run

#36's last direction: "Have the brief name the run it came from, so a mismatch is visible in the pane
rather than only in a `Closes #n` line." `renderWorkerPrompt` already receives the whole `Run`
(`src/lib/worker-prompt.ts:10-12`) and builds one var bag for both `worker-brief` and `research`
(`:16-34`), so `run_id: run.run_id` is a one-line addition that reaches all three render sites —
`src/cli.ts:151`, `src/cli.ts:166`, `src/supervisor/tasks.ts:152` — with no caller change. A
`{{run_id}}` line is added to `prompts/worker-brief.md` beside the task id at `:3`.

Two guards constrain the prose: `test/prompts.test.ts:68-76` fails any prompt containing a literal
`hpipe` outside `{{hpipe}}`, and `test/prompts.test.ts:36-43` pins `{{agent_file}}` and
`Closes #{{issue}}`. `render()` throws on an unresolved placeholder at delivery time in front of an
agent (`src/lib/render.ts:11`), which is why the var is added to the bag in the same edit.

Naming the run also makes the `--run` escape actionable for a worker: if ambiguity ever does fail its
`hpipe decide`, the id it needs is in the brief already in its pane.

### C7 — documentation

`README.md`: `--run <run-id>` on the registration and answer forms (`:79-80`, `:89`), and a row in the
escape-hatch table (`:99-104`) for "two live runs in one session". The README is the only user-facing
document that lists these commands; `prompts/intake.md` and `prompts/dispatch.md` describe what
`hpipe task` *prints*, which C1–C5 do not change on the success path.

## Data and control flow

Before (research §Current control flow), with the new steps marked:

1. `dispatch()` builds `ctx` from `HERDR_PLUGIN_STATE_DIR` and `sessionKey()` (`src/cli.ts:391-395`).
   Unchanged. Outside a pane the session is still `default` (`src/lib/session.ts:15`).
2. **C2: `repoContext()` now derives the shared repo root, and runs for six commands, not two**
   (`src/cli.ts:398`). Failure to find a git repo is fatal only when `--run` was not given (A2).
3. **C3: the command calls `resolveRun` with its `RunQuery`** instead of `listRuns(...).find(...)`.
4. **C1: one run, or a typed failure.** `ok` → the run. `none` → message naming repo, session, phases
   and task id, plus the `excluded` runs and their phases. `ambiguous` → the candidate ids and
   `--run`. `no-such-run` → the id as typed.
5. **C4: the mutating commands test `runRow(run.phase).terminal` and `taskRow(task.phase).terminal`**
   before `enterTaskPhase` (`src/cli.ts:265`).
6. Everything downstream is unchanged: the `--issue`/`--branch`/`--surface`/`--files` validation
   (`src/cli.ts:63-94`), the task literal (`:99-116`), `detectCycle` (`:126`), `gateStatus` (`:141`),
   `saveRun`, and the returned brief.
7. **C5: `cmdRewind` calls `abandonDecisions` when the target task phase is terminal.**

Nothing machine-parses these commands' stdout: `grep -rn "task_id:" src/ prompts/ test/ bin/` finds
only the two producers in `src/cli.ts`, `history` writes, and `toContain` assertions. The supervisor
never calls a `cmd*` function — it drives `src/supervisor/tick.ts` over `listRuns` directly
(`src/supervisor/main.ts:115`), which this change does not touch.

## Error handling

Every failure is a `fail()` (`src/cli.ts:24`) — exit 1, nothing written, `saveRun` never reached.

| Situation | Today | After |
|---|---|---|
| `hpipe task` in repo A, live run in repo B first | registers into B's run | `no live run for <repoA> in session <s>` + `hpipe start` as the way out |
| `hpipe brief --task t1`, a `done` run sorts first | renders the wrong brief | resolves the live run; the `done` one is named under "excluded" only if nothing matched |
| `hpipe decide --task t1`, a `done` run sorts first | files onto it, task → `blocked-on-decision` | resolves the live run |
| `--run <terminal id>` on `decide`/`task`/`dispatch --done` | n/a | refused: `run <id> is finished (phase: done)` |
| two live runs in one repo+session | first wins, silently | `more than one run matches … → --run <id>` |
| `--run` names nothing | n/a (only `dispatch` had it) | `no such run: <id>` — the existing wording at `src/cli.ts:176` |
| task id exists only in a terminal run | acts on it | `no live run … holds t1` + `t1 is in <id> (done)` + `hpipe rewind` as the documented way in |
| not in a git repo, no `--run` | resolves across all repos | `hpipe: not inside a git repository` — the existing wording at `src/cli.ts:401` |
| `hpipe rewind <run> done --task t1` with an open decision | decision survives, status nags | abandoned, one history entry |

The "excluded" clause is the load-bearing half. #36's brief was wrong for **hours** because nothing
anywhere said a second `t1` existed; a message that names the shadow converts a silent misroute into
a sentence the operator reads before the worker starts.

## Assumptions

Each is a behavioural choice, stated so the review can attack it.

**A1 — The caller's repo is `dirname(git rev-parse --path-format=absolute --git-common-dir)`, not
`--show-toplevel`.** Verified against this worktree: it reproduces the stored `repo_key` exactly,
where `--show-toplevel` returns the worktree path. The cost is that `hpipe start` run from *inside* a
worktree would now record the parent repo as `repo_key`/`repo_root` rather than the worktree — which
is a behaviour change to `cmdStart` that this issue did not ask for. I judge it strictly better
(`repo_root` is what `worktree create --cwd {{repo_root}}` is rendered from,
`test/prompts.test.ts:60-66`), but it is a change nobody requested. **The most attackable decision
here**, and the alternative — two derivations, one per caller kind — is rejected under A2.

**A2 — One derivation for every command, not "repo for the orchestrator, `checkout_path` for the
worker".** `task.checkout_path` (`src/lib/types.ts:77-78`) is byte-equal to a worker's cwd and would
also work (research §Carried into the spec). Rejected because it is a second resolution rule that
applies to some callers and not others, it is null until the worktree is bound, and it would leave
`hpipe decide` behaving differently depending on who typed it. One rule is testable; two are a
matrix.

**A3 — `--run` on a terminal run is refused for `task`/`decide`/`dispatch --done` and allowed for
`brief`/`answer`/`release`.** The line is "does this move a task forward into a live phase". #38's
damage was created by a forward move and undone by `answer`; refusing both would leave an already
damaged ledger unrepairable by anything but `rewind`. Attack surface: it is a six-way table, not a
single rule, and a reviewer may prefer "refuse all mutation on a terminal run, `rewind` is the only
door" — simpler, at the cost of breaking the documented repair path (`README.md:99`).

**A4 — `escalated` stays resolvable.** It is non-terminal for both a run (`src/lib/phases.ts:70-71`)
and a task (`:130-131`), and `cmdRelease` already special-cases it as "stopped moving but not
terminal" (`src/cli.ts:234-237`). An escalated task is the one a human is most likely to be
untangling, so excluding it would block the recovery commands.

**A5 — `resolveRun` returns a typed failure; `src/cli.ts` writes the sentence.** `ledger.ts` composes
no user-facing text today. The alternative — returning a formatted string — would put message copy in
a storage module and make the resolver untestable without string matching.

**A6 — `--path-format=absolute` is acceptable to require.** git 2.31+ (March 2021); the host runs
2.54.0. The fallback (`--git-common-dir` + `path.resolve` against cwd) is one more branch to test for
a git older than the `worktree` workflow this plugin is built on.

**A7 — `src/actions/claim.ts` imports the exported `repoContext` rather than keeping its own spawn.**
Its comment (`:12-15`) states the two identifications must agree; leaving it on `--show-toplevel`
makes that true only by the circumstance that the orchestrator pane sits in the main checkout.
`src/actions/claim.ts` is **not** in this task's declared `--files` (A11).

**A8 — No schema change, so a run written by this CLI is readable by the pinned supervisor.** No
`Run` or `Task` field is added or removed; `schema_version` stays 2. The plugin-dev guide requires
this to be said out loud, and here the answer is "nothing moves".

**A9 — `activeRunForRepo` is left alone rather than reimplemented on `resolveRun`.** `cmdStart` wants
"any active run blocks" (`src/cli.ts:30-34`); ambiguity is not an error there. Folding it in would
make `hpipe start` fail where it should refuse.

**A10 — `rewind` abandons decisions only when the target phase is terminal.** The alternative —
abandon on every rewind except into `blocked-on-decision` — is closer to "a rewind invalidates the
question", but it would silently discard an open decision on a rewind to `plan`, where the question
may still be exactly the one that needs answering. Narrow is reversible; broad is not.

**A11 — Four files this change must touch are in no task's declared `--files`, and I am taking them
rather than surfacing a decision.** My declared set, read from the live run record, is `src/cli.ts`,
`src/lib/ledger.ts`, `test/cli.test.ts`, `test/cli-commands.test.ts`, `test/cli-argv.test.ts`,
`test/ledger.test.ts`. Beyond it this design needs `test/decide.test.ts` (its `cmdDecide`/`cmdAnswer`
calls stop compiling the moment the input type gains `runId`/`repoKey` — `test/decide.test.ts:97-119`
and its `runWithTask` at `:86-91`), `README.md` (C7), and `src/lib/worker-prompt.ts` +
`prompts/worker-brief.md` (C6). The sibling task #19 declares `src/lib/phases.ts`,
`src/supervisor/stall.ts`, `test/phases.test.ts`, `test/stall.test.ts` — **no overlap**, so there is
no race with anyone; the gap is that the declaration was written before the design existed. Also
relevant: `hpipe decide` from this pane currently files onto a completed run (research §What the live
ledger resolves to today), so surfacing this would exercise the defect under repair. It is recorded
here instead, and will be named in the PR body.

**A12 — The rendered `hpipe answer` line in `prompts/decision.md:28-30` does not gain `--run`.** The
orchestrator's pane sits in the repo whose run it drives, so C3 resolves it; if two live runs ever
share that repo the command fails loudly and names the ids. Hard-coding the flag would make the
prompt carry state the resolver already derives, and the same argument would then apply to every
rendered command.

**A13 — Ambiguity is a hard failure, not a preference order.** "Newest run wins" would resolve every
case in this session correctly and never bother anyone. Rejected: it is the same class of silent
choice as "first match wins", differing only in being right more often — and #36 is the proof that a
rule which is usually right is indistinguishable from a rule that is wrong until a worker has spent
hours on the wrong issue.

## Testing strategy

TDD throughout: failing test, run it, minimum code, run it again. Baseline to hold —
`bun test` → **454 pass, 0 fail, 1072 expect() calls, 34 files**; `bun run typecheck` → clean. Both
measured at `9e792b5` (research §Installed versions). CI here is a PR-title lint only (#35), so both
are run locally and the output quoted in the PR body.

**Resolver units, `test/ledger.test.ts`** — modelled on `test/ledger.test.ts:33-44`, which seeds runs
with `newRun` and asserts on one returned value:

1. picks the live run when a terminal run sorts first (the #36/#38 shape, same `repo_key`);
2. picks this repo's run when another repo's sorts first (the #21 shape);
3. `ambiguous` with both ids when two live runs share repo and session;
4. `none` with the terminal run in `excluded` when the only `t1` is in a `done` run;
5. `runId` returns a terminal run unfiltered, and `no-such-run` for an unknown id;
6. `phases` narrows further (a `branch-review` run is not a `cmdTask` candidate).

**Command level, `test/cli-commands.test.ts`** — modelled on its own `release refuses a task that is
still in flight` (`:108-118`), which asserts `ok === false`, the message, and that the ledger is
unchanged:

7. `cmdDecide` refuses a task in a terminal run and **writes nothing** — `decisions` still empty,
   `phase` still `done`. This is the #38 regression test, and the "writes nothing" half is what
   proves the guard sits before `enterTaskPhase`.
8. `cmdBrief` renders the live run's brief when a completed run holds the same task id — #36's exact
   reproduction, asserting on the issue number in the text.
9. `cmdTask` registers into this repo's run with another repo's run present — #21's reproduction.
10. each of the six reports ambiguity with both run ids and the string `--run`.
11. `cmdRewind` to `done` abandons an open decision (`openDecisionFor` → null) and records history;
    rewinding to `plan` leaves it open. A10's two halves.
12. `cmdAnswer` still works on a terminal run named by `--run` — A3's repair path, pinned.

**Through the real argv path, `test/cli-argv.test.ts`** — the layer this bug lived in. `dispatch`,
`flag` and `repoContext` are reached only as a subprocess; `test/cli-argv.test.ts:13-35` already
builds a real git repo and pins `HERDR_PLUGIN_STATE_DIR`, `HERDR_PLUGIN_ROOT`, `HERDR_SESSION` and
`HERDR_SOCKET_PATH` so a fixture cannot land in the live ledger the supervisor is driving. Two
additions, both needing a real worktree of the fixture repo. That needs **no change to
`test/helpers/git-worktree.ts`**: the file already exports a raw `git(args, cwd)` runner
(`test/helpers/git-worktree.ts:7-10`) which `test/cli-argv.test.ts:22` already uses, so the worktree
is one more `git(['worktree', 'add', …], repo)` call inside the test's own `fixture()`. (Its
`repoWithWorktree` at `:24-39` is not reusable here — it returns only the worktree path and seeds no
agent file at a caller-chosen surface.)

13. `hpipe task` run **from inside a `git worktree`** of the fixture repo resolves the run whose
    `repo_key` is the parent repo — the C2 proof, and the one assertion no unit test can make;
14. `hpipe decide --task t1` from a second fixture repo does not reach the first repo's run.

`.claude/agents/plugin-dev.md` records that DI-faked unit tests "have passed clean over real defects
twice", which is why 13–14 are mandatory rather than optional.

**Live verification.** This change touches none of startup, gating, delivery or pane I/O, so the
plugin-dev guide's live-session requirement is not triggered. It is still verifiable against real
data without writing to the ledger: copy `~/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/`
into a scratch state dir and run the built CLI against the copy with `HERDR_PLUGIN_STATE_DIR` pinned.
Before the change `--task t1` resolves `…-qc13` (`done`); after it, `…-v0qh` (`execute`). The live
directory is never the target — the pinned env is the whole safety argument, the same one
`test/cli-argv.test.ts:13-19` makes.

**Regression guards already present that must stay green:** `test/cli-commands.test.ts:262-273`
(bare `dispatch --done` finds the active run — the path both prompts take),
`test/cli-commands.test.ts:304-319` (`brief` mutates nothing), `test/cli.test.ts:37-46` (`start`
refuses a second run for the same repo), `test/prompts.test.ts:36-43` and `:68-76` (C6's prose).

## Rejected alternatives

**Prune or archive completed runs.** Removes the shadowing at its root and nothing else needs to
change. Rejected: it destroys the record that `hpipe status` and every post-mortem read — the
2026-09-16 berean-os ledger is still on disk and is the evidence base for this entire batch — and it
fixes #36/#38 while leaving #21 (two live repos) untouched.

**Session-unique task ids.** The issues' own third direction, and the only fix that removes the
ambiguity rather than filtering it. Rejected under A8: it is a schema change against a ledger the
plugin refuses rather than migrates (`README.md:104`), it would strand this very run, and it leaves
#21 unfixed — a `t1` unique to its run still resolves into the wrong repo without a repo filter.

**Resolve by `process.cwd()` prefix-matching `repo_root` or `checkout_path`.** No git shell-out at
all. Rejected: prefix matching on paths is wrong at directory boundaries (`…/foo-2` prefix-matches
`…/foo`) and would need path-segment-aware comparison to be correct, which is a new utility where
`git rev-parse` is an existing, already-trusted one (`src/cli.ts:383-389`, `src/actions/claim.ts:14`).

**Newest run wins.** Rejected under A13.

**Validate the brief against the task it was requested for, downstream.** #36 observes that "nothing
in the pipeline compares a brief against the task it was requested for". A checksum or an assertion
at delivery would catch a misroute after it happened. Rejected as the primary fix — it detects what
C1 makes impossible — but C6 is its cheap half: the run id is in the brief, so a human reading the
pane sees the mismatch.

**Leave `cmdDispatchDone` and `cmdRelease` alone, fix only the four commands the issues name.**
Rejected: both resolve the same way, `cmdDispatchDone`'s bare form is the one both prompts instruct
(`test/cli-commands.test.ts:262-273`), and #38's own direction is to stop "the next command
inheriting the same defect".
