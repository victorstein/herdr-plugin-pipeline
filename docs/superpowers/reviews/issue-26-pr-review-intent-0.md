# PR #52 — stage 1, intent review (pass 0)

Reviewed `fix/26-verdict-overwrite` at `8232db9` against issue #26 (text + `Ruling` +
*"Observed live, 2026-09-19"*), `docs/superpowers/specs/2026-09-19-issue-26-design.md` (pass 3, cleared
by `issue-26-spec-review-1.md`) and `docs/superpowers/plans/2026-09-19-issue-26-plan.md` (cleared by
`issue-26-plan-review-0.md`). Code diff is 149 insertions across six files; the rest of the 3608 lines
is the research/spec/plan/review trail.

## What I checked and could not break

**The gates match the PR body exactly, measured here, not read off the body.**

    $ bun test        → 525 pass, 0 fail, 1316 expect() calls, Ran 525 tests across 35 files
    $ bun run typecheck → tsc --noEmit, exit 0

The claimed baseline is also real. I extracted `main` with `git archive main | tar -x` into a scratch
dir and ran the suite there: **503 pass, 0 fail, 1265 expect() calls, 34 files** — the PR body's
figures to the digit. This repo's branch review has twice caught a PR misreporting its own numbers;
this one does not.

**`verdict_seq` advances only in `reserveVerdict`.** By grep, not by the PR body:

    $ grep -rn "verdict_seq" src/
    src/lib/types.ts:96,127        (declarations)
    src/lib/verdict-path.ts:41     read  (verdictFor)
    src/lib/verdict-path.ts:66     read  (reserveVerdict)
    src/lib/verdict-path.ts:89-90  the ONLY writes

Nothing decrements it, nothing clears it, and `cmdRewind` — which clears `task.passes`
(`src/cli.ts:360`) and `run.passes` (`src/cli.ts:370`) — does not touch it. That is C1's
load-bearing property, and `test/cli-commands.test.ts:642-665` pins it against exactly the
implementation that would have destroyed it (a *seeded* `verdict_seq`, so a `clear` cannot pass by
satisfying `toBeUndefined()`).

**A resume cannot move the path — traced in the code, not taken from the body.** The two resume
routes the ruling names:

- A decision answered on a review row: `deliverPendingAnswers` (`src/supervisor/tasks.ts:320-350`)
  renders `prompts/answer.md` and calls `enterTaskPhase` at `:347`. It never calls
  `promptForTaskPhase` — the only caller is `src/supervisor/tasks.ts:181`, reached only after
  `advanceTask` returned truthy *and* the phase changed (`:179`). So no render, no reserve,
  `verdict_seq` unchanged, and `verdictFor` returns the path the live agent already holds.
- `hpipe abort` + `hpipe resume`: `cmdResume` (`src/cli.ts:516-532`) writes `run.phase` and
  `phase_entered_at` and nothing else. On the next tick `runPhaseBefore` (`src/supervisor/main.ts:184`)
  already equals `run.phase`, so `src/supervisor/main.ts:215-217` renders `''` and never reserves.

I also checked the inverse — that no verdict row can be *entered* without a reservation. Every
`enterTaskPhase`/`enterRunPhase` call site in `src/` lands either on a non-verdict row
(`tick.ts:193,206`, `teardown.ts:28,34`, `stall.ts:370-371`, `tasks.ts:149,154`, `cli.ts:266,447`) or
inside `advanceTask`/`advanceRun`, whose callers render immediately afterwards. The remaining two
entries are `cmdRewind` (reserves, C4) and the resume (deliberately does not).

**Exactly three reservation sites, and the guards are right for every row in `src/lib/phases.ts`.**

| Site | Guard | `file:line` |
|---|---|---|
| task render | `taskRow(task.phase).signal === 'verdict'` | `src/supervisor/tasks.ts:53` |
| run render | `runRow(run.phase).signal === 'verdict'` | `src/supervisor/deliver.ts:255` |
| `cmdRewind` | both, per branch | `src/cli.ts:365-367`, `:380-382` |

Walking `RUN_ROWS` and `TASK_ROWS`, `signal: 'verdict'` holds for exactly five rows —
`branch-review` (`src/lib/phases.ts:64`), `spec-review` (`:96`), `plan-review` (`:101`),
`pr-review-intent` (`:111`), `pr-review-quality` (`:114`) — and those are precisely the five prompts
that consume `{{verdict_path}}` (`grep -rn verdict_path prompts/`). The `signal` test rather than an
`artifact === undefined` test is the right one: `implement` (`:109`), `ci` (`:122`), `merge` (`:125`),
`close` (`:127`) and every blocked/terminal row also lack an `artifact` slot and would have reserved
under the weaker guard. `ci` in particular carries `signal: 'ci'` and its own `counter`, and is
correctly excluded.

I also confirmed each of the five rows actually renders text — none of them falls into
`promptForTaskPhase`'s `''` cases (`src/supervisor/tasks.ts:68-102`) — so no reservation is burned on
a phase that produces no prompt. And a failed send is *dropped*, not re-rendered
(`src/supervisor/main.ts:247-262`), so a delivery failure cannot burn a key per tick; the spec's
error table says exactly this and it is accurate.

**A1's legacy fallback keeps today's derivation, character for character.** Old
(`git show main:src/supervisor/deliver.ts:101-106`):

    join(REVIEWS_DIR, `issue-${task.issue}-${task.phase}-${counterFor(...)}.md`)
    join(REVIEWS_DIR, `${run.run_id}-${run.phase}-${counterFor(...)}.md`)

New (`src/supervisor/deliver.ts:108-115`) routes both through
`verdictFilename(verdictPrefix(run, task), phase, counterFor(...))`, and `verdictFilename`
(`src/lib/verdict-path.ts:8-10`) is `join(REVIEWS_DIR, ${prefix}-${phase}-${ordinal}.md)` with
`verdictPrefix` (`:13-15`) yielding `issue-N` / `run_id`. Identical strings. That is also
spec-review-1 MINOR 1's fix (the fallback now spells through the one speller) and it is present.
`test/deliver.test.ts:149-155` and `:237-241` still assert on `counterFor` and are still green, as A1
predicted; `:157-163` was correctly rewritten and a converse test added at `:165-171` pinning the new
narrowing (*a seeded `verdicts` entry with no `verdict_seq` is ignored*), which is the contract A1
says must never be "repaired" by teaching the reader to scan.

**Round-tripping is proven, not assumed.** `verdict_seq` is optional and absent-safe (no
`schema_version` bump, per the spec's non-goals), and
`test/cli-commands.test.ts:642-665` saves and re-loads through `saveRun`/`listRuns` and asserts
`verdict_seq` survives — so the new field genuinely persists rather than being dropped by the store.

**The declared deviation is the only one.** The plan declares one: spec C3's explicit
`if (row.signal !== 'verdict') return <today's derivation>` early return is omitted because
`verdictFor` already returns `null` for an unreserved row. It is explained twice — plan `:24-39`
(including the second half, that the omitted branch also drops a map lookup, safe only under A1) and
in the code at `src/supervisor/deliver.ts:94-101`. I diffed every other step of the plan against the
tree: step 1's three spellers, step 2's types + `verdictFor`, step 3's `reserveVerdict` (byte-identical
to the plan's block, `PROBE_LIMIT` 64 and the floor-not-zero degradation), step 4's `artifactPathFor`
and `absoluteArtifactPath`, steps 5-7's three guarded sites, step 8's `prompts/escalate.md` **and**
`test/integration/smoke.md:544,547` (plan-review MINOR 3's "one of two copies" fix, applied). All three
plan-review MAJORs landed: step 10 exists (plan `:889-920`), the run-level `cmdRewind` reservation has
a test (`test/cli-commands.test.ts:667-685`), and `verdict_seq` is pinned against the counter reset.
No undeclared divergence found.

**The `pr-review-intent` re-entry fix is in scope, not scope expansion.** It costs **zero** extra
code: it falls out of reserving at render time, which is what the ruling mandates. The route is real —
`pr-review-quality` BLOCKER bumps its *own* counter and returns to `implement`
(`src/lib/phases.ts:114-116`, `src/lib/machine.ts:120-126`), which clears back to `pr-review-intent`
whose counter never moved — and `ci`'s `onBlocker: 'implement'` (`src/lib/phases.ts:122`) is a third
route to it. It is disclosed in three places before a reader could be surprised: spec A12, the plan,
and the PR's own *"Also fixed, which the issue does not mention"* heading. Declining to fix it would
have required a special case. In scope.

**Scope discipline against the ruling's coordination note.** The ruling confines this task's
`src/cli.ts` work to `cmdRewind`. The diff touches `src/cli.ts` at `:13` and `:20` (imports) and
`:321-389` (`cmdRewind`). Nothing near `cmdTask`'s `:255-269`, which t2/#16 holds. `README.md`,
`prompts/dispatch.md`, `src/hooks/` and `src/lib/config.ts` are untouched, as the spec's non-goals
promise.

**Every issue direction is answered.** The filename no longer derives from a resettable counter; it
is assigned once and recorded in `task.artifacts.verdicts` — the field the ruling designated, which
the issue observed as literally `{}` on a task that had completed a review, and which now has its
first writer. `cmdRewind` can no longer make two documents share a name
(`test/cli-commands.test.ts:624-640` is the red test, and it asserts the *positive* path too: the
rewind reports and resolves `issue-1-spec-review-1.md`, not the occupied `-0`). Monotonicity holds
across rewind, across a `CLEAR`, and across a resume.

The tests exercise behaviour rather than restating the implementation. The two that matter most are
`test/verdict-path.test.ts:120-135` (reserve, then *delete the file from disk*, then reserve again,
and assert the first key still resolves to its original filename) and `:90-105` (reader agrees with
reserver **starting from a map with a gap**) — both are the pass-2 BLOCKER made unreproducible, and
neither would pass on a read side that searched.

---

## MAJOR 1 — the ruling's load-bearing invariant has no automated guard, and its only check is deferred past merge

The `Ruling` exists because pass 1 keyed on phase entries and a resume moved the path under a live
agent. The whole design is arranged so that a resume is *"inert by construction rather than by a
special case"*. I verified it is (see above) — but nothing in the suite pins it.

`test/decide.test.ts:201-328` is where `deliverPendingAnswers` is tested, six times, and not one of
those tests touches `verdict_seq` or `artifactPathFor`. `test/tasks.test.ts:476-487` proves the
*render* reserves and `:489-497` proves a non-review row does not, but neither exercises the resume
path. The spec assigns this check to live step 4 only (spec, "Live verification" step 4; plan
`:912-915`), and step 10 is explicitly *"not runnable before the merge"* — the installed plugin is
pinned to `…@be181757…`. So the single property the ruling was written to protect ships with no
regression test and no verification until after it lands.

This is not hypothetical drift. The issue's own *"Observed live, 2026-09-19"* section records that
after a resume the row had **no path forward at all** and sat until a human rewind. The obvious later
"fix" for that symptom is to make `deliverPendingAnswers` re-render the phase prompt — which would
call `promptForTaskPhase`, reserve, and move the path out from under the live agent. That is pass-1's
BLOCKER restored, and `src/supervisor/tasks.ts:347` carries no comment saying the absence of a render
there is deliberate.

Note the adjacent regression *is* caught: putting `reserveVerdict` inside `enterTaskPhase` would make
`test/tasks.test.ts:483` see `verdict_seq === 2` and fail. It is specifically the resume route that is
unguarded.

**Inline fix**, and the same shape as plan-review MAJOR 3, which this repo accepted as inline: one
test in `test/decide.test.ts` — seed a task in `blocked-on-decision` with `decision_from:
'spec-review'`, a reserved `verdict_seq: { 'spec-review': 1 }` and its map entry, run
`deliverPendingAnswers`, then assert `verdict_seq` and `artifactPathFor` are byte-identical to before —
plus one *why* comment at `src/supervisor/tasks.ts:347` recording that no prompt is rendered here on
purpose. Reverses no decision, changes no scope, needs no human judgment.

---

## MINOR 1 — the PR body's citation for the resume points at the wrong statement

> a resume — a decision answered on a review row (`src/supervisor/tasks.ts:341`) …

`src/supervisor/tasks.ts:341` is `task.delivery_attempts += 1`, inside the failed-send branch. The
resume is `enterTaskPhase(run, task, resumeTo, …)` at **`:347`**. Six lines off, and it lands on the
statement that means the opposite (delivery failed, no resume happened).

Every other citation in the PR body checks out: `src/cli.ts:353` is `task.passes = {}` on `main`,
`src/supervisor/deliver.ts:101-103` is the old derivation on `main`, `src/lib/phases.ts:111-116` are
the two PR-review rows, `src/supervisor/stall.ts:203` is `absoluteArtifactPath`, and `b43b73f` is on
this branch. spec-review-1 graded three citation slips as a MINOR; this is one, in the document a
reader reaches first.

**Inline fix:** `:341` → `:347`.

---

## MINOR 2 — the "Also fixed" claim is the one behavioural claim in the PR body with no test naming it

The PR asserts that the `pr-review-intent` re-entry collision is closed *with no rewind involved*.
The mechanism is sound and I traced it — but the coverage is generic (`spec-review` reserving on
render, `test/tasks.test.ts:476-487`) and nothing walks the actual loop: reserve for
`pr-review-intent`, take a `pr-review-quality` BLOCKER back to `implement`, re-enter
`pr-review-intent`, assert the second path differs from the first. Spec A12 calls it *"a reachable
loss, not an observed one"*, which is fair — but a PR that adds a section claiming a second fix
should leave behind the test that would notice it regressing, especially since the guard it depends
on is one line in a file three sibling tasks will rebase onto.

**Inline fix:** one test in `test/tasks.test.ts`, or an explicit line in the PR body saying the
coverage is the generic reserve-on-render test.

---

## Verdict

The change does what the issue and the ruling asked, and only that. `artifacts.verdicts` finally has
a writer; the path is assigned once at commission and thereafter read by dictionary lookup; the
probe picks a filename and never a key; `verdict_seq` is monotone and survives the one command that
clears counters; the resume is inert in the real code; the reservation guards are correct for all
five verdict rows and exclude the four artifact-less non-verdict rows that a weaker guard would have
caught. The one deviation from the plan is declared and explained in two places, the accepted fixes
from both clearing reviews are present, and the quoted test figures are exact — including the
baseline, which I reproduced from `main`.

MAJOR 1 is one test and one comment. It does not reverse a decision, change scope, or need a
judgment only the human can make. Neither MINOR is more than an edit.

VERDICT: CLEAR
