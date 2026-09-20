# Adversarial review — issue #26 design, pass 1

Reviewed `docs/superpowers/specs/2026-09-19-issue-26-design.md` against `gh issue view 26`, the
research note at `docs/superpowers/research/2026-09-19-issue-26-research.md`, the pass-0 review at
`docs/superpowers/reviews/issue-26-spec-review-0.md`, and the tree at `6ceb0df`. Baseline
re-measured here, not taken from the spec:

    $ bun test          → 503 pass, 0 fail, 1265 expect() calls, 34 files, 9.06s
    $ bun run typecheck → tsc --noEmit, exit 0
    $ herdr plugin list → stein.pipeline … @be181757beca96069b7f209163fb7538c0e6382f

## The pass-0 claim, checked finding by finding

The spec's *"All ten hold and all ten are applied"* is **true**, and the escalation of MINOR 2 is
genuine rather than decorative. Checked individually:

- **BLOCKER 1** — the contradiction is gone and C4 has moved to `cmdRewind` as a third call site.
  `src/supervisor/tasks.ts:171-173` does read `if (task.phase === cameFrom) continue`, so the pass-0
  evidence is right and the spec now cites the arm that matches the code.
- **MAJOR 1** — C2 states the lazy init, the error table has its own row, A11 is amended. (A second
  defect survives in the same block: MINOR 1 below.)
- **MAJOR 2** — the guard is `signal === 'verdict'` at all three sites, the error-table row is
  replaced, and the test list names `ci` explicitly. `src/lib/phases.ts:122-124` does give `ci` no
  `artifact`, and `src/cli.ts:225-230` does fill all three slots, so `null` really only comes from
  `test/deliver.test.ts:21`. Correctly accepted.
- **MAJOR 3** — settled as A12 plus two reasoned rejections, which is what pass 0 asked for
  (*"pick one and record it as an assumption"*). Not re-opened here.
- **MINOR 1** — the replacement rationale is true, and truer than the spec claims: `src/cli.ts`
  aside, nothing between `src/supervisor/main.ts:184` and `:215` assigns `run.phase`
  (`src/supervisor/stall.ts:371` is the only other `enterRunPhase` caller and it runs at `:266+`).
- **MINOR 2** — the escalation is correct. Traced: `src/lib/machine.ts:117-118` returns before
  `bumpCounter`, so a `CLEAR` at `passes 0` leaves `spent = 0`, the `if (spent > 0)` guard does not
  fire, and the next entry resolves to `-0` with `-1` already on disk. The seed really is a
  lower-bound heuristic and C4 really is what closes it.
- **MINOR 3** — `src/lib/config.ts:26` is `2`; the testing strategy now says `0, 1`.
- **MINOR 4** — in C5. `src/supervisor/deliver.ts:91-94` is the comment, `:180` the conclusion,
  `test/deliver.test.ts:287-295` the pin. All three citations are accurate.
- **MINOR 5** — all three named slips are fixed (`machine.ts:45`/`:90` ordering at spec `:8-10`;
  `test/deliver.test.ts:14-25`/`:27-31`; `src/cli.ts:216-233`). A fourth of the same kind survives —
  MINOR 5 below.
- **MINOR 6** — `test/deliver.test.ts:1-10` does not import `cmdRewind`; the red test has moved to
  `test/cli-commands.test.ts` and is a genuine red.

**What else holds.** The layering claim is exact: `grep -rn "supervisor/" src/ | grep -v
"^src/supervisor/"` returns nothing, so `src/cli.ts` genuinely cannot reach `src/supervisor/` and a
new `src/lib/` module really is forced. `src/lib/gating.ts` really is imported by both `src/cli.ts:5`
and `src/supervisor/tasks.ts:4`. `grep -rn "\.phase = " src/` returns exactly the six sites C2 names.
`grep -l "passes: {}" test/*.ts | wc -l` returns 12. All four tests in A11 stay green as amended — I
traced each: `test/deliver.test.ts:148-154` (`max(-1,1)=1`), `:227-232` (`max(-1,1)=1`),
`test/cli.test.ts:117-129` (`newRun()`, so A2's init), `test/cli-commands.test.ts:228-239`
(rewind to `spec`, guard returns `null`, seed no longer throws). The C3 arithmetic is sound on every
sequence I could construct on a record that carries `phase_entries`, including
escalate-then-rewind-to-`spec` where `??=` is what stops the numbering gapping. And `prompts/`,
`README.md:100`, `prompts/escalate.md:17` and `prompts/stall-escalate.md:12-14` are all as cited.

The findings below are about a phase re-entry the design never traces, and about the interface of the
module it introduces.

---

## BLOCKER 1 — C1 bumps on re-entries that are *resumes*, moving the watched verdict path away from the one the agent is holding, with no prompt re-rendered

**Claim.** C1: `bumpEntries` is called from `enterRunPhase` (`src/lib/machine.ts:45-51`) and
`enterTaskPhase` (`:90-96`) — *"the same two functions that already stamp `phase_entered_at`, and the
only place the state machine changes a phase."* C2: *"All four [direct `.phase =` sites] call
`bumpEntries`"*, the table listing `src/cli.ts:511` as *"`cmdResume` (→ `escalated_from`, which can be
`branch-review`)"*. A6: *"every direct `.phase =` assignment bumps"*, justified only for `cmdAbort`
(*"`done` carries no verdict, so the extra key is inert"*).

**Problem.** `enterTaskPhase` is not only the machine's — it has ten callers, and one of them is a
*resume*, not a new pass. The design's ordinal moves on re-entry, so a resume silently moves the file
the supervisor watches while the agent keeps the path it was given. Nothing re-renders a prompt on
either path, so nothing corrects it. Two reachable instances:

**(a) A decision answered on a review row.** `src/supervisor/tasks.ts:341`:

    enterTaskPhase(run, task, resumeTo, `decision ${decision.id} answered`)

where `resumeTo = task.decision_from` (`:320`), and `decision_from` is whatever phase the worker was
in when it called `hpipe decide` (`src/cli.ts:429`: `task.decision_from = task.phase`). `cmdDecide`
refuses only a terminal phase and a second open decision (`src/cli.ts:418-427`) — the four review
rows are allowed, and `prompts/worker-brief.md:42-58` is the standing, phase-agnostic instruction
that produces them, ending *"The answer comes back to this pane and you resume where you stopped."*

Trace a task in `spec-review`, entry 1, post-change record (`phase_entries['spec-review'] = 1`,
`passes` empty). It is rendered `…-spec-review-0.md` (`n = max(1-1, 0) = 0`). The worker calls
`hpipe decide`; `enterTaskPhase → blocked-on-decision`. The orchestrator answers;
`deliverPendingAnswers` sends `prompts/answer.md` — which carries `{{question}}`, `{{answer}}`,
`{{answered_by}}`, `{{phase}}` and **no `{{verdict_path}}`** — and then re-enters `spec-review`, so
`phase_entries['spec-review']` becomes 2 and `n = max(2-1, 0) = 1`. The supervisor's `verdictFor`
(`src/supervisor/main.ts:193-198`) now stats `…-spec-review-1.md`. The worker resumes and writes
`…-spec-review-0.md`, the path it still holds. The row never advances; the only thing that moves it
is the 45-minute task stall ladder.

C4 does not save this: `reserveVerdictPath` is called from `promptForTaskPhase`,
`promptForRunPhase` and `cmdRewind` only, and none of them runs here — `deliverPendingAnswers` is at
`src/supervisor/main.ts:212`, *after* `advanceTasks` at `:185`, and on the next tick the
`spec-review` arm of `gatherSignals` (`src/supervisor/tasks.ts:270-275`) returns no verdict, so
`advanceTask` returns `null` and `src/supervisor/tasks.ts:173` `continue`s. This is BLOCKER 1 of pass
0 exactly, on a second command.

**(b) `hpipe abort` then `hpipe resume` on a run in `branch-review`.** `cmdAbort` sets
`run.escalated_from = run.phase` (`src/cli.ts:494`) and `cmdResume` writes it back at `:511` — the
documented undo (`src/cli.ts:497`, `README.md:103`). `cmdResume` does **not** clear `passes`, and on a
post-change record `entriesFor - 1 == counterFor` throughout the `branch-review` self-loop, so the
bump makes `entriesFor - 1 = counterFor + 1` and the ordinal moves by one. No prompt follows:
`src/supervisor/main.ts:184` captures `runPhaseBefore` inside the tick, `evaluateRun` cannot advance a
row whose artifact is absent (`src/supervisor/deliver.ts:228`), so `:215`'s equality holds and
`promptForRunPhase` is not called. The orchestrator writes `…-branch-review-N.md`; the supervisor
watches `…-branch-review-(N+1).md`.

Both are benign today, which is what makes this a regression rather than an existing hole: the path
is keyed on `counterFor`, and neither `deliverPendingAnswers` nor `cmdResume` touches it. The spec's
own Goal (`"the pipeline keeps moving without a human git mv"`) and the research note's constraint
(*"converting silent data loss into a silent deadlock"*, research `:96-97`) are what this violates.

**Evidence.**

    $ grep -rn "enterTaskPhase(\|enterRunPhase(" src/ | grep -v "^src/lib/machine.ts"
    src/cli.ts:265:  enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'dispatched at registration')
    src/cli.ts:431:  enterTaskPhase(run, task, 'blocked-on-decision', 'worker surfaced a decision')
    src/supervisor/tick.ts:193:        enterTaskPhase(run, task, 'failed', 'agent released')
    src/supervisor/tick.ts:206:      enterTaskPhase(run, task, 'failed', task.pr ? 'pane exited after PR' : 'pane exited with no PR')
    src/supervisor/stall.ts:370:  if (c.task) enterTaskPhase(c.run, c.task, 'escalated', why)
    src/supervisor/stall.ts:371:  else enterRunPhase(c.run, 'escalated', why)
    src/supervisor/tasks.ts:143:        enterTaskPhase(run, task, 'blocked-on-failure', `depends on ${gate.on.join(', ')}`)
    src/supervisor/tasks.ts:148:      enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'gate opened')
    src/supervisor/tasks.ts:341:    enterTaskPhase(run, task, resumeTo, `decision ${decision.id} answered`)
    src/supervisor/teardown.ts:28:        enterTaskPhase(run, task, 'done', 'worktree kept by request')
    src/supervisor/teardown.ts:34:      enterTaskPhase(run, task, removed ? 'done' : 'orphaned',

Of those, `:341` is the only one whose target can be a `signal: 'verdict'` row, and it is the only one
that is a resume. `src/cli.ts:265` (→ `research`), `tasks.ts:143`/`:148`, `stall.ts:370`
(→ `escalated`), `tick.ts:193`/`:206` (→ `failed`) and `teardown.ts:28`/`:34` (→ `done`/`orphaned`)
are all inert, as A6 assumes. `src/cli.ts:431` (→ `blocked-on-decision`) is inert on its own; it is
the return leg that is not.

**Concrete fix.** This is a rule change, not an edit, so state which:

- **(a)** Narrow A6 from *"every phase assignment bumps"* to *"every phase assignment that starts a
  new document bumps"*, and exempt the two resume legs — `src/supervisor/tasks.ts:341` and
  `src/cli.ts:511` — so they restore the phase without touching `phase_entries`. This keeps today's
  behaviour byte-for-byte on both paths and costs two named exceptions, which is the cheaper answer
  but is exactly the "four remembered sites" A6 was written to avoid. Say so.
- **(b)** Keep A6 and give both legs a reservation *and* a re-delivery: `cmdResume` reserves and names
  the path in its success text the way A12 does for `cmdRewind`, and `prompts/answer.md` gains a
  `{{verdict_path}}` rendered at `src/supervisor/tasks.ts:326-331`. Note the cost: `render()` throws
  on an unresolved `{{placeholder}}` (`src/lib/render.ts:11`) at delivery time in front of an agent,
  and `prompts/answer.md` is rendered for *every* `decision_from`, not just review rows, so the token
  has to resolve to something for `spec` and `implement` too.

Whichever is chosen, the enumeration in C2 has to stop being "the four `.phase =` sites" and become
"the phase-entry sites, classified", because `enterTaskPhase`'s ten callers are what actually decide
where `bumpEntries` fires. Add the decision round-trip to the Data-and-control-flow traces and the
resume legs to the testing strategy.

---

## MAJOR 1 — `src/lib/verdict-path.ts` is given the reservation but not the filename, so the reserver and the reader would derive names from two places

**Claim.** C3: *"`// src/supervisor/deliver.ts:97-107, delegating the key to src/lib/verdict-path.ts`"*,
with `join(REVIEWS_DIR, "<prefix>-${key}.md")` shown as staying in `deliver.ts`. C4: *"the key
derivation and the reservation move to a new pure module … `artifactPathFor`/`absoluteArtifactPath`
stay in `src/supervisor/deliver.ts` and delegate, so no caller and no existing test import moves."*

**Problem.** The two sentences describe different modules. C4 step 3 has `reserveVerdictPath`
*"`existsSync` the absolute default"* and step 4 *"walk `n+1, n+2, …` to the first free ordinal"* —
that needs the whole path, not the key: the directory, the per-record prefix, and the base the
relative path resolves against. All three live in `deliver.ts` today and none is exported:

    src/supervisor/deliver.ts:95    const REVIEWS_DIR = 'docs/superpowers/reviews'   // module-private
    src/supervisor/deliver.ts:103     ?? join(REVIEWS_DIR, `issue-${task.issue}-${key}.md`)
    src/supervisor/deliver.ts:106   return run.artifacts.verdicts[key] ?? join(REVIEWS_DIR, `${run.run_id}-${key}.md`)
    src/supervisor/deliver.ts:113   const base = task?.checkout_path ?? run.repo_root

So either `reserveVerdictPath` reimplements all four lines in `src/lib/verdict-path.ts` — two
independent spellings of the verdict filename, which is the drift this issue exists to remove, and
which no test would catch because both would be tested against themselves — or the path builder
itself moves to `src/lib/verdict-path.ts` and `artifactPathFor` delegates wholesale. The spec never
picks, and the second reading contradicts C3's own code comment and moves `REVIEWS_DIR` out of the
file whose neighbouring comment C5 rewrites.

**Evidence.** `REVIEWS_DIR` is declared at `src/supervisor/deliver.ts:95` with no `export`, directly
under the comment C5 edits (`:91-94`). `absoluteArtifactPath` (`:110-115`) is the only place the
`checkout_path ?? repo_root` choice is made, and `src/supervisor/main.ts:194` and
`src/supervisor/tasks.ts:55` both reach the filesystem through it.

**Concrete fix.** Say in C4 that `src/lib/verdict-path.ts` owns the *whole* verdict-path derivation —
`REVIEWS_DIR`, both prefixes, the `Math.max` key, the `artifacts.verdicts` override and the
base-directory choice — exporting something like `verdictPathFor(run, task)` and
`absoluteVerdictPath(run, task)`; that `artifactPathFor` keeps only the artifact-row branch
(`deliver.ts:99-100`) and calls into it for the rest; and that `REVIEWS_DIR` moves with them, with
C5's rewritten comment relocated or re-pointed. Then state that `reserveVerdictPath` probes through
that same helper, so there is exactly one expression that can produce a verdict filename.

---

## MAJOR 2 — `reserveVerdictPath`'s single return value is specified as absolute in one step and repo-relative in the next, and the relative/absolute mix-up corrupts `artifacts.verdicts`

**Claim.** C4: `export function reserveVerdictPath(run: Run, task: Task | null): string | null`.
Step 3: *"Otherwise `existsSync` the **absolute** default. If free, return it and write nothing."*
Step 4: *"record the winner at `artifacts.verdicts[key]` … and return it."* The flow section records a
**relative** value: `artifacts.verdicts['spec-review-0'] = 'docs/superpowers/reviews/issue-4-spec-review-1.md'`.
A12's success text also names a relative path.

**Problem.** One `string` cannot be both, and the three call sites want different ones. The two render
sites need the absolute path — `src/supervisor/tasks.ts:55` is
`verdict_path: absoluteArtifactPath(run, task) ?? ''` and `src/supervisor/deliver.ts:248` joins
`run.repo_root` — while `artifacts.verdicts` is unambiguously a store of repo-relative paths, because
`artifactPathFor` returns its value straight out at `:102`/`:106` and `absoluteArtifactPath` then joins
it onto the base at `:114`. Getting that backwards is not a cosmetic slip, because `join` does not
treat an absolute second segment specially:

    $ bun -e "const {join}=require('node:path'); console.log(join('/w','/Volumes/x/docs/superpowers/reviews/a.md'))"
    /w/Volumes/x/docs/superpowers/reviews/a.md

So a `reserveVerdictPath` that records what it returned would write an absolute path into
`artifacts.verdicts`, and every later read — the one C4 step 2 exists to make agree — would hand the
agent `/w/Volumes/…`. The design's whole idempotence argument rests on that read.

**Evidence.** `src/supervisor/deliver.ts:101-106` (the override is returned as-is, before any join),
`:110-115` (`absoluteArtifactPath` joins `task?.checkout_path ?? run.repo_root`),
`test/deliver.test.ts:156-161` (a relative override), `test/deliver.test.ts:221-225`
(`absoluteArtifactPath(run, null)` must start with `/r/docs/superpowers/reviews/`).

**Concrete fix.** Give the module two stated returns rather than one overloaded string — e.g.
`reserveVerdictPath(run, task): { relative: string; absolute: string } | null` — and say explicitly
that the value written to `artifacts.verdicts[key]` is `relative` and the value rendered into
`{{verdict_path}}` is `absolute`, and that A12's success text prints `relative`. Add it to the C4 test
list: *"a redirect records a repo-relative path, and `absoluteArtifactPath` resolves it against
`checkout_path`."*

---

## MINOR 1 — the C2 seed, as written, does not compile, and `bun run typecheck` is a declared gate

C2:

    record.phase_entries ??= {}
    for (const [phase, spent] of Object.entries(record.passes)) {
      if (spent > 0) record.phase_entries[phase] ??= spent + 1
    }

`Object.entries` widens the key to `string`, and `phase_entries` is
`Partial<Record<TaskPhase, number>>` (A2), which has no index signature. Under this repo's
`tsconfig.json` (`"strict": true`, `"noUncheckedIndexedAccess": true`) that is an error, reproduced
on the exact shape:

    error TS7053: Element implicitly has an 'any' type because expression of type 'string' can't be
    used to index type 'Partial<Record<TaskPhase, number>>'.

This is the same block pass 0's MAJOR 1 was about, so it is worth naming rather than leaving to the
implementer. `src/lib/machine.ts:5-9` already shows the fix the repo uses — `counterFor` takes
`HasPasses { passes: Record<string, number | undefined> }` and the mapped type is assignable to it.
Route the seed's write through the `HasEntries`-shaped helper C1 already declares (a `seedEntries`
beside `bumpEntries`, or `bumpEntries`' own lazy init plus a set), and drop the second, duplicated
`??= {}` so there is one owner of the lazy init as C2's own prose claims.

## MINOR 2 — *"Normal loop, unchanged from today's filenames"* is not true of the PR-review loop, and the design silently fixes a second collision there

The Data-and-control-flow section opens *"Normal loop, unchanged from today's filenames"* and traces
`spec-review` only. On the PR-review loop the filenames do change, because a `BLOCKER` at
`pr-review-quality` returns to `implement` (`src/lib/phases.ts:114-116`) whose `onClear` is
`pr-review-intent` (`:109-110`) — so `pr-review-intent` is entered a second time with its own counter
still `0`, since it cleared and `src/lib/machine.ts:117-118` returns before `bumpCounter`. Today that
second review is written to `issue-N-pr-review-intent-0.md`, over the first, **with no rewind
involved**. C1/C3 fix it (`n = max(2-1, 0) = 1`), which is a real and unadvertised win and is exactly
A1's argument applied without a human in the loop.

Say it: the claim should be *"unchanged for a row whose only re-entry is its own `onBlocker` loop"*,
with the `pr-review-intent` re-entry named as a second collision this closes. It is also worth a line
in the testing strategy, because it is provable in a unit test where the rewind cases are not.

## MINOR 3 — the `existsSync` error-table row covers only the half that fails safe

*"C4 in `cmdRewind` with a torn-down or missing worktree | `existsSync` is false, so the default path
is used. There is no review there to lose."* That is the safe half. The other half is that the probe
does not always run against the worktree: `absoluteArtifactPath` falls back to `run.repo_root`
(`src/supervisor/deliver.ts:113`) whenever `checkout_path` is `null`, which is every task between
`hpipe task` and worktree adoption (`src/cli.ts:224` initialises it `null`; `src/supervisor/tick.ts:169`
is the only writer). On a rewind of such a task onto a review row, C4 probes the **main checkout**,
where merged reviews for the same issue do exist, and redirects away from a name that is free where
the review will actually be written. Harmless today, but it is a stated-behaviour gap in the row that
exists to state it. Add the `checkout_path === null` case, and consider having C4 decline to probe at
all when it has no checkout to probe.

## MINOR 4 — A11 presents a complete affected-test set and omits the one test that pins C4's real invariant

A11 lists four tests. The one it does not list is `test/tasks.test.ts:301-312`, *"a design row prompt
names the artifact path its own predicate will check"*, which loops over `spec-review` and
`plan-review` and asserts `promptForTaskPhase(...)` contains `absoluteArtifactPath(run, task)` — i.e.
exactly the rendered-equals-watched invariant C4 step 2 exists to preserve, at the one call site C4 is
added to. It stays green (`checkout_path: '/r/.worktrees/feat-x'` does not exist, so the probe returns
the default), but it belongs in A11 rather than being found by whoever breaks it.

## MINOR 5 — a fourth citation slip of the kind MINOR 5 swept, reproduced twice

The three slips pass 0 named are all correctly fixed. This is a fourth, inherited verbatim from the
pass-0 text and used twice (C3 point 2 and A11): `test/cli-commands.test.ts:35-47` is cited as the
`mkTask` literal; `:35` is the closing brace of `runWithTasks`' predecessor and the literal is
`:37-47`. Two smaller ones: `test/machine-task.test.ts:143-147` is cited as *"the `bumpCounter`
tests"* — the test is `:141-148`, and `:143-147` is its body minus the opening assertion; and C4's
call-site table gives `src/cli.ts:372` as *"`cmdRewind`, before `saveRun`"* when `:372` **is**
`await saveRun(ctx.stateDir, run)`. The insertion point is `:371`.

---

MAJOR 1 and MAJOR 2 are both inline fixes to C4's interface and do not by themselves block. BLOCKER 1
does: C1's bump rule is wrong for the two re-entries that are resumes, it introduces a new silent
deadlock on both, and choosing between narrowing A6 and adding a token to `prompts/answer.md` is a
rule change the implementer should not make alone.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 2
