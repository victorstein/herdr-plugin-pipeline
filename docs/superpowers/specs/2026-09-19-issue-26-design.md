# A verdict path a rewind cannot re-issue — design (#26)

Pass 1. Written against this worktree at `192142b` (branch `fix/26-verdict-overwrite`), building on
`docs/superpowers/research/2026-09-19-issue-26-research.md` and answering
`docs/superpowers/reviews/issue-26-spec-review-0.md`. Every claim about current behaviour carries a
`file:line` or the command that produced it.

**Modelled on** `counterFor`/`bumpCounter` (`src/lib/machine.ts:7-21`) for the new counter — same
shape, same module, same monotonicity comment; `enterRunPhase`/`enterTaskPhase`
(`src/lib/machine.ts:45-51`, `:90-96`) for the single write point, which is where `phase_entered_at`
is already stamped; **`src/lib/gating.ts`** for a pure `src/lib/` module imported by both `src/cli.ts`
(`:5`) and `src/supervisor/tasks.ts` (`:4`), which is the shape C4 now needs; the artifact-adoption
write-back at `src/supervisor/tasks.ts:264-267` for recording a resolved artifact path onto the
record so later prompts cite it; `logAmbiguous` (`src/supervisor/tasks.ts:184-200`) for a
once-per-entry diagnostic; and `test/deliver.test.ts:148-161` plus `test/cli-commands.test.ts:228-239`
for where the tests live. No new pattern is introduced.

## What changed from pass 0, by finding

Review 0 returned `VERDICT: BLOCKER` — 1 BLOCKER, 3 MAJORs, 6 MINORs. I verified every finding
against the code before accepting it. **All ten hold and all ten are applied.** Nothing was rejected;
one MINOR is *escalated*, because verifying it showed the defect is worse than the review said.

**BLOCKER 1 — the spec contradicted itself about C4, and the one live case was uncovered.**
Accepted; it is the reason this pass exists. Pass 0's `:166-169` said C4 cannot run after a rewind
straight onto a review row, and its `:199-202` claimed C4 redirects in exactly that case. Confirmed
the first is the one that matches the code:

    src/supervisor/tasks.ts:171-178
      const cameFrom = task.phase
      if (!advanceTask(run, task, signals)) continue
      if (task.phase === cameFrom) continue
      const prompt = await promptForTaskPhase(run, task, deps, cameFrom)

After `hpipe rewind <run> spec-review --task t1` the task is already in `spec-review`
(`src/cli.ts:352`), `verdictFor` returns `null` for want of a fresh file
(`src/supervisor/tasks.ts:270-275`), `advanceTask` returns `null`, and the loop `continue`s.
`grep -rn "verdict_path" src/` returns only `src/supervisor/tasks.ts:55` and
`src/supervisor/deliver.ts:253`; neither is on this path. **C4 has moved to `cmdRewind`** — the
reviewer's fix (a) — and that move has an architectural consequence the review did not name, handled
in C4 below.

**MAJOR 1 — the C2 seed threw on exactly the legacy records it exists for.** Accepted.
`record.phase_entries` is `undefined` on a pre-change record (A2 makes it optional), and pass 0
ordered the seed *before* the bump that creates the map, so `record.phase_entries[phase]` was a
`TypeError`. `test/cli-commands.test.ts:35-47` builds tasks from a hand-written literal, not a
constructor, so `test/cli-commands.test.ts:228-239` — which A11 claims stays green — would have
thrown. C2 now states the lazy init, the error table has its own row for it, and A11 is amended.

**MAJOR 2 — C4's guard was inverted and its call site fires for artifact rows.** Accepted, and
verified twice over. `src/supervisor/tasks.ts:49-60` builds `common` **before** the `switch`, so
`verdict_path` is computed for every task phase. And `absoluteArtifactPath` does not return `null`
for an artifact row — `src/supervisor/deliver.ts:98-100` returns the artifact's own slot, and
`src/cli.ts:216-233` fills all three slots at registration, so `null` only ever comes from a test
literal (`test/deliver.test.ts:21`). The reviewer's further point is confirmed: `ci` has no
`artifact` either (`src/lib/phases.ts:122-124`) and therefore falls through to the verdict branch
today, so the guard must test `signal === 'verdict'`, not `artifact === undefined`. C4 now carries
that guard at all three sites and the error table row is replaced.

**MAJOR 3 — after a rewind onto a review row the watched path moved and nothing said so.**
Accepted and resolved by A12, which is the reviewer's option (c) plus the reporting half of its
option (a) — both of which the BLOCKER 1 fix makes free, since `cmdRewind` now knows the path. Its
options (a)-in-full (teach `hpipe status` the ordinal) and (b) (re-deliver the row's prompt) are
rejected with reasons under *Rejected alternatives*. A12 records the residual gap explicitly rather
than leaving it unstated, and *Why this was not an `hpipe decide`* says why I settled it here.

**MINOR 1 — C4's idempotence rationale was false.** Accepted. `src/supervisor/main.ts:184` captures
`runPhaseBefore` *after* `evaluateRun` has already mutated `run.phase` at `:182`, so `:215`'s
`run.phase === runPhaseBefore` is always true for a transition `evaluateRun` made. Verified further
than the review did: `grep -n "enterRunPhase\|run.phase" src/supervisor/tasks.ts src/supervisor/teardown.ts`
returns no assignment, so nothing between `:184` and `:215` can change `run.phase` and `:215-217` is
unreachable in practice. The step is kept; the reason is replaced (C4, step 2).

**MINOR 2 — escalated from "the rationale is wrong" to "the seed can undercount".** The review said
`spent + 1` is a safe upper bound whose *justification* was wrong, while noting in the same sentence
that a `CLEAR` lets the true entry count exceed `spent` — which makes it not an upper bound. I traced
it: under today's code a file's ordinal is `counterFor` at entry, so a stretch that reached `passes 1`
leaves `-0` and `-1`; a rewind clears the counter, and a following `CLEAR` at `passes 0` leaves
`spent = 0`, so **the seed does not fire at all** and the next entry resolves to `-0` with `-1`
already on disk. The honest statement is now in C2: the seed is a lower-bound heuristic that is safe
only when it fires, and the filesystem reservation in C4 is what actually guarantees no collision on
a legacy record. This is why C4-at-`cmdRewind` is load-bearing and not a backstop.

**MINOR 3 — "0, 1, 2 over a normal loop" contradicted `MAX_PASSES = 2`.** Accepted.
`src/lib/config.ts:26` is `2` and `src/lib/machine.ts:121-123` escalates on `count >= maxPasses`, so
a default loop yields `-0` and `-1`. The testing strategy now says `0, 1`, and the three-entry trace
is stated as a test that passes `maxPasses: 3` explicitly.

**MINOR 4 — the comment C4 falsifies was not in the change set.** Accepted.
`src/supervisor/deliver.ts:91-94` asserts no writer for `artifacts.verdicts`; C4 makes that false
while its conclusion (`:180`, pinned by `test/deliver.test.ts:287-295`) stays correct. Added to C5,
as the research note asked (`research:183-186`) and `.claude/agents/plugin-dev.md:32-34` requires.

**MINOR 5 — three citation slips.** All three confirmed and corrected: `src/lib/machine.ts:45` is
`enterRunPhase` and `:90` is `enterTaskPhase` (pass 0 paired them in the wrong order); the suite's
literals are `test/deliver.test.ts:14-25` and `:27-31`, not `:149-153`; the task constructor is
`src/cli.ts:216-233`, not `:225-232`.

**MINOR 6 — the red test could not live where it was specified.** Accepted.
`test/deliver.test.ts:1-10` does not import `cmdRewind`. The red test moves to
`test/cli-commands.test.ts`, and the BLOCKER 1 fix makes it a *genuine* red rather than a test of
code that does not compile yet: it asserts on `artifactPathFor` after `cmdRewind`, using only APIs
that exist today, and fails today because `cmdRewind` reserves nothing.

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

**The constraint that kills the obvious fix.** `verdictFor` gates on
`isFresh(absolute, t.phase_entered_at)` (`src/supervisor/main.ts:193-199`,
`src/lib/predicates.ts:10-20`) and `cmdRewind` re-stamps `phase_entered_at` (`src/cli.ts:355`,
`:361`). After a rewind the occupant reads stale, so the row only advances when the reviewer
overwrites it. A fix shaped purely as "refuse to write an occupied path" converts silent data loss
into a silent deadlock. Any refusal must also hand over a different path.

## Goal

After any sequence of rewinds — including onto a review row, including on a record written before
this change — two different reviews never share a filename, and the pipeline keeps moving without a
human `git mv`.

## Non-goals

- No `schema_version` bump. `isCurrentSchemaRun` is `run.schema_version === 2`
  (`src/supervisor/main.ts:32-34`) and `src/lib/status.ts:112-117` tells the human to abort anything
  else; bumping it strands the four live runs rather than migrating them.
- No change to `MAX_PASSES` semantics or to what `passes` means. `passes` remains the escalation
  budget (`src/lib/machine.ts:120-123`, `:78-81`), and rewind keeps clearing it.
- No change to `hpipe status` (A12), and no rename of the four `*-preserved.md` files (A9).
- No edit to `README.md`, `prompts/dispatch.md`, `src/hooks/`, `src/lib/config.ts` or
  `test/config.test.ts` — sibling-owned this batch. The design is chosen partly so `README.md:100`'s
  description of rewind stays literally true (A7).
- Not #22's broader rewind validation; the phase-argument check already landed at
  `src/cli.ts:311-321`, and C4 depends on it (A13).

## Architecture

Five changes. C1–C3 are the deterministic mechanism; C4 is the ground truth that makes legacy records
safe; C5 is documentation.

### C1 (load-bearing) — a monotone phase-entry counter in `src/lib/machine.ts`

New optional field on both records, mirroring `passes`:

    // src/lib/types.ts
    Task.phase_entries?: Partial<Record<TaskPhase, number>>
    Run.phase_entries?:  Partial<Record<RunPhase, number>>

and, beside `counterFor`/`bumpCounter` (`src/lib/machine.ts:7-21`):

    export function entriesFor(record: HasEntries, phase: string): number
    export function bumpEntries(record: HasEntries, phase: string): number   // lazily creates the map

`bumpEntries` is called from `enterRunPhase` (`src/lib/machine.ts:45-51`) and `enterTaskPhase`
(`:90-96`) — the same two functions that already stamp `phase_entered_at`, and the only place the
state machine changes a phase.

**Why an entry count and not a pass count.** A `CLEAR` verdict consumes a filename but never calls
`bumpCounter` (`src/lib/machine.ts:117-119` returns before it). Any design keyed on the blocker
counter still collides on *review clears → human rewinds onto that row*, which is a used path:
`t4:spec-review` on `berean-os-20260917-working-on-open-issues-xilp` is a rewind directly onto a
review row. Counting entries is the only counter incremented by everything that consumes a name.

**Why not count `run.history`.** History is a human log with inconsistent `to` semantics:
`src/actions/claim.ts:32` pushes `to: run.phase` for an orchestrator rebind that is not a transition,
and `src/lib/orchestrator.ts:56-59` pushes `to: resolved` — a *pane id* in the `to` field. Counting
`to === phase` would move the branch-review ordinal on every claim.

### C2 — the four direct phase assignments outside the machine, and the seed

`grep -rn "\.phase = " src/` returns exactly six sites; two are the machine (C1). The other four
bypass it:

| Site | Command |
|---|---|
| `src/cli.ts:352` | `cmdRewind`, task branch |
| `src/cli.ts:359` | `cmdRewind`, run branch |
| `src/cli.ts:495` | `cmdAbort` (→ `done`) |
| `src/cli.ts:511` | `cmdResume` (→ `escalated_from`, which can be `branch-review`) |

All four call `bumpEntries`, which owns the lazy `record.phase_entries ??= {}` (MAJOR 1).
`cmdAbort`'s target is terminal and carries no verdict; it is included so the rule is "every phase
assignment bumps", with no site to remember (A6).

`cmdRewind` additionally **seeds** the counter for records that predate this change, immediately
before `passes` is cleared. The map is created first, or this throws on exactly the records it serves:

    record.phase_entries ??= {}
    for (const [phase, spent] of Object.entries(record.passes)) {
      if (spent > 0) record.phase_entries[phase] ??= spent + 1
    }

`??=` on the inner assignment and not `=`: on a post-change record the key already exists and is
exact, and overwriting it would open gaps in the numbering.

**The seed is a heuristic, not a guarantee, and C4 is why that is acceptable** (MINOR 2, escalated).
When it fires it cannot undercount: under today's code a file's ordinal is `counterFor` at entry, so
no ordinal above `spent` can exist, and `spent + 1` clears them all. But it does not fire when
`spent` is 0, and `spent` is 0 after a rewind followed by a `CLEAR` — while `-0` and `-1` may both be
on disk from an earlier stretch. Nothing derivable from `passes` distinguishes that case, which is
A1's point turned on the seed itself. C4 asks the filesystem instead.

### C3 — `artifactPathFor` reads the new counter, with a floor

    // src/supervisor/deliver.ts:97-107, delegating the key to src/lib/verdict-path.ts
    const n = Math.max(entriesFor(record, phase) - 1, counterFor(record, phase))
    const key = `${phase}-${n}`
    return record.artifacts.verdicts[key] ?? join(REVIEWS_DIR, `<prefix>-${key}.md`)

`- 1` because `bumpEntries` runs on entry, so the first entry reads 1 and must render `…-0.md`.

`Math.max(…, counterFor(…))` is the back-compat floor, and it does three things at once:

1. A legacy run mid-review at upgrade has no `phase_entries`: `entriesFor` is 0, `-1` loses to
   `counterFor`, and the path is **byte-identical to today's**. Nothing in flight moves.
2. A record whose phase was set with no entry recorded — every `mkTask`/`mkRun` literal in the suite
   (`test/deliver.test.ts:14-25`, `:27-31`; `test/cli-commands.test.ts:35-47`) omits the field — reads
   `max(-1, 0) = 0`, so today's default survives.
3. It is monotone in both inputs, so neither counter can drag the path backwards.

The `artifacts.verdicts[key]` override keeps precedence exactly as today, which
`test/deliver.test.ts:156-161` pins — and C4 is its first writer.

### C4 — reservation against the filesystem, in `src/lib/verdict-path.ts`

**The move the review's fix (a) forces, which the review did not name.** `cmdRewind` must reserve the
path, and `src/cli.ts` cannot reach `src/supervisor/`:

    $ grep -rn "supervisor/" src/ | grep -v "^src/supervisor/"
    (no output)

`src/cli.ts:2-21` imports only from `./lib/`, and `src/supervisor/deliver.ts:2-10` imports only from
`../lib/`. So the key derivation and the reservation move to a new pure module, **`src/lib/verdict-path.ts`**,
imported by `src/cli.ts` and by `src/supervisor/deliver.ts`. `src/lib/gating.ts` is the existing
example of exactly this — imported by `src/cli.ts:5` and `src/supervisor/tasks.ts:4` — and
`src/lib/predicates.ts:1` establishes that a `src/lib/` module may touch the filesystem.
`artifactPathFor`/`absoluteArtifactPath` stay in `src/supervisor/deliver.ts` and delegate, so no
caller and no existing test import moves.

    export function reserveVerdictPath(run: Run, task: Task | null): string | null

1. **Guard (MAJOR 2).** Return `null`, changing nothing, unless the record's current row is a verdict
   row — `taskRow(task.phase).signal === 'verdict'` for a task, `runRow(run.phase).signal === 'verdict'`
   for a run (`src/lib/phases.ts:96-98`, `:101-103`, `:111-116`, `:64-66`). Not
   `artifact === undefined`: `ci` has no artifact and would otherwise qualify
   (`src/lib/phases.ts:122-124`), and `merge`, `close`, `implement` and the blocked rows fall through
   the same way.
2. If `artifacts.verdicts[key]` is already set, return it unchanged. **This is what makes the write
   and every later read agree** — `verdictFor` re-derives the path through `artifactPathFor` on every
   tick (`src/supervisor/main.ts:193-198`). (Pass 0 justified this step with a double-render that
   cannot happen; see MINOR 1.)
3. Otherwise `existsSync` the absolute default. If free, return it and write nothing (A4).
4. If occupied, walk `n+1, n+2, …` to the first free ordinal (bounded, A5), record the winner at
   `artifacts.verdicts[key]`, log one line, and return it.

Called from **three** sites — the two that hand a path to an agent, and the one that creates the
collision:

| Site | Why |
|---|---|
| `src/supervisor/tasks.ts:46-60` (`promptForTaskPhase`) | the task `verdict_path` render |
| `src/supervisor/deliver.ts:246-255` (`promptForRunPhase`) | the run `verdict_path` render |
| `src/cli.ts:372` (`cmdRewind`, before `saveRun`) | **the only site that closes BLOCKER 1** |

The first two compute `common`/`verdictPath` for *every* phase (`src/supervisor/tasks.ts:49-60`,
`src/supervisor/deliver.ts:250-255`), which is why step 1's guard is not optional.

`cmdRewind` reserves for the phase it is rewinding *to*, after the seed and the bump. It can: the
phase argument is already validated against the row table (`src/cli.ts:311-321`, A13), so
`taskRow`/`runRow` cannot throw; `task.checkout_path` is absolute
(`herdr-plugin-pipeline-20260918-…-v0qh` → `/Volumes/stein/.herdr/worktrees/…/fix-21-run-resolution`),
so the probe works from the orchestrator's cwd; and the run is saved at `src/cli.ts:372` immediately
after. A torn-down worktree makes `existsSync` false, which yields the default path — correct, since
there is no review there to lose.

### C5 — two documentation corrections

- `prompts/escalate.md:17` says rewind "resets the pass count for that phase". `src/cli.ts:353`
  clears the whole map. Corrected. This file is mine this batch; `README.md`'s equivalent line needs
  no change (A7).
- `src/supervisor/deliver.ts:91-94` asserts *"nothing ever populates `artifacts.verdicts` …
  and `adoptableArtifacts` filters by prefix instead"*. C4 makes the premise false while the
  conclusion (`:180`, pinned by `test/deliver.test.ts:287-295`) stays correct. Rewritten to say the
  filter is by prefix because verdicts are *written only on a collision*, so the `claimed` set still
  cannot enumerate them (MINOR 4).

## Data and control flow

Normal loop, unchanged from today's filenames. `MAX_PASSES` is `2` (`src/lib/config.ts:26`) and
`src/lib/machine.ts:121-123` escalates on `count >= maxPasses`, so a default loop produces two files:

| Step | `phase_entries['spec-review']` | `passes['spec-review']` | `n` | File |
|---|---|---|---|---|
| enter `spec-review` | 1 | 0 | `max(0,0)=0` | `issue-26-spec-review-0.md` |
| `BLOCKER` → `spec` → `spec-review` | 2 | 1 | `max(1,1)=1` | `…-1.md` |
| `BLOCKER` → `count 2 >= 2` | 2 | 2 | — | `escalated` |

`hpipe rewind <run> spec --task t1` (rewind to the producer row — the most common rewind in the
ledger, research `:141-144`):

| Step | `phase_entries['spec-review']` | `passes` | `n` | File |
|---|---|---|---|---|
| seed (`??=`, key present) | 2 | `{spec-review: 2}` → `{}` | — | — |
| bump target `spec`; C4 guard: `taskRow('spec').signal` is `artifact`, so **no reservation** | 2 | `{}` | — | — |
| enter `spec-review` | 3 | 0 | `max(2,0)=2` | `…-2.md` |

`hpipe rewind <run> spec-review --task t1` on a **post-change** record whose review cleared at pass 0:
the seed does not fire (`passes['spec-review']` is 0), `bumpEntries` takes the counter 1 → 2,
`n = max(1, 0) = 1`, C4's guard passes, `…-1.md` is free, nothing is recorded, and the success text
names it (A12).

The same command on a **legacy** record — BLOCKER 1's case, and the one `t4:spec-review` matches:
`phase_entries` is absent, the seed does not fire, `bumpEntries` gives 1, `n = max(0, 0) = 0`, and the
default `…-0.md` **is occupied by the earlier CLEAR review**. C4 step 4 walks to `…-1.md`, records
`artifacts.verdicts['spec-review-0'] = 'docs/superpowers/reviews/issue-4-spec-review-1.md'`, logs,
and names it. The supervisor's next `verdictFor` reads the same path through `artifactPathFor`'s
override branch (`src/supervisor/deliver.ts:102`). **This is the branch pass 0 left open.**

Run-level `branch-review` is the same flow with `run.artifacts.verdicts`, the
`${run.run_id}-${key}.md` prefix (`src/supervisor/deliver.ts:105-106`), and `runRow` in the guard.

## Error handling

| Condition | Behaviour |
|---|---|
| `phase_entries` absent on a record read from disk | `entriesFor` returns 0; the floor yields today's path. No migration, no throw. |
| `bumpEntries` or the C2 seed on a record whose `phase_entries` is absent | The map is created in place (`??= {}`) before either writes. Without this the seed throws `TypeError` on every legacy record and on `test/cli-commands.test.ts:228-239` (MAJOR 1). |
| `reserveVerdictPath` on a row that is not a verdict row | Returns `null` and writes nothing. The guard is `signal === 'verdict'`, because `ci`, `merge`, `close`, `implement` and the blocked rows all have no `artifact` and would otherwise pass an `artifact === undefined` test (MAJOR 2, `src/lib/phases.ts:122-124`). |
| Default verdict path already occupied | C4 redirects and logs once: `[pipeline] t1 (#26): spec-review-0 is occupied by <path> — writing to <new> instead`, in the shape of `logAmbiguous` (`src/supervisor/tasks.ts:196-199`). |
| C4's probe exhausts its bound (A5) | Returns the default path and logs the exhaustion. Degrades to today's behaviour rather than looping; the supervisor tick must not hang. |
| C4 in `cmdRewind` with a torn-down or missing worktree | `existsSync` is false, so the default path is used. There is no review there to lose. |
| `existsSync` on an unreadable directory | Returns `false`; the default is used. No throw, consistent with `src/supervisor/tasks.ts:244`. |
| `cmdRewind` given a phase in no row | Already rejected before C2/C4 run (`src/cli.ts:311-321`), so `taskRow`/`runRow` in the guard cannot throw (A13). |
| A reserved path recorded but the tick then fails | `src/cli.ts:372` and `src/supervisor/main.ts:242` both save after the write; a retried render returns the recorded path via C4 step 2. |

## Assumptions

Each is a behavioural choice, stated so the review can attack it.

**A1 — the ordinal counts phase entries, not review passes.** A `CLEAR` consumes a filename without
bumping `passes` (`src/lib/machine.ts:117-119`), so a pass-derived ordinal still collides on
clear-then-rewind. Rejecting A1 means accepting that hole.

**A2 — `phase_entries` is optional, not required.** Required would force an edit to every `mkTask`
and `mkRun` literal in the suite (`grep -l "passes: {}" test/*.ts | wc -l` → 12 files) and to both
constructors, for no behavioural gain; optional is what makes the floor in C3 meaningful and the
upgrade silent. The constructors (`src/lib/ledger.ts:24-41`, `src/cli.ts:216-233`) still initialise
it to `{}` so new runs are explicit.

**A3 — no `schema_version` bump.** The field is additive and absent-safe, and
`src/supervisor/main.ts:32-34` is a hard gate that refuses to advance anything that is not exactly
`2`.

**A4 — C4 records a path only when it redirects.** Recording every minted path would give
`artifacts.verdicts` a uniform writer, but it grows the ledger on every review and makes the on-disk
name depend on a write that used to be derivable. The derived default stays the norm; the record is
the exception that documents a collision. This is also what keeps C5's rewritten comment true.

**A5 — C4's probe is bounded at 64 ordinals.** `existsSync` terminates naturally, but this runs
inside the supervisor tick and an unbounded loop over a pathological reviews directory is the kind of
hang `src/supervisor/deliver.ts:130-137` already guards against for `Bun.spawn`.

**A6 — every direct `.phase =` assignment bumps, including `cmdAbort`'s terminal one.** A rule with
no exceptions is cheaper to keep true than four remembered sites; `done` carries no verdict, so the
extra key is inert.

**A7 — rewind's documented behaviour does not change, so `README.md:100` stays true.** `passes` is
still cleared wholesale. The success text at `src/cli.ts:373` gains a clause (A12) but loses nothing.
This is deliberate: `README.md` is sibling-owned this batch.

**A8 — `{{pass}}` in the prompts keeps meaning the escalation pass, not the file ordinal.** It is
rendered from `counterFor` (`src/supervisor/tasks.ts:54`, `src/supervisor/deliver.ts:252`) and is
what `MAX_PASSES` bounds. After a rewind a reviewer sees "pass 0" writing to `…-2.md`, which is the
honest reading: the budget restarted, the audit trail did not.

**A9 — the four `*-preserved.md` files stay where they are.** Renaming them back would re-open the
names this change stops anyone from reusing.

**A10 (rewritten after BLOCKER 1) — no in-place migration; legacy safety comes from C4, not from the
seed.** Pass 0 claimed "the floor in C3 plus the seed in C2 plus the backstop in C4 cover every legacy
case", which was false while C4 could not run on a rewind onto a review row. The claim is now: C3's
floor keeps legacy records rendering today's path, C2's seed handles the legacy cases it can see, and
**C4 at `cmdRewind` is the only thing that makes the rest safe** — because it asks the filesystem
rather than inferring from `passes`. `src/supervisor/main.ts:28-31` states this repo does no load-time
migration, and none is added.

**A11 (amended after MAJOR 1) — four existing tests stay green, *given* C2's lazy init.**
`test/deliver.test.ts:148-154` sets `run.passes['branch-review'] = 1` and expects a changed path: the
floor gives `max(-1, 1) = 1`. `test/deliver.test.ts:227-232` seeds `passes: { 'spec-review': 1 }` with
no `phase_entries` and expects `spec-review-1` — the clearest demonstration that the back-compat path
is what the suite already pins. `test/cli.test.ts:117-129` builds its run with `newRun()`, so A2's
constructor init covers it. `test/cli-commands.test.ts:228-239` builds a task from a raw literal
(`test/cli-commands.test.ts:35-47`) and is **the one that MAJOR 1 would have broken**; it stays green
only because `bumpEntries` and the seed create the map. Recorded because the research note asserted
all of these would have to move, and pass 0 asserted the fourth was safe for the wrong reason.

**A12 (new, answering MAJOR 3) — `cmdRewind` names the reserved path; `hpipe status` is not
taught the ordinal.** After a rewind onto a review row no prompt is rendered (BLOCKER 1, evidence 1),
so the reserved path reaches no agent on its own. `src/cli.ts:373` therefore gains it:

    rewound t1 to spec-review; counters cleared; next verdict → docs/superpowers/reviews/issue-26-spec-review-1.md

That is the moment the information is needed, by the person who just typed the command.
`src/lib/status.ts:102-105` keeps printing `pass N` from `counterFor`, which remains the escalation
budget (A8) — so **the residual gap is explicit: `hpipe status` does not show the file ordinal, and a
human who rewound in an earlier session discovers it with `ls docs/superpowers/reviews/`.** Naming
the path is free because C4 already computes it there; teaching `status.ts` is not, and is rejected
below.

**A13 — C4's row lookups rely on `cmdRewind`'s existing phase validation.** `src/cli.ts:311-321`
rejects a phase that is in no row before any of C2 or C4 runs, so `taskRow`/`runRow`
(`src/lib/phases.ts:77-81`, `:156-160`) cannot throw inside the guard. If that validation is ever
removed, C4 must gain its own throw-safe lookup — `runPhaseState` (`src/lib/ledger.ts:143-149`) is the
in-repo shape for that.

### Why this was not an `hpipe decide`

The review called MAJOR 3 "a call the implementer cannot make alone". I settled it here because the
BLOCKER 1 fix removes the cost from the conservative option: `cmdRewind` must compute the reserved
path anyway, so naming it in a string it already returns adds no scope, no new surface and nothing
irreversible. The two options that *would* need a human — changing `src/lib/status.ts`'s contract, or
making `cmdRewind` deliver prompts — are both rejected below with reasons, and A12 states the residual
gap plainly rather than burying it. If the human disagrees, the PR review is a cheaper place to say so
than a mid-phase interrupt.

## Testing strategy

TDD: the red test first, run, then the minimum code, run again.

**The red test** (`test/cli-commands.test.ts`, beside the rewind tests at `:228-239` — *not*
`test/deliver.test.ts`, which does not import `cmdRewind`, `test/deliver.test.ts:1-10`). It is BLOCKER
1's case, and it compiles and runs red against today's code because it touches no new type:

    test('a rewind onto a review row does not re-issue a path an earlier review holds', …)
      // task in spec-review, checkout containing issue-N-spec-review-0.md
      // cmdRewind(… phase: 'spec-review', taskId: 't1')
      // expect(artifactPathFor(run, task)).not.toBe('docs/superpowers/reviews/issue-N-spec-review-0.md')

Today `cmdRewind` reserves nothing and `artifactPathFor` returns the occupied path, so it fails.

**Unit, `src/lib/machine.ts`** (`test/machine-task.test.ts`, `test/machine-run.test.ts`, beside the
`bumpCounter` tests at `test/machine-task.test.ts:143-147`):

- `entriesFor` reads 0 on a record with no `phase_entries`; `bumpEntries` creates the map.
- `enterRunPhase`/`enterTaskPhase` bump the phase entered, and only that phase.
- No transition, including `onBlocker` re-entry, ever decrements it.

**Unit, `src/lib/verdict-path.ts`** (new `test/verdict-path.test.ts`, modelled on
`test/gating.test.ts` as the tests for a lib module used by both entry points):

- The ordinal sequence over a default loop is `0, 1` (`MAX_PASSES` is 2); a trace passing
  `maxPasses: 3` explicitly yields `0, 1, 2`.
- A record with no `phase_entries` and `passes: {spec-review: 1}` renders `…-1.md` (back-compat).
- `reserveVerdictPath` returns `null` and writes nothing for `research`, `spec`, `plan`, `ci`,
  `merge`, `close` and `implement` — the guard, with `ci` named explicitly (MAJOR 2).
- It leaves the record untouched when the default is free (A4).
- It redirects around an occupied file, records it under the entry key, and a second call returns the
  recorded path rather than probing again (C4 step 2).
- It stops at the bound and returns the default (A5).

**Unit, `src/cli.ts`** (`test/cli-commands.test.ts`):

- `cmdRewind` bumps the target phase and leaves `passes` cleared (`:228-239` still green).
- It seeds `phase_entries` from spent `passes` on a record that has none, does not overwrite one that
  does, and **does not throw on a record whose `phase_entries` is absent** (MAJOR 1).
- It reserves and reports the path when rewinding onto a review row, and reserves nothing when
  rewinding to `spec` (A12, MAJOR 2).
- `cmdResume` bumps the phase it returns to.

**Unit, `src/supervisor/deliver.ts`** (`test/deliver.test.ts`): the run-level `branch-review` twin of
the reservation, with the `run_id` prefix.

Filesystem tests use `tempDir`/`commitIn` from `test/helpers/git-worktree.ts`, already used by
`test/deliver.test.ts:255-300`.

**Regression, unchanged:** the four tests in A11, plus `test/deliver.test.ts:287-295`
(`adoptableArtifacts` still excludes the reviews prefix) and `test/prompts.test.ts` (the declared
prompt set and review-trailer contract, which C5 touches).

**Gates:** `bun test` and `bun run typecheck` both green before push, with the measured numbers quoted
in the PR body. Baseline to beat: 503 pass, 0 fail, 1265 expect() calls, 34 files; `tsc --noEmit`
exit 0. CI is a PR-title lint only (`.github/workflows/pr-title-lint.yml`), so these are run by hand.

**Live verification**, required by `.claude/agents/plugin-dev.md` because this changes delivery. The
unit suite uses injected fakes and has passed clean over real defects twice, so it cannot settle this.
The installed plugin is pinned to a GitHub commit (`herdr plugin list` → `…@be181757…`), so this code
is not live until the release lands. After it does:

1. On a task in `spec-review` with `…-spec-review-0.md` committed, `hpipe rewind <run> spec --task <t>`,
   then watch the pane for the re-rendered prompt and confirm `{{verdict_path}}` names `…-2.md`, with
   `-0` and `-1` untouched in `git status`.
2. `hpipe rewind <run> spec-review --task <t>` directly onto the row, on a task whose last verdict was
   `CLEAR`. Confirm the command's own output names the reserved path, that `artifacts.verdicts` in the
   ledger carries it, and that no committed review changed. **This is BLOCKER 1's case and the one no
   unit test proves end to end**, because it depends on a real `cmdRewind` process writing a ledger the
   supervisor then reads.
3. Confirm `hpipe status` still prints `pass N` from the escalation budget and not the ordinal — A12's
   residual gap, observed rather than asserted.

Any difference between this runbook and what is observed is a finding, not a test to make pass.

## Rejected alternatives

**Refuse to write an occupied path and stop.** The issue's second direction, taken literally. It
deadlocks the row: `isFresh` is measured against the re-stamped `phase_entered_at`
(`src/supervisor/main.ts:196`, `src/cli.ts:355`), so nothing but an overwrite advances it. C4
redirects rather than refuses.

**Stop clearing `passes` at rewind; give escalation a separate resettable floor.** Inverts which
counter resets and needs no path change. Rejected: it still collides on clear-then-rewind (A1), and it
changes what `hpipe rewind` does — the one thing `README.md:100`, a sibling's file, documents.

**Derive the ordinal by counting `run.history`.** Retroactively exact and needs no new field, but
`src/actions/claim.ts:32` writes `to: run.phase` for a non-transition and
`src/lib/orchestrator.ts:56-59` writes a pane id into `to`. The ordinal would move on an orchestrator
rebind.

**Put the phase-entry timestamp in the filename.** Collision-free by construction, but
`issue-26-spec-review-1758243011947.md` destroys what the current names do well: `prompts/spec.md:21`,
`prompts/plan.md:18` and `prompts/implement.md:15` all tell a worker to find "the review for this
issue under `docs/superpowers/reviews/`", and a human reads the ordinal to know which pass they are
looking at.

**Teach `hpipe status` the file ordinal** (the review's MAJOR 3 option (a), in full). Rejected: it
contradicts A8, adds a second number to a line whose `pass N` already means the escalation budget
(`src/lib/status.ts:102-105`), and solves at a distance what A12 solves at the moment of the command.

**Make `cmdRewind` re-deliver the review row's prompt** (option (b)). Rejected: `cmdRewind` holds no
`Herdr` client and sends nothing today, so this turns a ledger edit into pane I/O — a different
command, and arguably #22's scope. The supervisor, not the CLI, owns delivery.
