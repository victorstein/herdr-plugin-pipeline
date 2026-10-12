# What the adversarial reviews are worth — 2026-10-12

Two research passes over every review verdict the pipeline has written, its run ledgers and its
worker transcripts, and the four changes they led to. The owner approved the changes before they were
built.

## Data

403 verdict files: 257 from berean-os (ESP32 e-reader firmware, the one real project), 95 from the
`hpipe-smoke` repo and 51 from this repo. 90 berean-os findings were classified by hand against the
code the review saw and the code that shipped. The working files are outside this repo, in the session
scratchpad under `review-research/`:

| File | What it holds |
|---|---|
| `quant/data/stats.md` | every number below: rates, costs, time, per-task shares, sound-plan tables |
| `quant/reviews.csv` | one row per verdict file: verdict, trailer and body B/M/m counts, reviewer cost and minutes |
| `qual/RUBRIC.md` | the classes: RD-SHIP (would have shipped), RD-CAUGHT (a later step catches it), NIT, WRONG |
| `qual/rows-A-spec-blockers.md` | 21 findings behind the 13 spec-review BLOCKER verdicts |
| `qual/rows-B-spec-majors.md` | 17 spec-review MAJORs |
| `qual/rows-C-plan.md` | 16 plan-review BLOCKERs and MAJORs, plus a tally of all ~51 plan B/M titles |
| `qual/rows-D-pr-branch.md` | 12 PR-stage and branch-review BLOCKERs and MAJORs |
| `qual/rows-E-after-sound-plan.md` | PR reviews on the 45 tasks whose spec and plan cleared first pass |
| `qual/rows-escapes.md` | 14 defects that reached `main`, traced back to their reviews |
| `qual/sound-plan-enum.txt` | per task: tier, first-pass outcomes, non-docs diff size, PR review counts |

## What we found

**Reviews are the bulk of a task's cost, and they are accurate.** On berean-os, reviewer subagents plus
the worker's own turns in review phases were 56% of a task's spend (median task $19.59) and 26–49% of
its active time, depending on tier (`stats.md`, COST and TIME). Not one of the 90 classified findings
was a false positive. The waste is in duplication, severity inflation and findings nobody applies.

**Spec review earns its keep.** It returned 14 of the 19 berean-os BLOCKER verdicts. 13 of the 21
findings behind them were defects that nothing downstream would have caught, including every
data-loss bug in the corpus: an unloaded store saved over `wifi.json`, an undeletable bookmark file, a
cross-task deadlock, a silent 50× slow SD mount (`rows-A`, A1, A9, A10, A18). 10 of 17 sampled spec
MAJORs were also real shipping defects (`rows-B`). Spec review yields 36 MAJOR+ findings per $100;
plan review 17.5, the PR stages 0–7 (`stats.md`, YIELD PER DOLLAR).

**Plan review mostly re-runs what implementation runs anyway.**

| Plan-review BLOCKER/MAJOR findings, berean-os (`rows-C`, n≈51) | Share |
|---|---|
| compile, link and command errors; wrong expected counts; `FILES:` staging | ~59% |
| process: the plan pushes or opens the PR, spec/plan wording disagreements | ~18% |
| test strength, spec-to-step coverage | ~10% |
| behavioural defects in the product | ~10% |

Reviewers often applied the whole plan in a scratch copy and built it (#106, #108, #188, #30, #31,
#34, #28) — a second implementation run to move an error the red/green loop hits minutes later. None
of the four plan-review BLOCKERs prevented a shipped defect. The three findings that would have
shipped were logic no test reaches: workflow bash, pixel geometry, a dropped spec requirement (C8–C10).
"The plan tells the implementer to push and open the PR" recurred in 8 or more plan reviews, rated
MAJOR, MINOR or "not a finding" by turns (C12): a template conflict, not a per-task defect.

**After a sound plan, the PR stage rarely finds anything.**

| PR reviews on the 45 sound-plan berean-os tasks (`rows-E`) | Reviews | Zero findings | MINOR only | MAJOR+ |
|---|---|---|---|---|
| combined `pr-review` (light, standard) | 21 | 5 | 12 | 4 |
| `pr-review-intent` (heavy) | 26 | 10 | 16 | 0 |
| `pr-review-quality` (heavy) | 26 | 6 | 17 | 3 |

One real defect in 45 sound-plan tasks: #205, the oldest highlights unreachable, on a +784-line
standard diff, found by a combined `pr-review` (D1, D12). The brief counted 46; `rows-E` excludes
#60, whose real pass 0 was a BLOCKER. Of the 13 sound-plan tasks under ~150 added
non-docs lines, none drew a behavioural PR finding (`sound-plan-enum.txt`).

**Heavy's two PR stages bought nothing over one.** Across all repos the intent stage cleared 66 of 66;
its two MAJORs were both on this repo's own reviews, none on berean-os or smoke. The quality stage's
three berean-os MAJORs were hygiene (dead headers, duplicated tests, a hand-kept field list), and two
of the three were never applied: the task moved on to `ci` with the findings in a CLEAR verdict
(D3, D4).

**Severity was inflated, and the inflation cost re-review passes.** 8 of the 18 berean-os BLOCKER
verdicts the classification covered prevented no defect. They were BLOCKERs by prompt rule: a missing
`FILES:` line (C1), "reverses a decision" for a reversal the reviewer itself called sound (C3), "needs
the human" for a rebase the orchestrator answered in about a minute (C4), the pipeline's own
shared-file rule (A15b). Each cost a full re-review of 9–36 minutes. Reviews carried about 3.3 MINORs
each on average (839 across the 257 berean-os files; spec reviews 4.8, plan reviews 3.8). The largest
class of spec-review MINORs was citation and documentation drift, 163 of 375 (`stats.md`, CATEGORIES).

`reviews.csv` counts 19 berean-os BLOCKER verdicts; the 19th is #60's pass 0, which survives only in
git (`56a0154c` overwrote it on disk). The brief's 18 is the on-disk count.

## What changed

| # | Change | Commit |
|---|---|---|
| 1 | A BLOCKER is a defect that would ship, or a product or scope decision only the owner can make; a BLOCKER verdict needs one. Process questions are at most MAJOR, fixed inline or raised with `hpipe decide`. A MAJOR changes shipped behaviour or a verification outcome; rationale, comment and citation drift are MINOR; at most five MINORs. A file missing from `FILES:` is a MAJOR fixed inline. | `feat(prompts): rank a BLOCKER as a shipping defect…` |
| 2 | Heavy runs the one combined `pr-review`. `pr-review-intent` and `pr-review-quality` stay as rows no route enters, so a task already in one finishes it and leaves for what follows the PR review. | `feat(phases): heavy runs the one combined pr-review…` |
| 3 | Plan review reads the plan, neither applies nor builds it, and looks at spec coverage, behaviour tests cannot see, the file lock and misleading steps. It runs at `medium` on standard (`xhigh` on heavy). The plan stops at implementation: no push, PR or `hpipe submit` step. | `feat(review): a cheaper plan review…` |
| 4 | A light or standard task skips its PR review when it adds fewer than 150 lines outside `docs/`, its design reviews cleared first pass, no PR review sent it back, and it touches nothing in `.claude/pipeline-always-review`. | `feat(supervisor): skip the PR review on a small, well-planned change` |

Effort after these changes:

| Tier | Worker | `spec-review`, `pr-review` | `plan-review` |
|---|---|---|---|
| light | medium | high | – |
| standard | high | high | medium |
| heavy | xhigh | xhigh | xhigh |

### Where the build departs from the brief, and why

- **"First pass" is read from the run's history, not the pass counters.** `hpipe rewind` clears every
  counter, so a counter cannot tell a send-back that happened before a rewind. A design review counts as
  cleared first pass when it has a forward exit and no exit to its `onBlocker` or to `escalated`. A
  decision asked from inside a review is not a send-back.
- **A PR review that already sent the task back is never skipped.** The brief does not say this. A
  BLOCKER fix is exactly the code a reviewer asked to see, however few lines it is.
- **The always-review list is read at the base, not on the branch**, with `git ls-tree`/`git show` at
  `origin/<base>` (per-task) or `origin/<batch>` (single-PR). Read from the branch, a change could take
  itself off the list. The file is always on its own list: a single-PR run reads it from the batch
  branch, where one skipped edit would otherwise decide for every later sibling. A glob is cut to its
  literal prefix, as `FILES:` entries are, which can only widen the list.
- **A send-back from any review row blocks the skip**, not only from the rows on the current route, so
  a plan review's BLOCKER still counts after a human lowers the tier past it.
- **A dirty sync after a skip forgets `land_sha`.** Nobody reviewed that head, so the review the sync
  sends the task to reads the whole change rather than "what changed since the last reviewed head".
- **Per-task sizing uses the PR's own base.** `gh pr view` now also reads `baseRefName`, and the
  supervisor fetches that branch and the task branch before `git diff --numstat -z --no-renames
  origin/<base>...<head>`. With no base from gh the review runs.
- **A binary file outside `docs/` makes the change unmeasurable**, and so reviewed: numstat has no line
  count for it.
- **Single-PR measures the branch head it will land**, read with `ls-remote` and required to contain the
  submission, then records it as `land_sha` exactly as a clearing review does. A head that moved past
  the submission therefore lands only through `sync` and the check.
- **Light gets a `plan-review` effort (`medium`)** although its route has no plan review: a rewind into
  one still renders the prompt, and `render()` must resolve `{{review_effort}}`.
- **A rewind into a retired heavy stage is warned about, not refused**, by the existing tier warning:
  it is the only way to re-run one, and it leaves by the route like any other.
- **No `schema_version` bump.** Every phase name a v3 or v4 ledger can hold is still a row, and the one
  new task field, `review_skip`, is optional. An older supervisor ignores it and reviews every PR; an
  older one meeting a heavy task in `pr-review` routes it on through its own table. `CLAUDE.md` asks
  that a `phases.ts` change be called out as an on-disk format change; this is that note.

### Known consequences, left as they are

- **Only added lines count.** A change that is mostly deletions (removing a check, −800/+20) can skip.
  The brief sized changes by lines added; deletions were never where the PR-stage findings were.
- **A one-task run can finish with no automated code review.** With at most one task landed, the
  run skips `branch-review`, so a task that also skipped its PR review reaches the human merge
  unreviewed past its plan. The merge prompt says the review was skipped.
- **The measurement is serial in the tick.** Up to three network calls (an `ls-remote` and two
  fetches, each on its own 15 s budget) on an exit that passes the ledger rules; a slow origin slows
  the tick once per such exit.

## What was deliberately not changed

- **Spec review keeps its strength**: same thrust, same per-tier effort, same send-back. It is where the
  would-ship catches are.
- **The whole-branch review is untouched.** The true escapes that reached `main` sat next to the diff —
  another task's code in the tree, a sibling writer in the same file, a sixth call site — and the branch
  review is what caught them, after merge (`rows-escapes`, X1, X5, X11).
- **Design reviews of this plugin's own specs are untouched.** Pass 2 found decisive issues in every
  series, mostly in pass 1's own remedies (`rows-design-reviews`).
- **"CLEAR with MAJORs fixed inline" still holds for PR reviews**, although `rows-D` shows its findings
  leak: a CLEAR advances to `ci` and the worker often leaves them unapplied (D3, D4). Making CLEAR with a
  MAJOR re-enter `implement` is a separate decision.
- **Hand-off losses at merge** (X2, X3, X10: caught by a review, lost at the decision or the merge) are a
  follow-through problem, not a review one, and are not addressed here.

## What a live run should confirm

`test/integration/smoke.md` §7a item 4 and §10. In short: a standard task's `plan-review` subagent is
dispatched at `medium` and does not build the plan; a small standard task goes `implement → ci` with
`pr-review skipped` in status, show, the digest and the merge prompt, and a heavy one beside it still
reviews; a task touching a listed path, or adding 150 lines, is reviewed; a single-PR skip lands its
submitted head through the gate.
