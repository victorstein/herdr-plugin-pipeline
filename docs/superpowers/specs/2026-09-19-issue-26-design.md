# A verdict path a rewind cannot re-issue — design (#26)

Pass 0. Written against this worktree at `8dd7326` (branch `fix/26-verdict-overwrite`), building on
`docs/superpowers/research/2026-09-19-issue-26-research.md`. Every claim about current behaviour
carries a `file:line` or the command that produced it.

**Modelled on** `counterFor`/`bumpCounter` (`src/lib/machine.ts:7-21`) for the new counter — same
shape, same module, same monotonicity comment; `enterTaskPhase`/`enterRunPhase`
(`src/lib/machine.ts:45-51`, `:90-96`) for the single write point, which is where `phase_entered_at`
is already stamped; the artifact-adoption write-back at `src/supervisor/tasks.ts:264-267` for
recording a resolved artifact path onto the record so later prompts cite it and the resolution is
idempotent; `logAmbiguous` (`src/supervisor/tasks.ts:184-200`) for a once-per-phase-entry diagnostic;
and `test/deliver.test.ts:148-161` for where the path tests live. No new pattern is introduced.

## Problem

The verdict path is derived from a counter that `hpipe rewind` clears, so after a rewind the next
review is told to write to a filename an earlier review already holds.

    src/supervisor/deliver.ts:101-103
      const key = `${task.phase}-${counterFor(task, task.phase)}`
      return task.artifacts.verdicts[key]
        ?? join(REVIEWS_DIR, `issue-${task.issue}-${key}.md`)

    src/cli.ts:353   task.passes = {}
    src/cli.ts:360   run.passes = {}

That path is handed to an agent verbatim as `{{verdict_path}}` (`src/supervisor/tasks.ts:55`,
`src/supervisor/deliver.ts:253`) by five prompts (`prompts/spec-review.md:7-9`,
`prompts/plan-review.md:9`, `prompts/pr-review-intent.md:11`, `prompts/pr-review-quality.md:11`,
`prompts/branch-review.md:23`), one of which also requires the file to be committed and pushed
(`prompts/spec-review.md:16-17`). So the loss lands on the branch.

Verified on `fix/15-stall-escalation`: `git log --oneline --diff-filter=M fix/15-stall-escalation --
docs/superpowers/reviews/issue-15-spec-review-0.md` → `f672bfe`, whose `--stat` is
`314 insertions(+), 348 deletions(-)` on a 662-line file — a whole-file replacement. Three manual
`git mv` repairs (`432f4d7`, `944210d`, `ddd5086`, all 2026-09-17) and four surviving `*-preserved.md`
files are the workaround. 13 rewinds across four live ledgers in three days.

**The constraint the research established, and the one that kills the obvious fix.** `verdictFor`
gates on `isFresh(absolute, t.phase_entered_at)` (`src/supervisor/main.ts:193-199`,
`src/lib/predicates.ts:10-20`) and `cmdRewind` re-stamps `phase_entered_at` (`src/cli.ts:355`,
`:361`). After a rewind the occupant reads stale, so the row only advances when the reviewer
overwrites it. A fix shaped purely as "refuse to write an occupied path" converts silent data loss
into a silent deadlock. Any refusal must also hand over a different path.

## Goal

After any sequence of rewinds, two different reviews never share a filename, and the pipeline keeps
moving without a human `git mv`. The fix must work on the runs already on disk.

## Non-goals

- No `schema_version` bump. `isCurrentSchemaRun` is `run.schema_version === 2`
  (`src/supervisor/main.ts:32-34`) and `src/lib/status.ts:112-117` tells the human to abort anything
  else; bumping it strands the four live runs rather than migrating them.
- No change to `MAX_PASSES` semantics or to what `passes` means. `passes` remains the escalation
  budget (`src/lib/machine.ts:120-123`, `:78-81`), and rewind keeps clearing it — that is the point
  of rewind and `README.md:100` documents it.
- No rename of the four `*-preserved.md` files already in the tree.
- No edit to `README.md`, `prompts/dispatch.md`, `src/hooks/`, `src/lib/config.ts` or
  `test/config.test.ts` — sibling-owned this batch. The design below is chosen partly so that
  `README.md:100`'s description of rewind stays literally true (A7).
- Not #22's broader rewind validation; the phase-argument check already landed at
  `src/cli.ts:311-321`.

## Architecture

Three changes, in the three layers the repo already separates.

### C1 (load-bearing) — a monotone phase-entry counter in `src/lib/machine.ts`

New optional field on both records, mirroring `passes`:

    // src/lib/types.ts
    Task.phase_entries?: Partial<Record<TaskPhase, number>>
    Run.phase_entries?:  Partial<Record<RunPhase, number>>

and, beside `counterFor`/`bumpCounter` (`src/lib/machine.ts:7-21`):

    export function entriesFor(record: HasEntries, phase: string): number
    export function bumpEntries(record: HasEntries, phase: string): number

`bumpEntries` is called from `enterTaskPhase` (`src/lib/machine.ts:90-96`) and `enterRunPhase`
(`:45-51`) — the same two functions that already stamp `phase_entered_at`, and the only place the
state machine changes a phase.

**Why an entry count and not a pass count.** A `CLEAR` verdict consumes a filename but never calls
`bumpCounter` (`src/lib/machine.ts:117-119` returns before the bump). So any design keyed on the
blocker counter still collides on *review clears at pass 0 → human rewinds onto that row*, which is a
used path: `t4:spec-review` on `berean-os-20260917-working-on-open-issues-xilp` is a rewind directly
onto a review row. Counting entries is the only counter that is incremented by everything that
consumes a name.

**Why not count `run.history` instead.** History is a human log with inconsistent `to` semantics, not
a countable structure: `src/actions/claim.ts:32` pushes `to: run.phase` for an orchestrator rebind
that is not a transition at all, and `src/lib/orchestrator.ts:56-59` pushes `to: resolved` — a *pane
id* in the `to` field. Counting `to === phase` would inflate the branch-review ordinal on every
claim. Rejected on that evidence.

### C2 — the four direct phase assignments outside the machine

`grep -rn "\.phase = " src/` returns six sites; two are the machine (C1). The other four bypass it
and must bump too, or a rewind onto a review row is invisible to the counter:

| Site | Command |
|---|---|
| `src/cli.ts:352` | `cmdRewind`, task branch |
| `src/cli.ts:359` | `cmdRewind`, run branch |
| `src/cli.ts:495` | `cmdAbort` (→ `done`) |
| `src/cli.ts:511` | `cmdResume` (→ `escalated_from`, which can be `branch-review`) |

All four get `bumpEntries`. `cmdAbort`'s target is terminal and carries no verdict, but it is
included so the rule is "every phase assignment bumps", with no site to remember (A6).

`cmdRewind` additionally **seeds** the counter for records that predate this change, immediately
before `passes` is cleared:

    for (const [phase, spent] of Object.entries(record.passes)) {
      if (spent > 0) record.phase_entries[phase] ??= spent + 1
    }

`??=` and not `=`: on a record written after this change the key already exists and is exact, and
overwriting it would open gaps in the numbering. On a legacy record the key is absent and `spent + 1`
is the number of times the row must have been entered to spend `spent` passes.

### C3 — `artifactPathFor` reads the new counter, with a floor

    // src/supervisor/deliver.ts:97-107
    const n = Math.max(entriesFor(record, phase) - 1, counterFor(record, phase))
    const key = `${phase}-${n}`
    return record.artifacts.verdicts[key] ?? join(REVIEWS_DIR, `<prefix>-${key}.md`)

`- 1` because `bumpEntries` runs on entry, so the first entry reads 1 and must render `…-0.md`.

`Math.max(…, counterFor(…))` is the back-compat floor, and it does three things at once:

1. A legacy run mid-review at upgrade has no `phase_entries`: `entriesFor` is 0, `-1` loses to
   `counterFor`, and the path is **byte-identical to today's**. Nothing in flight moves.
2. A record whose phase was set without any entry being recorded — every `mkTask`/`mkRun` literal in
   the test suite, e.g. `test/deliver.test.ts:149-153` — reads `max(-1, 0) = 0`, so today's default
   survives.
3. It makes the result monotone in both inputs, so neither counter can drag the path backwards.

The `artifacts.verdicts[key]` override keeps precedence exactly as today, which is what
`test/deliver.test.ts:156-161` pins — and C4 is its first writer.

### C4 — a ground-truth backstop where the path is handed to an agent

`reserveVerdictPath(run, task)` in `src/supervisor/deliver.ts`, called once per transition from
`promptForTaskPhase` (`src/supervisor/tasks.ts:46-60`) and `promptForRunPhase`
(`src/supervisor/deliver.ts:246-255`) — the only two places a verdict path reaches an agent:

1. Compute `key` and the default path as C3 does.
2. If `artifacts.verdicts[key]` is already set, return it. (Idempotence — `promptForRunPhase` can be
   reached twice for one transition, from `evaluateRun` at `src/supervisor/deliver.ts:242` and from
   `src/supervisor/main.ts:215-217`.)
3. Otherwise `existsSync` the absolute default. If free, return it and write nothing.
4. If occupied, walk `n+1, n+2, …` to the first free ordinal (bounded, A5), record the winner at
   `artifacts.verdicts[key]`, log one line, and return it.

The record is keyed by the **phase entry** and valued with the **path**, so a later read through
`artifactPathFor` returns the same file. `src/supervisor/main.ts:242` saves the run after all
rendering, so the write persists.

**Why both C1 and C4.** Neither is sufficient alone. C1 cannot know about files it did not create —
a legacy run that cleared a review at pass 0, or a human's `git mv`. C4 cannot run where no prompt is
rendered — a rewind straight onto a review row re-enters no phase, so `advanceTask` never fires and
no prompt is produced. C1 is the deterministic mechanism; C4 is the ground-truth net under it.

### C5 — one prompt correction

`prompts/escalate.md:17` says rewind "resets the pass count for that phase". `src/cli.ts:353` clears
the whole map. Corrected to say so. This file is mine this batch; `README.md`'s equivalent line is
not, and needs no change (A7).

## Data and control flow

Normal loop, unchanged from today's filenames:

| Step | `phase_entries['spec-review']` | `passes['spec-review']` | `n` | File |
|---|---|---|---|---|
| enter `spec-review` | 1 | 0 | `max(0,0)=0` | `issue-26-spec-review-0.md` |
| `BLOCKER` → `spec` → `spec-review` | 2 | 1 | `max(1,1)=1` | `…-1.md` |
| `BLOCKER` → counter 2 ≥ `MAX_PASSES` (`src/lib/config.ts:26`) | 2 | 2 | — | `escalated` |

`hpipe rewind <run> spec --task t1`:

| Step | `phase_entries['spec-review']` | `passes` | `n` | File |
|---|---|---|---|---|
| seed (`??=`, key present) | 2 | `{spec-review: 2}` → `{}` | — | — |
| bump target `spec` | 2 | `{}` | — | — |
| enter `spec-review` | 3 | 0 | `max(2,0)=2` | `…-2.md` |

The same record on a **legacy** run with no `phase_entries`: the seed fills
`phase_entries['spec-review'] = 3`, the next entry makes it 4, and `n = max(3,0) = 3` → `…-3.md`.
`-0` and `-1` survive; one ordinal is skipped, which is the price of not having been counting.

`hpipe rewind <run> spec-review --task t1` (directly onto the row): the seed does not fire
(`passes['spec-review']` may be 0 after a `CLEAR`), `bumpEntries` takes the counter to 2, and
`n = max(1, 0) = 1` → `…-1.md`. On a legacy run both counters read 0, `n = 0`, the default is
occupied, and C4 redirects to `…-1.md` and records it.

Run-level `branch-review` is the same flow with `run.artifacts.verdicts` and the
`${run.run_id}-${key}.md` prefix (`src/supervisor/deliver.ts:105-106`).

## Error handling

| Condition | Behaviour |
|---|---|
| `phase_entries` absent on a record read from disk | `entriesFor` returns 0; the floor yields today's path. No migration, no throw. |
| `bumpEntries` on a record whose `phase_entries` is absent | Creates `{}` in place, mirroring how `bumpCounter` writes into `passes` (`src/lib/machine.ts:19`). |
| Default verdict path already occupied | C4 redirects and logs once: `[pipeline] t1 (#26): spec-review-0 is occupied by <path> — writing to <new> instead`, in the shape of `logAmbiguous` (`src/supervisor/tasks.ts:196-199`). |
| C4's probe exhausts its bound (A5) | Returns the default path and logs the exhaustion. Degrades to today's behaviour rather than looping; the supervisor tick must not hang. |
| `absoluteArtifactPath` returns `null` (an artifact row, not a verdict row) | C4 is not called; `promptForTaskPhase` already renders `?? ''` (`src/supervisor/tasks.ts:55`). |
| `existsSync` on an unreadable directory | Returns `false`, so the default is used. No throw, consistent with `src/supervisor/tasks.ts:244`. |
| A run saved mid-tick after a redirect but before delivery | The record is in `artifacts.verdicts`, so the retried render returns the same path (C4 step 2). |

## Assumptions

Each is a behavioural choice, stated so the review can attack it.

**A1 — the ordinal counts phase entries, not review passes.** A `CLEAR` consumes a filename without
bumping `passes` (`src/lib/machine.ts:117-119`), so a pass-derived ordinal still collides on
clear-then-rewind. Rejecting A1 means accepting that hole.

**A2 — `phase_entries` is optional, not required.** Required would force an edit to every `mkTask`
and `mkRun` literal in the suite (`grep -l "passes: {}" test/*.ts | wc -l` → 12 files) and to both
constructors, for no behavioural gain; optional is what makes the floor in C3 meaningful and the
upgrade silent. The constructors (`src/lib/ledger.ts:24-41`, `src/cli.ts:225-232`) still initialise
it to `{}` so new runs are explicit.

**A3 — no `schema_version` bump.** The field is additive and absent-safe, and
`src/supervisor/main.ts:32-34` is a hard gate that refuses to advance anything that is not exactly
`2`. Bumping strands live runs.

**A4 — C4 records a path only when it redirects.** Recording every minted path would give
`artifacts.verdicts` a uniform writer, but it grows the ledger on every review and makes the on-disk
name depend on a write that used to be derivable. The derived default stays the norm; the record is
the exception that documents a collision.

**A5 — C4's probe is bounded at 64 ordinals.** `existsSync` terminates naturally, but this runs
inside the supervisor tick and an unbounded loop over a pathological reviews directory is the kind of
hang `src/supervisor/deliver.ts:130-137` already guards against for `Bun.spawn`.

**A6 — every direct `.phase =` assignment bumps, including `cmdAbort`'s terminal one.** A rule with
no exceptions is cheaper to keep true than four remembered sites; `done` carries no verdict, so the
extra key is inert.

**A7 — rewind's documented behaviour does not change, so `README.md:100` stays true.** `passes` is
still cleared wholesale and the success text `"…; counters cleared"` (`src/cli.ts:373`) is still
accurate. This is deliberate: `README.md` is sibling-owned this batch and a design that needed it
edited would need coordination instead.

**A8 — `{{pass}}` in the prompts keeps meaning the escalation pass, not the file ordinal.** It is
rendered from `counterFor` (`src/supervisor/tasks.ts:54`, `src/supervisor/deliver.ts:252`) and is
what `MAX_PASSES` bounds. After a rewind a reviewer will see "pass 0" writing to `…-2.md`, which is
the honest reading: the budget restarted, the audit trail did not.

**A9 — the four `*-preserved.md` files stay where they are.** Renaming them back would re-open the
names this change is stopping anyone from reusing.

**A10 — no in-place migration of records on disk.** The floor in C3 plus the seed in C2 plus the
backstop in C4 cover every legacy case without a load-time rewrite, which
`src/supervisor/main.ts:28-31` states this repo does not do.

**A11 — the research note's prediction that three tests must move is wrong, and they stay.**
Verified against the design: `test/deliver.test.ts:148-154` sets `run.passes['branch-review'] = 1`
and expects a changed path — the floor gives `max(-1, 1) = 1`, so it still passes.
`test/deliver.test.ts:227-232` seeds `passes: { 'spec-review': 1 }` with no `phase_entries` and
expects `spec-review-1` — the floor gives exactly that, and it is the clearest single demonstration
that the back-compat path is the one the suite already pins. `test/cli.test.ts:117-129` and
`test/cli-commands.test.ts:228-239` assert `passes` becomes `{}`, which C2 preserves. Recorded here
because the research note asserted otherwise.

## Testing strategy

TDD: the red test first, run, then the minimum code, run again.

**The red test** (`test/deliver.test.ts`, beside the two existing path tests at `:148-161`) — a task
that has entered `spec-review` twice and is then rewound must not be handed either earlier path:

    test('a rewind does not re-issue a verdict path an earlier review already holds', …)

It fails today because `artifactPathFor` returns `issue-26-spec-review-0.md` for both.

**Unit, `src/lib/machine.ts`** (`test/machine-task.test.ts`, `test/machine-run.test.ts`, beside the
`bumpCounter` tests at `test/machine-task.test.ts:143-147`):

- `entriesFor` reads 0 on a record with no `phase_entries`.
- `enterTaskPhase`/`enterRunPhase` bump the phase entered, and only that phase.
- The counter is never decremented by any transition, including `onBlocker` re-entry.

**Unit, `src/cli.ts`** (`test/cli-commands.test.ts`, beside the rewind tests at `:228-239`):

- `cmdRewind` bumps the target phase and leaves `passes` cleared.
- `cmdRewind` seeds `phase_entries` from spent `passes` on a record that has none, and does **not**
  overwrite one that does.
- `cmdResume` bumps the phase it returns to.

**Unit, `src/supervisor/deliver.ts`** (`test/deliver.test.ts`):

- The ordinal sequence over a normal loop is `0, 1, 2` — unchanged from today.
- A record with no `phase_entries` and `passes: {spec-review: 1}` renders `…-1.md` (back-compat).
- `reserveVerdictPath` leaves the record untouched when the default is free.
- `reserveVerdictPath` redirects around an occupied file, records it under the entry key, and a
  second call returns the recorded path rather than probing again.
- Run-level `branch-review` gets the same treatment with the `run_id` prefix.

The filesystem tests use `tempDir`/`commitIn` from `test/helpers/git-worktree.ts`, already used by
`test/deliver.test.ts:255-300`.

**Regression, unchanged:** `test/deliver.test.ts:156-161` (override precedence),
`test/deliver.test.ts:287-295` (`adoptableArtifacts` still excludes the reviews prefix),
`test/prompts.test.ts` (the declared prompt set and review-trailer contract, which C5 touches).

**Gates:** `bun test` and `bun run typecheck` both green before push, and the measured numbers quoted
in the PR body. Baseline to beat: 503 pass, 0 fail, 1265 expect() calls, 34 files; `tsc --noEmit`
exit 0. CI is a PR-title lint only (`.github/workflows/pr-title-lint.yml`), so these are run by hand.

**Live verification**, required by `.claude/agents/plugin-dev.md` because this changes delivery —
what a prompt tells an agent to write. The unit suite uses injected fakes and has passed clean over
real defects twice, so it cannot settle this. The installed plugin is pinned to a GitHub commit
(`herdr plugin list` → `…@be181757…`), so this code is not live until the release lands. After it
does:

1. On a run in `spec-review` with `…-spec-review-0.md` already committed, `hpipe rewind <run> spec
   --task <t>`, then watch the pane for the re-rendered `spec-review` prompt and confirm
   `{{verdict_path}}` names `…-spec-review-1.md`, with `-0` untouched on disk and in `git status`.
2. Confirm `hpipe status` is unchanged (it reads `counterFor`, `src/lib/status.ts:102-105`), so the
   reported pass number still reflects the escalation budget and not the file ordinal — A8, observed
   rather than asserted.
3. `hpipe rewind <run> spec-review --task <t>` directly onto the row, on a task whose last verdict
   was `CLEAR`: confirm the supervisor log carries the C4 redirect line and that no committed review
   changed. This is the path no unit test can prove, because it depends on the ordering of a real
   rewind against a real tick.

Any difference between this runbook and what is observed is a finding, not a test to make pass.

## Rejected alternatives

**Refuse to write an occupied path and stop.** The issue's second direction, taken literally. It
deadlocks the row: `isFresh` is measured against the re-stamped `phase_entered_at`
(`src/supervisor/main.ts:196`, `src/cli.ts:355`), so nothing but an overwrite advances it. Kept only
as the backstop in C4, which redirects rather than refuses.

**Stop clearing `passes` at rewind; give escalation a separate resettable floor.** Inverts which
counter resets, and the path needs no change at all. Rejected: it still collides on clear-then-rewind
(A1), and it changes what `hpipe rewind` does — the one thing `README.md:100`, a sibling's file,
documents.

**Derive the ordinal by counting `run.history`.** Retroactively exact and needs no new field, but
`src/actions/claim.ts:32` writes `to: run.phase` for a non-transition and
`src/lib/orchestrator.ts:56-59` writes a pane id into `to`. The ordinal would move on an orchestrator
rebind. Rejected on that evidence.

**Put the phase-entry timestamp in the filename.** Collision-free by construction and needs no
counter, but `issue-26-spec-review-1758243011947.md` destroys the one thing the current names do
well: `prompts/spec.md:21`, `prompts/plan.md:18` and `prompts/implement.md:15` all tell a worker to
find "the review for this issue under `docs/superpowers/reviews/`", and a human reads the ordinal to
know which pass they are looking at.
