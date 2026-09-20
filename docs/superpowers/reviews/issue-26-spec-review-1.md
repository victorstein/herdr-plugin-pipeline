# Adversarial review — issue #26 design, pass 3

Reviewed `docs/superpowers/specs/2026-09-19-issue-26-design.md` against `gh issue view 26` (including
the `Ruling` and its `Observed live, 2026-09-19` addendum), the research note at
`docs/superpowers/research/2026-09-19-issue-26-research.md`, the three earlier reviews
(`issue-26-spec-review-pass0-preserved.md`, `…-pass1-preserved.md`, `issue-26-spec-review-0.md`),
`.claude/agents/plugin-dev.md`, and the tree at `9b90256`. Baseline re-measured here, not taken from
the spec:

    $ bun test          → 503 pass, 0 fail, 1265 expect() calls, 34 files, 8.67s
    $ bun run typecheck → tsc --noEmit, exit 0
    $ herdr plugin list → stein.pipeline … @be181757beca96069b7f209163fb7538c0e6382f

All three match the spec's quoted numbers.

## The central claim holds

The clarification asked for a read side that is one dictionary lookup under a stable key. I tried to
break it and could not.

- **The reader cannot disagree with the reserver, by construction.** `reserveVerdict` writes
  `verdicts[verdictKey(phase, seq)]` and then sets `verdict_seq[phase] = seq + 1`; `verdictFor` reads
  `verdicts[verdictKey(phase, seq - 1)]`. The two are the same key whenever `verdict_seq` is the only
  thing that writes itself, and nothing in C1–C5 decrements, clears or otherwise touches it. The probe
  genuinely selects only a filename: freeing a low name on disk changes what a *future* reservation
  picks and can never change what an existing key resolves to. I ran the pass-2 BLOCKER's own
  sequence (legacy record → reserve → `git mv` the occupant aside → reserve again) and the first key
  still resolves to its original filename.
- **`verdict_seq` is stable across every resume.** `promptForTaskPhase` has exactly one caller,
  `src/supervisor/tasks.ts:175`, guarded by `if (task.phase === cameFrom) continue` at `:173`, so it
  is reached only on a real transition. `promptForRunPhase` has two — `src/supervisor/deliver.ts:242`
  and `src/supervisor/main.ts:217` — and the second is unreachable for the reason A11 gives; I
  confirmed `advanceRun` has exactly one caller (`evaluateRun`, `src/supervisor/deliver.ts:236`) and
  `evaluateRun` exactly one (`src/supervisor/main.ts:182`), both before `runPhaseBefore` is captured
  at `:184`. I enumerated every path that re-enters a verdict row: `advanceLoopingRow`'s `onBlocker`
  (via a producer row, so the return transition renders and correctly commissions);
  `deliverPendingAnswers` → `enterTaskPhase(task.decision_from)` (`src/supervisor/tasks.ts:341`, and
  `task.decision_from = task.phase` at `src/cli.ts:429`, so a decision raised at `spec-review` does
  resume there — `grep -c verdict_path prompts/answer.md` → `0`, nothing renders, nothing reserves);
  `cmdResume` (`src/cli.ts:511`, no render); `advanceRun`'s `branch-review → branch-review` self-loop
  (`src/lib/machine.ts:82`, which *does* render and *should* reserve); and `cmdRewind`. Each one lands
  where the design says it lands.
- **The three sites are the right three, and the guard is the right guard.** `signal === 'verdict'`
  rather than `artifact === undefined` is correct: `ci`, `merge`, `close`, `implement` and the blocked
  rows all lack an `artifact` (`src/lib/phases.ts:105-140`). Both render sites do build `common`
  before the `switch` (`src/supervisor/tasks.ts:49-60`, `src/supervisor/deliver.ts:250-255`), so the
  guard is not optional, and the `escalated` branches bypass `common` entirely.
- **The layering argument is exact.** `grep -rn "supervisor/" src/ | grep -v "^src/supervisor/"`
  returns nothing, and `src/lib/predicates.ts:1` already imports `node:fs`, so a `src/lib/` module
  that stats the filesystem is in-repo shape.
- **The evidence is real.** `git log --oneline --diff-filter=M fix/15-stall-escalation -- …issue-15-spec-review-0.md`
  → `f672bfe`, `--stat` `314 insertions(+), 348 deletions(-)` on a 662-line file. `b43b73f` is two
  `R100` renames. `432f4d7`, `944210d`, `ddd5086` are the three the research note records. The `12`
  `pr-review` files, the `13` rewinds over four ledgers, `MAX_PASSES: 2`, `TASK_STALL_MINUTES: 45` all
  check out.
- **A4 survives its attack.** A literal "reserve only at render time" leaves `hpipe rewind <run>
  spec-review` re-issuing an occupied name, which is the command the issue is named after, so C4 is
  the right reading of *"where a new review is commissioned"*. It does move the path under an agent
  that is live in that row — but so does today's code, and worse (onto an *occupied* name rather than
  a free one), and the human who typed the command is shown the new path at `src/cli.ts:373`.
- **The A1 fallback is necessary.** Returning `null` for an in-flight record at upgrade would make
  `isFresh` unsatisfiable at `src/supervisor/main.ts:196` and deadlock every live review.
- **C5's rewrite of the `deliver.ts:91-94` comment is correct.** `claimed` is built from
  `{research, spec, plan}` only (`src/supervisor/tasks.ts:250-253`), so the prefix filter at `:180` is
  what keeps a review out of an artifact slot, and `adoptableArtifacts` is called only in the
  artifact-row branch (`:254`). Recording verdicts changes the premise, not the conclusion.

Two findings remain, both inline.

---

## MAJOR 1 — `test/deliver.test.ts:156-161` goes red, the spec says it stays green, and the reason the spec gives for it is wrong

**Claim.** Testing strategy: *"the A1 fallback keeps `:148-154`, `:156-161` and `:227-232` green — the
first and third have empty maps, and the second seeds `verdicts['branch-review-0']`, which is the key
`verdict_seq` yields once it is 1."*

**Problem.** `verdict_seq` is never 1 in that test. It is a new optional field and the fixture is a
hand-written literal, so it is `undefined`. `verdictFor` therefore takes its `seq === 0` early return
and yields `null`, C3's `??` fires, and the test's whole point — that a seeded `artifacts.verdicts`
entry beats the derived path — is exactly what no longer happens. The conditional the spec writes
(*"once it is 1"*) is the condition the test does not meet, asserted as if it did.

Underneath the bookkeeping there is an unstated behaviour change the spec should own: **after C2 the
reader ignores `artifacts.verdicts` entirely unless `verdict_seq` is set for that phase.** Today
`artifactPathFor` honours any recorded key (`src/supervisor/deliver.ts:102`, `:106`). That is safe in
production — `grep -rn "verdicts" src/` shows the only writes are the `{}` initialisers at
`src/cli.ts:229` and `src/lib/ledger.ts:35`, so no record on disk has an entry — but it is a real
narrowing of a documented read, and the test is the thing that documents it.

This is the third consecutive pass in which the spec has named a test as staying green that does not:
pass-0 MAJOR 1 was *"breaks a test A11 says stays green"* (`test/cli-commands.test.ts:228-239`), and
pass 2 had to re-derive the whole set by hand. The class of error is not being caught by the spec's
own process.

**Evidence.**

    test/deliver.test.ts:156-161
      test('a seeded verdict path wins over the default', () => {
        const run = mkRun()
        run.phase = 'branch-review'
        run.artifacts.verdicts['branch-review-0'] = 'docs/superpowers/reviews/custom.md'
        expect(artifactPathFor(run, null)).toBe('docs/superpowers/reviews/custom.md')
      })

`mkRun()` is `newRun(...)` plus overrides (`test/deliver.test.ts:21` carries the task literal; the run
comes from `src/lib/ledger.ts:24-41`), and neither sets `verdict_seq`. Under C2,
`record.verdict_seq?.['branch-review'] ?? 0` → `0` → `verdictFor` returns `null` → C3 returns
``join(REVIEWS_DIR, `${run.run_id}-branch-review-${counterFor(run, 'branch-review')}.md`)`` →
`docs/superpowers/reviews/<run_id>-branch-review-0.md`, which is not `custom.md`. Red.

The other two claims do hold, for the reasons given: `:148-154` and `:227-232` have empty maps and
absent `verdict_seq`, so both take the A1 fallback and keep asserting on `counterFor`. So does
`test/cli-commands.test.ts:228-239` (rewind to `spec`, an `artifact` row, no reservation), and so does
`test/tasks.test.ts:301-312` — `mkTask` is `issue: 1` and `checkout_path: '/r/.worktrees/feat-x'`
(`test/tasks.test.ts:13`, `:18`) which does not exist, so the probe accepts ordinal 0 and the
pre-render read and the post-reserve prompt agree on `issue-1-spec-review-0.md`. The spec is right
about all of those.

**Concrete fix.** Move `test/deliver.test.ts:156-161` out of the "stays green" list and into the
changed-tests list, with the rewrite stated: seed `run.verdict_seq = { 'branch-review': 1 }` alongside
`verdicts['branch-review-0']`, and rename it to what it now pins — *a recorded verdict path is
returned for the key `verdict_seq` names*. Add a companion asserting the converse, which is the new
contract and currently untested: **a seeded `verdicts` entry with no `verdict_seq` is ignored and the
A1 fallback applies.** Then add one sentence to A1 saying so, so nobody later "repairs" it by making
`verdictFor` scan the map when `verdict_seq` is absent — that would put a selection rule back on the
read side and undo the clarification.

---

## MAJOR 2 — the Problem section claims the wedge is closed; A6 says it is not, and the case the spec measured is A6's case, not the Problem section's

**Claim.** Problem: *"The other is a **wedge**: after a rewind the key regresses onto a file older than
`phase_entered_at`, `isFresh` … can never accept it, and the row waits for the stall ladder. Measured
on this task, on 2026-09-19: `phase: spec-review`, `passes: {}`, `phase_entered_at` 22:56:44,
`issue-26-spec-review-0.md` mtime 16:56:38 … **Both faces have the same root cause, and both are
closed by a key that cannot regress.**"

A6: *"a rewind onto a review row is **expected to leave the row idle** until the human relays the path
or the first probe fires at `TASK_STALL_MINUTES` = 45 … That is the accepted cost of not re-delivering
the prompt, not a bug to report later."*

**Problem.** These are the same sentence with opposite signs. "The row waits for the stall ladder" is
offered as the defect; "expected to leave the row idle until … the first probe fires at 45" is offered
as designed behaviour. A rewind onto a review row reserves a path that **does not exist on disk**, so
`isFresh` is false there too (`statSync` throws → `src/lib/predicates.ts:17-18` returns `false`),
`advanceTask` returns `null` for the row (`src/lib/machine.ts:151`), and `src/supervisor/tasks.ts:172`
`continue`s without rendering. The row waits for the stall ladder exactly as it does today. What the
fix removes is the *clobber* at the end of that wait, not the wait.

That matters because the wedge is the half the spec added to justify scope beyond the issue text, and
because the measurement it cites is the rewind-onto-a-review-row case — the one A6 exempts, not the
one the Problem section describes.

**Evidence.** The live ledger for this very run,
`~/.local/state/herdr/plugins/stein.pipeline/runs/pipeline/herdr-plugin-pipeline-20260919-stop-losing-reviews-and-broken-worktrees-wyy3.json`,
t1 (issue 26):

    2026-09-19 17:15:09.181  spec-review -> escalated      2 passes at spec-review
    2026-09-19 22:56:44.490  rewind      -> spec-review    manual rewind
    2026-09-19 23:14:56.780  spec-review -> spec           returned (pass 1)

`phase_entered_at` 22:56:44 is a `rewind -> spec-review`, so the spec's own measured wedge is a rewind
directly **onto** the review row, which is C4's case and A6's exemption. It did not clear on its own
either: `b43b73f` was committed at 23:02:30 — a human `git mv`ing the occupant aside — and the row
moved at 23:14:56, eighteen minutes in and well inside the 45-minute ladder. Under C4 that `git mv`
becomes unnecessary, which is a genuine win; the eighteen minutes of human relay do not go away.

This is also not an edge case. `prompts/escalate.md:15` is the standing instruction after every
2-pass escalation:

    {{hpipe}} rewind {{run_id}} {{phase}}{{task_flag}}

and `{{phase}}` is `task.escalated_from` (`src/supervisor/tasks.ts:87`), which
`src/lib/machine.ts:92` set to the review row the task escalated *from*. So the documented recovery
path from every escalated review is precisely the rewind that A6 says leaves the row idle. The t1
history above is that instruction being followed.

**Concrete fix.** Two edits, no design change.

1. In Problem, replace *"both are closed by a key that cannot regress"* with what is true: the clobber
   is closed everywhere; the wedge is closed for a rewind onto a **producer** row (`spec`, `plan`,
   `implement`), where the following transition renders and reserves immediately, and is *made
   non-destructive but not shortened* for a rewind onto a review row, which is A6's accepted cost.
   Cite the t1 history above as the measurement, saying which rewind it was.
2. In A6, add that this is the documented escalation recovery (`prompts/escalate.md:15`), not an
   exotic path, and promote live-verification step 3 from a curiosity to the primary check — the
   runbook's step 2/3 pair is now the main case, and step 1 (`rewind … spec`) is the one that is fully
   automatic.

---

## MINOR 1 — the "one speller" contract is single-sourced for the base and the filename, but not for the prefix, and C3's fallback spells a filename without the speller

C2 declares `verdictFilename` *"The ONE place a verdict filename is spelled"* and A3 adds
`verdictBase` as *"the single source of the base"* precisely so `task?.checkout_path ?? run.repo_root`
is not copied to three new sites. Two pieces escape that discipline. First, C3's legacy branches spell
a filename inline — ``join(REVIEWS_DIR, `issue-${task.issue}-${task.phase}-${counterFor(…)}.md`)`` and
the `run.run_id` twin — rather than calling `verdictFilename`, so the module's stated invariant is
false on the one branch that still derives. Second, `reserveVerdict(record, prefix, phase, base)`
takes `prefix` as a parameter, so `issue-${task.issue}` versus `run.run_id` is chosen independently at
all three reservation sites *and* at both fallbacks — five spellings of the thing A3 refused to copy
to three. The ruling's MAJOR 1 asked for *"exactly one function that derives a verdict filename, used
by both the reserver and the reader"*. Fix: give `reserveVerdict` the signature
`(run, task: Task | null, phase)` so it derives prefix and base internally next to `verdictBase`, add
a sibling `verdictPrefix(run, task)`, and have C3's `??` branches call
`verdictFilename(verdictPrefix(run, task), phase, counterFor(…))`.

## MINOR 2 — A11's writer enumeration is one writer short of the one that carries its argument

A11 names *"the only other `run.phase` writers are `src/cli.ts` and `src/supervisor/stall.ts:371`"*.
`src/lib/machine.ts:48` (`enterRunPhase`) is the third, and it is the only one that can fire between
`src/supervisor/main.ts:184` and `:215` — which is the whole question A11 is answering. The conclusion
survives: `enterRunPhase` is reached only from `advanceRun` (`src/lib/machine.ts:58`, `:65`, `:71-72`,
`:77`, `:80`, `:82`), `advanceRun` only from `evaluateRun` (`src/supervisor/deliver.ts:236`), and
`evaluateRun` only from `src/supervisor/main.ts:182`, all before `:184`; and nothing in `advanceTasks`,
`deliverPendingAnswers` or `announceDecisions` writes `run.phase`. But A11 exists so a later change to
the tick order is checked against a complete list, and the list is incomplete. Pass-2 MINOR 1 named
all three; this pass dropped one. Restate it with `src/lib/machine.ts:45-51` and its single-caller
chain.

## MINOR 3 — a reservation that is never delivered burns its ordinal permanently, and nothing says so

`reserveVerdict` persists at `src/supervisor/main.ts:242`, which runs **before** delivery at `:248-261`;
and that loop does not re-queue a failed prompt — on a retryable failure it increments
`attempts.get(paneId)` and drops the text, and `pending` is rebuilt from scratch next tick. So a
delivery that fails, or a redundant second `hpipe rewind` onto the same review row, records a key and
a filename that no agent ever receives, and the step-2 map-value check then guarantees that filename
is never handed out again. Review numbering acquires permanent gaps (`-0`, `-1`, `-3`), and A13 says
the map is never pruned. The idling itself is not a regression — today a dropped prompt idles the row
identically — but today the derived path is reproduced on the next render, and after this change it is
not. One row in the error table (*"a reservation is never delivered → the ordinal is spent; the next
commission takes the next one, and the gap is permanent"*) plus a clause in A7, which already owns the
`{{pass}}`-versus-ordinal divergence, covers it.

## MINOR 4 — three citation slips, in a spec that promises a `file:line` for every claim

`src/cli.ts:2-21` *"imports only from `./lib/`"* — `:2` and `:3` are `node:fs` and `node:path`; the
`./lib/`-only range is `:4-21`, and the claim as stated is false of the range cited (the `deliver.ts`
twin, `:2-10`, is correct). `src/supervisor/tasks.ts:172-175` *"returns early"* — `:172` and `:173`
are `continue` statements inside the `for` loop and `:175` is the render call itself; the early-exit
pair is `:172-173`. A8 cites `src/supervisor/deliver.ts:139-148` as *"the `try`/`catch` that guards the
neighbouring loop"* — it guards the `Bun.spawn` in `git()`, and there is no loop; the precedent is
still the right one, so say "guards the neighbouring spawn". Everything else I spot-checked resolves
at `9b90256`: `deliver.ts:91-94`, `:95`, `:97-107`, `:101-103`, `:105-106`, `:110-115`, `:113`, `:180`,
`:242`, `:246-255`, `:253`; `tasks.ts:46-60`, `:49-60`, `:55`, `:87`, `:171-178`, `:250-254`,
`:264-267`, `:270-275`, `:314-343`, `:326-341`, `:341`; `cli.ts:13`, `:224`, `:229`, `:311-321`,
`:352-357`, `:353`, `:355`, `:360`, `:372`, `:373`, `:429`, `:500-516`; `machine.ts:7-21`, `:78-81`,
`:94`, `:117-118`, `:120-126`, `:121-123`, `:147-156`; `phases.ts:77-81`, `:96-98`, `:109-110`,
`:111-116`, `:122-124`; `types.ts:83`, `:90`, `:100`, `:119`; `ledger.ts:35`, `:143-149`;
`config.ts:26`, `:28`; `predicates.ts:1`, `:10-20`; `status.ts:102-105`; `main.ts:32-34`, `:182`,
`:184`, `:193-198`, `:196`, `:215-217`, `:242`, `:266`, `:279`; `stall.ts:117-121`, `:203`, `:371`;
`tick.ts:169`; all five `verdict_path` prompt lines; `escalate.md:17`; `stall-probe.md:3`;
`prompts.test.ts:118-122`; `README.md:100`; `test/cli-commands.test.ts:18-25`, `:37-47`, `:228-239`;
`test/tasks.test.ts:242-247`, `:301-312`; `test/deliver.test.ts:148-154`, `:227-232`, `:255-300`,
`:287-295`.

---

Neither MAJOR reverses a decision, changes scope, or needs a judgment the implementer cannot make.
MAJOR 1 is one test rewritten, one test added and one sentence in A1 — but it must not be "fixed" by
teaching `verdictFor` to scan, which would undo the clarification, so the sentence matters more than
the test. MAJOR 2 is two paragraphs of honesty about what the change buys, aligned with the A6 the
spec already got right. The design itself — one counter that only a commission advances, one key, one
lookup, one speller, and a probe that touches only filenames — is sound, and I could not construct a
sequence in which the reader and the agent's prompt disagree.

VERDICT: CLEAR
