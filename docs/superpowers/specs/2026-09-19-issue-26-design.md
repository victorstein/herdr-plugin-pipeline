# A verdict path that is assigned once and never re-derived — design (#26)

Pass 2. Written against this worktree at `6688ffc` (branch `fix/26-verdict-overwrite`), building on
`docs/superpowers/research/2026-09-19-issue-26-research.md`, answering
`docs/superpowers/reviews/issue-26-spec-review-1.md`, and **governed by the `Ruling` section added to
issue #26 on 2026-09-19** after the two-pass escalation. Every claim about current behaviour carries
a `file:line` or the command that produced it.

**Modelled on** `src/lib/gating.ts` for a pure `src/lib/` module imported by both `src/cli.ts` (`:5`)
and `src/supervisor/tasks.ts` (`:4`) — the shape the reserver needs; `src/lib/predicates.ts:1` for a
`src/lib/` module that touches the filesystem; the artifact-adoption write-back at
`src/supervisor/tasks.ts:264-267` for recording a resolved artifact path onto the record so later
prompts cite it and the resolution is idempotent — **which is now the whole design, applied to the
verdict slot instead of the artifact slot**; `logAmbiguous` (`src/supervisor/tasks.ts:184-200`) for a
once-per-entry diagnostic; and `test/gating.test.ts` for a lib-module test file. No new pattern is
introduced.

## What the ruling changed, and what it deleted

The ruling upheld pass-1 BLOCKER 1 and replaced the mechanism. Passes 0 and 1 both keyed the filename
on a *count*; the ruling's instruction is **"Stop deriving the path; assign it once and record it."**
Applied here, that deletes more than it adds:

| Pass-1 component | Status under the ruling |
|---|---|
| `phase_entries` field on `Task`/`Run` (pass-1 C1) | **Deleted.** No `src/lib/types.ts` change at all. |
| `bumpEntries` in `enterRunPhase`/`enterTaskPhase` | **Deleted.** "Do not bump on `enterTaskPhase` generally." |
| Bumps at the four direct `.phase =` sites (pass-1 C2) | **Deleted**, and with them assumption A6. |
| The `passes`-derived seed in `cmdRewind` | **Deleted**, and with it pass-1's MINOR 2 escalation *and* the pass-1 MINOR that it did not compile. |
| `Math.max(entriesFor - 1, counterFor)` (pass-1 C3) | **Deleted** as the mechanism; survives only as the legacy read fallback (C4), which is the one derivation left. |
| `src/lib/verdict-path.ts` + the reservation (pass-1 C4) | **Kept and promoted** from backstop to the whole mechanism. |
| Reservation in `cmdRewind` | **Kept** (A3). |

Pass-1 BLOCKER 1 is answered by construction rather than by a rule: a resume re-enters a phase but
renders no prompt, and a path is allocated only where a prompt is rendered, so nothing moves under a
live agent. I verified the resume path the reviewer named: `src/supervisor/tasks.ts:326-341` renders
`answer.md` and sends it, then calls `enterTaskPhase(run, task, resumeTo, …)` at `:341` — it never
reaches `promptForTaskPhase` (`:175`, inside `advanceTasks`, which runs earlier at
`src/supervisor/main.ts:185`). `grep -n "verdict_path" prompts/answer.md` returns nothing, so the
answered agent is holding the path it was originally handed, and under this design that is still the
recorded path. `cmdResume` (`src/cli.ts:500-516`) sends nothing at all and is inert the same way.

**MAJOR 1 and MAJOR 2** are answered by C1: one exported function spells a verdict filename, used by
the reserver and the reader, and the relative/absolute contract is stated once and enforced by the
signature (A6, A7).

**The pass-1 MINOR that turned out to be a second instance of this bug.** The reviewer noted that
"normal loop, unchanged from today's filenames" is false, and it is worth promoting out of the MINORs
because **issue #26 has a second instance that neither the issue nor the research note names, and it
involves no rewind at all**:

    src/lib/phases.ts:111-116
      { phase: 'pr-review-intent',  onClear: 'pr-review-quality', onBlocker: 'implement',
        counter: 'pr-review-intent' },
      { phase: 'pr-review-quality', onClear: 'ci', onBlocker: 'implement',
        counter: 'pr-review-quality' },

`pr-review-intent` clears at counter 0 (file `…-pr-review-intent-0.md`); `pr-review-quality` then
returns `BLOCKER`, which bumps **its own** counter and sends the task to `implement`
(`src/lib/machine.ts:120-126`); `implement` clears back to `pr-review-intent`, whose counter is still
0 — so the second intent review is handed `…-pr-review-intent-0.md` again and overwrites the first.
No `hpipe rewind` is involved. Every issue on disk has exactly one file of each name
(`ls docs/superpowers/reviews/ | grep pr-review` → 12 files, 6 issues), which is consistent with the
loop never having fired *or* with a silent clobber; I am not claiming an observed loss, only a
reachable one. This design closes it without a special case, because the reserver asks what is
already taken rather than what the counter says. A counter-based fix closes it only by accident.

## Problem

The verdict path is derived, on every read, from a counter that `hpipe rewind` clears.

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

**Why "refuse to overwrite" alone deadlocks.** `verdictFor` gates on
`isFresh(absolute, t.phase_entered_at)` (`src/supervisor/main.ts:193-199`,
`src/lib/predicates.ts:10-20`) and `cmdRewind` re-stamps `phase_entered_at` (`src/cli.ts:355`,
`:361`). After a rewind the occupant reads stale, so the row only advances when it is overwritten.
A refusal must hand over a different path, which is what reservation does.

## Goal

Two different reviews never share a filename, and the path a live agent was handed never moves under
it. Both must hold across `hpipe rewind`, across a resume, and on the records already on disk.

## Non-goals

- **No new persisted field, and no `schema_version` bump.** `artifacts.verdicts` already exists on
  both records (`src/lib/types.ts:83`, `:100`) and is already initialised by both constructors
  (`src/lib/ledger.ts:35`, `src/cli.ts:229`). `isCurrentSchemaRun` stays satisfied
  (`src/supervisor/main.ts:32-34`).
- **No change to `passes`, `counterFor`, `bumpCounter` or any phase-transition function.**
  `src/lib/machine.ts` is not edited. `passes` remains the escalation budget
  (`src/lib/machine.ts:120-123`, `:78-81`) and rewind keeps clearing it, so `README.md:100` stays
  true (A8).
- No change to `hpipe status` (A5), and no rename of the four `*-preserved.md` files.
- No edit to `README.md`, `prompts/dispatch.md`, `src/hooks/`, `src/lib/config.ts` or
  `test/config.test.ts` — sibling-owned. Per the ruling, **my `src/cli.ts` work is confined to
  `cmdRewind`**; t2 holds the `cmdTask` header lines around `:255-269` and rebases onto my merge.
- Not #22's broader rewind validation; the phase-argument check already landed at
  `src/cli.ts:311-321`, and C3 depends on it (A9).

## Architecture

Four changes. There is no counter anywhere in them.

### C1 (load-bearing) — `src/lib/verdict-path.ts`: one speller, one reader, one reserver

`src/cli.ts` cannot reach `src/supervisor/`, which is why this is a `src/lib/` module:

    $ grep -rn "supervisor/" src/ | grep -v "^src/supervisor/"
    (no output)

`src/cli.ts:2-21` imports only from `./lib/`; `src/supervisor/deliver.ts:2-10` imports only from
`../lib/`. `src/lib/gating.ts` is the existing module imported by both sides.

    export const REVIEWS_DIR = 'docs/superpowers/reviews'   // moved from src/supervisor/deliver.ts:95

    /** The ONE place a verdict filename is spelled. Always REPO-RELATIVE. */
    export function verdictFilename(prefix: string, phase: string, ordinal: number): string

    /** The recorded path for this phase: the highest ordinal present. REPO-RELATIVE, or null. */
    export function recordedVerdict(verdicts: Record<string, string>, phase: string): string | null

    /** Allocates, records and returns the next free path. REPO-RELATIVE. */
    export function reserveVerdict(
      verdicts: Record<string, string>, prefix: string, phase: string, base: string,
    ): string

`prefix` is `issue-${task.issue}` for a task and `run.run_id` for a run — the two spellings currently
inline at `src/supervisor/deliver.ts:103` and `:106`, which is the duplication pass-1 MAJOR 1 flagged.
`base` is the absolute checkout the probe resolves against, and is used for nothing else.

`reserveVerdict` picks the lowest `ordinal` for which **both** are true:

1. `verdicts[`${phase}-${ordinal}`]` is absent — the map is authoritative and, because earlier keys
   are never removed, a path once issued can never be re-issued, which is the monotonicity the ruling
   requires across `hpipe rewind`;
2. `existsSync(join(base, verdictFilename(…)))` is false — ground truth for files the map does not
   know about: every record written before this change, and any human `git mv`.

It then writes `verdicts[`${phase}-${ordinal}`] = verdictFilename(…)` and returns it. The write is
what makes it idempotent for the reader; it is **not** idempotent across two calls in one phase, which
is why C2 and C3 pin exactly where it may be called (A2).

### C2 — reserve at prompt-render time, and read everywhere else

`artifactPathFor` (`src/supervisor/deliver.ts:97-107`) stops deriving and becomes a pure read:

    if (task) {
      const row = taskRow(task.phase)
      if (row.artifact) return task.artifacts[row.artifact]        // unchanged
      if (row.signal !== 'verdict') return <today's derivation>     // unchanged, see A4
      return recordedVerdict(task.artifacts.verdicts, task.phase)
        ?? join(REVIEWS_DIR, `issue-${task.issue}-${task.phase}-${counterFor(task, task.phase)}.md`)
    }

The `??` branch is **the only derivation left in the design** and exists solely for a record in flight
at upgrade, whose map is empty and whose agent was already handed today's path (A1). Every reader —
`verdictFor` on every tick (`src/supervisor/main.ts:193-198`), `absoluteArtifactPath`
(`src/supervisor/deliver.ts:110-115`), the `{{verdict_path}}` renders — goes through this one function
and therefore sees the reserved path.

`reserveVerdict` is called from exactly the two sites that hand a path to an agent:

| Site | Guard |
|---|---|
| `src/supervisor/tasks.ts:46-60` (`promptForTaskPhase`) | `taskRow(task.phase).signal === 'verdict'` |
| `src/supervisor/deliver.ts:246-255` (`promptForRunPhase`) | `runRow(run.phase).signal === 'verdict'` |

Both build their `common` object **before** the `switch` (`src/supervisor/tasks.ts:49-60`,
`src/supervisor/deliver.ts:250-255`), so `verdict_path` is computed for every phase and the guard is
not optional — pass-1 MAJOR 2. The guard tests `signal`, not `artifact === undefined`: `ci`
(`src/lib/phases.ts:122-124`), `merge`, `close`, `implement` and the blocked rows all lack an
`artifact` and would otherwise qualify.

`promptForTaskPhase` is reached only on a real transition (`src/supervisor/tasks.ts:171-178` returns
early when `advanceTask` yields nothing or the phase is unchanged), so one transition into a review
row allocates exactly one path.

### C3 — `cmdRewind` reserves when it rewinds *onto* a verdict row

This is the one allocation outside a prompt render, and it is deliberate. A rewind onto a review row
renders no prompt — `advanceTask` returns `null` for a row whose verdict file is not fresh
(`src/supervisor/tasks.ts:270-275`, `src/lib/machine.ts:147-156`), so `src/supervisor/tasks.ts:175` is
never reached — yet the human has just commissioned a new review. The ruling's own test applies:
*"it must be incremented where a new review is commissioned, not where a phase is re-entered."*
Rewinding onto `spec-review` commissions one; rewinding to `spec` does not, and reserves nothing,
because the `spec → spec-review` transition that follows will render a prompt and reserve then (A2).

`cmdRewind` has what it needs at `src/cli.ts:372`: the phase argument is already validated against the
row table (`src/cli.ts:311-321`, A9) so `taskRow`/`runRow` cannot throw; `task.checkout_path` is
absolute (verified on the live ledger — `herdr-plugin-pipeline-20260918-…-v0qh` task `t1` →
`/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-21-run-resolution`), so the probe resolves
from the orchestrator's cwd; and `saveRun` at `src/cli.ts:372` persists the record immediately after.

Its success text (`src/cli.ts:373`) names the reserved path, because nothing else will (A5).

### C4 — two documentation corrections

- `prompts/escalate.md:17` says rewind "resets the pass count for that phase". `src/cli.ts:353`
  clears the whole map. Corrected. `README.md`'s equivalent line is sibling-owned and needs no change
  (A8).
- `src/supervisor/deliver.ts:91-94` asserts *"nothing ever populates `artifacts.verdicts` —
  `artifactPathFor` reads it and no writer exists — so the `claimed` set cannot exclude them and
  `adoptableArtifacts` filters by prefix instead."* This design is that writer. The conclusion still
  holds — `adoptableArtifacts` filters by prefix (`:180`, pinned by `test/deliver.test.ts:287-295`) —
  but the reason changes: verdict paths are now recorded, yet `adoptableArtifacts` is called for
  artifact rows only (`src/supervisor/tasks.ts:254`), so the prefix filter is what keeps a review out
  of an artifact slot. Rewritten to say that.

## Data and control flow

Values in `artifacts.verdicts` are **repo-relative**; only `absoluteArtifactPath`
(`src/supervisor/deliver.ts:110-115`) and `reserveVerdict`'s probe join them to a base (A7).

Normal loop. `MAX_PASSES` is 2 (`src/lib/config.ts:26`) and `src/lib/machine.ts:121-123` escalates on
`count >= maxPasses`, so a default spec loop commissions two reviews:

| Event | Reserve? | `verdicts` after | Path |
|---|---|---|---|
| `spec → spec-review`, prompt renders | yes | `{spec-review-0: …-0.md}` | `…-spec-review-0.md` |
| `BLOCKER` → `spec` (no render for the review row) | no | unchanged | — |
| `spec → spec-review`, prompt renders | yes | `+ {spec-review-1: …-1.md}` | `…-spec-review-1.md` |
| `BLOCKER` → `count 2 >= 2` → `escalated` | no | unchanged | — |

`hpipe rewind <run> spec --task t1` — the most common rewind in the ledger (research `:141-144`):
`taskRow('spec').signal` is `artifact`, so C3 reserves nothing. `passes` is cleared as today. The
`spec → spec-review` transition then renders and reserves: ordinals 0 and 1 are in the map, so it
takes **2**. The clobber is gone, and it is the map — not a counter — that prevents it.

`hpipe rewind <run> spec-review --task t1`, **post-change**: C3 reserves. Ordinals 0 and 1 are taken,
so `…-2.md`, recorded and named in the command's output.

`hpipe rewind <run> spec-review --task t4`, **legacy** — the case that made pass 1 a BLOCKER and the
one `t4:spec-review` matches (research `:144`): the map is empty, so condition 1 admits ordinal 0, but
`existsSync` finds the earlier CLEAR review at `…-0.md` and condition 2 rejects it. Ordinal 1 is free
on both counts, so `verdicts['spec-review-1'] = '…-spec-review-1.md'` is recorded and named. The
supervisor's next `verdictFor` reads it through `recordedVerdict`. **No counter could have known this;
the filesystem did.**

**A decision answered on a review row** (pass-1 BLOCKER 1): `deliverPendingAnswers` sends `answer.md`
and calls `enterTaskPhase` (`src/supervisor/tasks.ts:326-341`). No `promptForTaskPhase`, so no
reservation; `recordedVerdict` returns the same path the agent is already writing to. Inert by
construction. `hpipe abort` + `hpipe resume` onto `branch-review` (`src/cli.ts:500-516`) is inert the
same way.

Run-level `branch-review` follows the same flow against `run.artifacts.verdicts`, the `run.run_id`
prefix, and `run.repo_root` as the base.

## Error handling

| Condition | Behaviour |
|---|---|
| Nothing recorded for a verdict row (a record in flight at upgrade) | `recordedVerdict` returns `null`; C2's `??` yields today's `counterFor`-derived path, so the agent already writing it is undisturbed (A1). |
| `reserveVerdict` on a row that is not a verdict row | Never called: both call sites guard on `signal === 'verdict'`. `ci`, `merge`, `close` and `implement` have no `artifact` and would pass an `artifact === undefined` test (`src/lib/phases.ts:122-124`), which is why the guard is on `signal`. |
| A path is occupied on disk but absent from the map | Condition 2 rejects the ordinal and the walk continues. This is the legacy and `git mv` case, and the reason the probe exists at all. |
| A path is in the map but absent from disk (the agent has not written yet) | Condition 1 rejects the ordinal. The map alone prevents re-issue, so a reservation made and not yet fulfilled is never handed to a second agent. |
| `task.checkout_path` is `null` | `absoluteArtifactPath` already falls back to `run.repo_root` (`src/supervisor/deliver.ts:113`); `reserveVerdict`'s `base` uses the same expression, so the probe never resolves against the process cwd. |
| `existsSync` on a missing or unreadable directory (a torn-down worktree) | Returns `false`, so the ordinal is accepted. There is no review there to lose. |
| The probe exhausts its bound (A10) | Records nothing, returns ordinal 0's path, and logs the exhaustion. Degrades to today's behaviour rather than looping; the supervisor tick must not hang. |
| `cmdRewind` given a phase in no row | Rejected before C3 runs (`src/cli.ts:311-321`), so the guard's `taskRow`/`runRow` cannot throw (A9). |
| A reservation is written but the process then fails | `src/cli.ts:372` and `src/supervisor/main.ts:242` both `saveRun` after the write. A lost tick re-reads the record and `recordedVerdict` returns the reservation; it is not re-allocated. |

## Assumptions

Each is a behavioural choice, stated so the review can attack it.

**A1 — the legacy fallback keeps today's derivation, and is the only derivation left.** A record
mid-review at upgrade has an empty map and an agent already writing `…-${counterFor}.md`. Returning
`null` instead would make `verdictFor` unsatisfiable and deadlock every in-flight review. The branch
becomes unreachable for a record once its row next renders a prompt; it is not removed, because a
`hpipe rewind` onto a legacy row is still reachable indefinitely.

**A2 — a path is allocated at exactly two kinds of moment: a rendered verdict prompt, and a rewind
onto a verdict row.** Nothing else allocates, which is what makes a resume inert. `reserveVerdict` is
deliberately *not* idempotent — calling it twice for one phase entry burns an ordinal — so the guard
is "call it only here", enforced by there being only three call sites, not by the function.

**A3 — `cmdRewind` allocating is a deliberate reading of the ruling's "reserve at prompt-render time,
and only then".** A rewind onto a review row renders no prompt, so a literal reading leaves the
original defect open on exactly the command the issue is about. The ruling's own criterion — *"where a
new review is commissioned"* — resolves it, and the ruling separately says my `src/cli.ts` work stays
in `cmdRewind`. This is the assumption most worth attacking.

**A4 — non-verdict, non-artifact rows keep today's meaningless derived path.** `ci`, `merge`, `close`,
`implement` and the blocked rows currently resolve to `issue-N-<phase>-0.md`
(`src/supervisor/deliver.ts:101-103`), which no prompt consumes — `grep -n "verdict_path" prompts/`
lists only the five review prompts. Changing it to `null` is tempting but is scope this issue did not
ask for and would alter what `absoluteArtifactPath` returns for six rows.

**A5 — `cmdRewind` names the reserved path; `hpipe status` is not taught it.** After a rewind onto a
review row no prompt is rendered, so `src/cli.ts:373` is the only place the human learns the path:

    rewound t1 to spec-review; counters cleared; next verdict → docs/superpowers/reviews/issue-26-spec-review-2.md

`src/lib/status.ts:102-105` keeps printing `pass N` from `counterFor`, which remains the escalation
budget. **The residual gap is explicit:** `hpipe status` does not show the file ordinal, and a human
who rewound in an earlier session finds it in the ledger or with `ls`.

**A6 — one function spells a verdict filename.** `verdictFilename` is used by `reserveVerdict` and by
C2's fallback, and `REVIEWS_DIR` moves out of `src/supervisor/deliver.ts:95` so there is no second
copy. `adoptableArtifacts` (`:180`) imports it rather than keeping its own.

**A7 — every value in `artifacts.verdicts` is repo-relative.** `verdictFilename` returns relative,
`reserveVerdict` records what it returns, `recordedVerdict` returns it unchanged, and
`absoluteArtifactPath` is the only joiner. Pass-1 MAJOR 2 was the mixed contract; the signature now
carries it, and `join('/w', '/abs')` → `/w/abs` is the corruption this prevents.

**A8 — rewind's documented behaviour does not change, so `README.md:100` stays true.** `passes` is
still cleared wholesale; the success text gains a clause and loses nothing.

**A9 — C3's row lookups rely on `cmdRewind`'s existing phase validation** (`src/cli.ts:311-321`). If
that is ever removed, C3 needs a throw-safe lookup; `runPhaseState` (`src/lib/ledger.ts:143-149`) is
the in-repo shape.

**A10 — the probe is bounded at 64 ordinals.** It terminates naturally, but it runs inside the
supervisor tick, and `src/supervisor/deliver.ts:130-137` already guards that loop against a
synchronous throw for the same reason.

**A11 — the map is never pruned.** `artifacts.verdicts` grows by one entry per review commissioned —
at most a handful per task — and pruning is what would let an ordinal be re-issued.

**A12 — the second instance (`pr-review-intent` re-entry) is fixed silently, and the PR says so.**
It is in scope because it is the same defect with the same blast radius, and the fix costs nothing
extra. It is called out here and belongs in the PR body, because a reviewer comparing the issue text
to the diff would otherwise find behaviour the issue never asked for.

## Testing strategy

TDD: the red test first, run it, then the minimum code, run it again.

**The red test** — `test/cli-commands.test.ts`, beside the rewind tests at `:228-239`. It is the
legacy rewind-onto-a-review-row case, it uses only APIs that exist today, and it fails today because
`cmdRewind` reserves nothing and `artifactPathFor` re-derives:

    test('a rewind onto a review row does not re-issue a path an earlier review holds', …)
      // task in spec-review, checkout containing issue-1-spec-review-0.md, verdicts: {}
      // cmdRewind(… phase: 'spec-review', taskId: 't1')
      // expect(artifactPathFor(run, task)).not.toBe('docs/superpowers/reviews/issue-1-spec-review-0.md')

**Unit — `src/lib/verdict-path.ts`** (new `test/verdict-path.test.ts`, modelled on
`test/gating.test.ts`):

- `verdictFilename` returns a repo-relative path for both prefixes (A6, A7).
- `recordedVerdict` returns the highest ordinal recorded, `null` on an empty map.
- `reserveVerdict` skips an ordinal held in the map, skips one held on disk but absent from the map
  (the legacy case), and skips one held by both.
- **The contract test:** after `reserveVerdict`, `recordedVerdict` returns exactly what it returned.
- Two reservations for one phase yield different paths and both keys survive (A11).
- The bound stops the walk and returns ordinal 0 (A10).

**Unit — `src/supervisor/deliver.ts`** (`test/deliver.test.ts`):

- A verdict row with an empty map falls back to today's `counterFor` path (A1) — this keeps
  `test/deliver.test.ts:148-154` and `:227-232` green unchanged.
- A verdict row with a recorded path returns it and ignores `passes` entirely.
- `test/deliver.test.ts:156-161` seeds `verdicts['branch-review-0']` and expects it to win; under
  `recordedVerdict` it still does, because it is the highest ordinal present.
- The run-level `branch-review` reservation uses the `run_id` prefix and `run.repo_root`.

**Unit — `src/supervisor/tasks.ts`** (`test/tasks.test.ts`): `test/tasks.test.ts:301-312` asserts that
a design row's prompt names the path its own predicate will check, over `research`, `spec`,
`spec-review`, `plan` and `plan-review`. It reads `absoluteArtifactPath` **before** calling
`promptForTaskPhase`, so it now spans a reservation. It passes — the checkout in the fixture does not
exist, so the probe accepts ordinal 0 and the fallback also yields ordinal 0 — but it passes by
coincidence of ordering. A new test makes the invariant explicit rather than incidental: render the
prompt first, then assert `absoluteArtifactPath` equals the path the prompt names. (Pass 1 omitted
this test from A11; the pass-1 review was right to flag it.)

**Unit — `src/cli.ts`** (`test/cli-commands.test.ts`): `cmdRewind` reserves and reports when the
target is a verdict row; reserves nothing when the target is `spec`; still clears `passes`
(`:228-239` green); and does not throw on a record whose `verdicts` map is empty.

Filesystem tests use `tempDir`/`commitIn` from `test/helpers/git-worktree.ts`, as
`test/deliver.test.ts:255-300` already does.

**Regression, unchanged:** `test/deliver.test.ts:287-295` (`adoptableArtifacts` still excludes the
reviews prefix, now importing `REVIEWS_DIR`), and `test/prompts.test.ts` (the declared prompt set and
review-trailer contract, which C4 touches).

**Gates:** `bun test` and `bun run typecheck` green before push, with the measured numbers quoted in
the PR body. Baseline to beat: 503 pass, 0 fail, 1265 expect() calls, 34 files; `tsc --noEmit` exit 0.
CI is a PR-title lint only (`.github/workflows/pr-title-lint.yml`), so these are run by hand.

**Live verification**, required by `.claude/agents/plugin-dev.md` because this changes delivery. The
unit suite uses injected fakes and has passed clean over real defects twice. The installed plugin is
pinned to a GitHub commit (`herdr plugin list` → `…@be181757…`), so this code is not live until the
release lands. After it does:

1. `hpipe rewind <run> spec --task <t>` on a task with `…-spec-review-0.md` and `…-1.md` committed.
   Watch the pane for the re-rendered prompt and confirm `{{verdict_path}}` names `…-2.md`, that
   `artifacts.verdicts` in the ledger carries all three keys, and that `-0` and `-1` are untouched in
   `git status`.
2. `hpipe rewind <run> spec-review --task <t>` directly onto the row, on a task whose last verdict was
   `CLEAR`. Confirm the command's own output names the reserved path and that the ledger agrees. **This
   is the case no unit test proves end to end**, because it needs a real `cmdRewind` process writing a
   ledger the supervisor then reads.
3. Raise a decision on a task sitting in `spec-review`, answer it with `hpipe answer`, and confirm the
   path in `artifacts.verdicts` **does not move** and the worker resumes onto the same file. This is
   pass-1 BLOCKER 1, and it is the one the ruling exists to prevent.
4. Confirm `hpipe status` still prints `pass N` from the escalation budget and not the ordinal (A5).

Any difference between this runbook and what is observed is a finding, not a test to make pass.

## Rejected alternatives

**Key the filename on a count of phase entries** (passes 0 and 1). Rejected by the ruling and by
pass-1 BLOCKER 1: `enterTaskPhase` has callers that are resumes, so the watched path moves under a
live agent — this issue's own bug in a new form.

**Key it on `passes`/`counterFor` alone** (today). The original defect: `hpipe rewind` clears the map
(`src/cli.ts:353`, `:360`) and the name regresses. It also misses the `pr-review-intent` re-entry,
which no rewind is involved in.

**Refuse to write an occupied path and stop.** Deadlocks the row, because `isFresh` is measured
against the re-stamped `phase_entered_at` and only an overwrite advances it.

**Reserve on every read instead of at render.** Makes `artifactPathFor` mutate, and it is called on
every tick from `verdictFor` (`src/supervisor/main.ts:193-198`) — the path would advance once per
second.

**Teach `hpipe status` the file ordinal.** Adds a second number to a line whose `pass N` already means
the escalation budget (`src/lib/status.ts:102-105`), and solves at a distance what A5 solves at the
moment of the command.

**Make `cmdRewind` re-deliver the review row's prompt.** `cmdRewind` holds no `Herdr` client and sends
nothing today; this turns a ledger edit into pane I/O, which is the supervisor's job and arguably
#22's scope.
