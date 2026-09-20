# Adversarial review — issue #26 design, pass 2

Reviewed `docs/superpowers/specs/2026-09-19-issue-26-design.md` against `gh issue view 26` (including
the `Ruling` section of 2026-09-19), the research note at
`docs/superpowers/research/2026-09-19-issue-26-research.md`, the two preserved reviews
(`issue-26-spec-review-pass0-preserved.md`, `issue-26-spec-review-pass1-preserved.md`), and the tree
at `b43b73f`. Baseline re-measured here rather than taken from the spec:

    $ bun test          → 503 pass, 0 fail, 1265 expect() calls, 34 files, 8.95s
    $ bun run typecheck → tsc --noEmit, exit 0
    $ herdr plugin list → stein.pipeline … @be181757beca96069b7f209163fb7538c0e6382f

All three match the spec's quoted numbers.

## What holds

The redesign is a real improvement over pass 1 and most of it checks out line by line.

- **Every `file:line` citation in the spec is accurate at HEAD**, with the two exceptions named in
  MINOR 4 and MINOR 6. I spot-checked all of them: `src/supervisor/deliver.ts:95`, `:97-107`,
  `:101-103`, `:110-115`, `:180`, `:246-255`, `:253`; `src/supervisor/tasks.ts:46-60`, `:55`,
  `:171-178`, `:184-200`, `:254`, `:264-267`, `:270-275`, `:326-341`; `src/cli.ts:229`, `:311-321`,
  `:353`, `:355`, `:360`, `:361`, `:372`, `:373`, `:500-516`; `src/lib/phases.ts:111-116`, `:122-124`;
  `src/lib/machine.ts:78-81`, `:120-126`, `:147-156`; `src/lib/types.ts:83`, `:100`;
  `src/lib/ledger.ts:35`, `:143-149`; `src/lib/config.ts:26`; `src/lib/predicates.ts:10-20`;
  `src/lib/status.ts:102-105`; `src/supervisor/main.ts:32-34`, `:193-198`, `:242`.
- **The layering argument is exact.** `grep -rn "supervisor/" src/ | grep -v "^src/supervisor/"`
  returns nothing, `src/cli.ts:5` and `src/supervisor/tasks.ts:4` both import `../lib/gating`, and
  `src/lib/predicates.ts:1` does import `node:fs` — so a `src/lib/` module that stats the filesystem
  is the in-repo shape, not a new pattern.
- **Pass-1 BLOCKER 1 really is answered by construction.** `deliverPendingAnswers`
  (`src/supervisor/tasks.ts:314-343`) sends `answer.md` and calls `enterTaskPhase` at `:341` without
  ever reaching `promptForTaskPhase` (`:175`, inside the `advanceTasks` loop that runs earlier at
  `src/supervisor/main.ts:185`); `grep -c verdict_path prompts/answer.md` → `0`; `cmdResume`
  (`src/cli.ts:500-516`) sends nothing. No reservation, no move.
- **Pass-0 MAJOR 3 is settled the way pass 0 asked.** A5 picks option (a)-partial, the Rejected
  alternatives reject (b) and the `hpipe status` half of (a) with reasons. The judgment has been made
  and recorded; I am not reopening it (but see MAJOR 1 for the factual error inside A5).
- **The `pr-review-intent` second instance is real and correctly traced.**
  `src/lib/machine.ts:117-118` returns before `bumpCounter` on a `CLEAR`, so `pr-review-intent`'s
  counter is still `0` when `pr-review-quality`'s BLOCKER (`src/lib/phases.ts:114-116`) sends the task
  to `implement` (`:109-110`) and back. `ls docs/superpowers/reviews/ | grep pr-review | wc -l` → `12`
  over six issues, exactly as the spec says, and the spec is correctly careful to claim only a
  reachable loss, not an observed one. The `ci` row (`src/lib/phases.ts:122-124`) is a third route to
  the same re-entry, which costs nothing to mention.
- **The three tests the spec claims stay green do stay green, for the reasons given.**
  `test/deliver.test.ts:148-154` (`run.passes['branch-review'] = 1`, empty map → A1 fallback → `-1`),
  `:156-161` (`verdicts['branch-review-0']` is the only key, so "highest ordinal present" returns it),
  `:227-232` (`passes: { 'spec-review': 1 }`, empty map → `-1`), `test/cli-commands.test.ts:228-239`
  (rewind to `spec`, an `artifact` row, so C3 reserves nothing). `test/tasks.test.ts:301-312` also
  passes, and for the reason the spec gives: `designArtifacts()` (`:242-247`) seeds `verdicts: {}` and
  `checkout_path: '/r/.worktrees/feat-x'` does not exist, so the probe accepts ordinal 0 and the
  pre-render fallback also yields ordinal 0. The spec is right that it passes by coincidence of
  ordering, and right to add an explicit test.
- **The red test is a genuine red and is implementable where specified.** Today, after
  `cmdRewind(… 'spec-review' …)` clears `passes`, `artifactPathFor` derives
  `docs/superpowers/reviews/issue-1-spec-review-0.md` (`src/supervisor/deliver.ts:101-103`), so
  `.not.toBe(...)` fails. `test/cli-commands.test.ts:37-47`'s `mkTask` defaults `issue: 1`, and the
  file already builds temp dirs at `:18-25`, so a checkout carrying `issue-1-spec-review-0.md` is a
  three-line addition.
- **C4 is safe.** `test/prompts.test.ts` pins only the declared prompt set (`:12`) and
  `stall-escalate.md`'s variables (`:118-122`); it asserts nothing about `prompts/escalate.md`'s body,
  so correcting `:17` breaks nothing.

The findings below are about the interaction of C1's two functions, and about what A5 claims reaches
whom.

---

## BLOCKER 1 — `reserveVerdict` (lowest free) and `recordedVerdict` (highest recorded) can disagree, so the path the agent is handed and the path the supervisor watches diverge

**Claim.** C1 specifies the pair as a matched contract:

    spec :139-140   /** The recorded path for this phase: the highest ordinal present. … */
                    export function recordedVerdict(…): string | null
    spec :151       `reserveVerdict` picks the lowest `ordinal` for which **both** are true:

and the testing strategy states it as an invariant: *"**The contract test:** after `reserveVerdict`,
`recordedVerdict` returns exactly what it returned."* (spec `:366`). A11 restates it as the
monotonicity the ruling demands: *"because earlier keys are never removed, a path once issued can
never be re-issued, which is the monotonicity the ruling requires across `hpipe rewind`"* (`:153-155`).

**Problem.** "Lowest free" and "highest recorded" are only the same number while the map's key set is
gap-free from 0. It is not gap-free on exactly the records C1's `existsSync` probe exists for. A
legacy record enters this change with an **empty** map and its early ordinals on disk only; the first
reservation therefore skips them by condition 2 and records a *high* ordinal, leaving every lower
ordinal unrecorded. If any of those lower names is then freed on disk, the next `reserveVerdict`
returns it — **below** the map's maximum — while `recordedVerdict`, and therefore every reader, keeps
returning the maximum.

The consequence is the exact failure the ruling upheld pass-1 BLOCKER 1 over: the prompt names one
file, the supervisor watches another, `isFresh` can never accept the watched one, `advanceTask`
returns nothing, and nothing re-renders a prompt to correct it.

**Evidence.** Trace a legacy task on issue 15 at `spec-review`, `passes['spec-review'] = 1`,
`verdicts` empty, with `…-spec-review-0.md` and `-1.md` on the branch:

1. `hpipe rewind <run> spec-review --task t4` → C3 reserves. Ordinal 0: free in the map, present on
   disk → rejected. Ordinal 1: same → rejected. Ordinal 2: free on both → recorded.
   `verdicts = { 'spec-review-2': '…-spec-review-2.md' }`. This is the spec's own worked case
   (`:252-257`), and it is correct as far as it goes.
2. The orchestrator then runs the documented preservation workaround — `git mv` the occupant aside
   before the next review. This is not hypothetical: the research note records it three times
   (`:119-129` — `432f4d7`, `944210d`, `ddd5086`, and `ddd5086` moved **both** `-0` and `-1`), four
   `*-preserved.md` files are in the tree, and it happened again on this very branch at `b43b73f`
   ("docs: preserve the #26 reviews before the path is reused (#26)") to free the path this review is
   being written to.
3. Next `spec → spec-review` transition, prompt renders, `reserveVerdict` runs. Ordinal 0: absent
   from the map (nothing ever recorded it — the record was legacy) **and** absent from disk (it was
   moved). Both conditions pass, so it is the **lowest free ordinal** and is returned and recorded.
   `verdicts = { 'spec-review-0': …, 'spec-review-2': … }`.
4. `{{verdict_path}}` therefore names `…-spec-review-0.md` (`src/supervisor/tasks.ts:55`, fed by the
   reservation), while `artifactPathFor` → `recordedVerdict` → *highest ordinal present* → `-2`
   (`src/supervisor/deliver.ts:97-107` as rewritten by C2). `verdictFor`
   (`src/supervisor/main.ts:193-198`) stats `-2`, whose mtime predates the re-entry, so
   `isFresh` (`src/lib/predicates.ts:10-20`) is false forever.
5. Worse, the stall probe reads the same function: `src/supervisor/stall.ts:203` →
   `absoluteArtifactPath` → `-2`, so at 45 minutes the worker is told *"Nothing newer than this
   phase's start has appeared at … `-2.md`"* while its own prompt told it to write `-0.md`. The two
   instructions the pipeline delivers to one agent contradict each other.

A second, unreachable-but-identical instance is specified outright in the error table: on bound
exhaustion `reserveVerdict` *"Records nothing, returns ordinal 0's path"* (`:278`) — again a returned
path below the recorded maximum, again a prompt/watched divergence (see MINOR 4).

Note also that A11's justification is not available here. *"Earlier keys are never removed"* is true,
but on a legacy record the earlier keys were never **written**, so the map cannot prevent their
re-issue, and the error-table row *"A path is in the map but absent from disk (the agent has not
written yet) → Condition 1 rejects the ordinal"* (`:275`) holds only for post-change records.

**Concrete fix.** Make the two functions agree by construction: `reserveVerdict` must start its walk
**above the highest ordinal already recorded for that phase**, not at 0. Restate C1 as:

    reserveVerdict picks the lowest `ordinal` strictly greater than the highest ordinal already
    present in `verdicts` for this phase (or 0 if none is), for which
    existsSync(join(base, verdictFilename(prefix, phase, ordinal))) is false.

That preserves everything the design wants and costs nothing: the legacy walk still lands on 2 in the
worked case (`:252-257`), the post-change rewind still lands on 2 (`:249-250`), the normal loop is
unchanged, a freed low name is simply never reused — which *is* "a path once issued can never be
re-issued" — and `recordedVerdict = highest` becomes a theorem rather than a coincidence, so the
stated contract test actually pins it. Then add the missing unit test: **`reserveVerdict` on a map
with a gap (`{'spec-review-2': …}`, nothing on disk) returns `-3`, not `-0`, and `recordedVerdict`
agrees.** As written, the spec's own contract test would pass only because it starts from an empty
map, so the defect ships.

---

## MAJOR 1 — A5's stated basis is false: `cmdRewind`'s output is not the only carrier of the reserved path, and the one carrier that reaches the *agent* is a 45-minute stall probe the runbook never checks

**Claim.** A5 (`:309-311`): *"After a rewind onto a review row no prompt is rendered, so
`src/cli.ts:373` is the only place the human learns the path."* The live-verification runbook step 2
(`:412-415`) asks only to *"Confirm the command's own output names the reserved path and that the
ledger agrees"*. The flow section says of the rewind cases *"The clobber is gone"* (`:247`).

**Problem.** Two things are wrong, and together they hide the real operator contract C3 creates.

First, `src/cli.ts:373` is not the only surface. `stallAwaiting` renders the watched path into the
stall probe (`src/supervisor/stall.ts:193-218`, delivered via `src/supervisor/main.ts:272-282` and
`prompts/stall-probe.md:3`), and after C2 that path is the *reserved* one. So the reserved path does
reach a human — and, more importantly, it is the only thing that automatically reaches the **agent**.

Second, and this is what the spec never says: on a rewind onto a review row C3 moves the watched path
to an ordinal **no agent has ever been told about**, and by the spec's own argument (`:200-203`) no
prompt is re-rendered. The row therefore does not advance at all until either the human manually
relays the path from `cmdRewind`'s text, or the stall ladder fires. That ladder is keyed on
`phase_entered_at`, which `cmdRewind` re-stamps (`src/cli.ts:355`), and `stall.ts:117-121` rebuilds
its state from that stamp — so the clock restarts and the first probe is `TASK_STALL_MINUTES` later,
which is **45 minutes** (`src/lib/config.ts:28`). That is precisely the sequence the ruling's live
observation calls out as unacceptable: *"The only thing that would have moved it is the 45-minute
stall ladder — exactly as the review predicted."*

This is not a reason to drop C3 — A3 is justified. Without C3 the same rewind leaves
`recordedVerdict` pointing at the path the agent already holds, the stall probe names it, and the
worker overwrites the previous pass's review, which is issue #26 unfixed. C3 trades a silent clobber
for a slow recovery, and that is the right trade. But the spec presents it as *"The clobber is gone"*
with a residual gap confined to `hpipe status`, and an implementer reading A5 would not know that the
rewound row sits idle for up to 45 minutes and would treat the first live observation of it as a
regression rather than as designed behaviour.

**Evidence.** `src/supervisor/stall.ts:193-218` builds the clause from `absoluteArtifactPath(run, task)`
and emits *"Nothing newer than this phase's start has appeared at: <path>"*;
`src/supervisor/main.ts:279` passes it as `{{awaiting}}`; `prompts/stall-probe.md:3` renders it.
`src/lib/config.ts:28` is `TASK_STALL_MINUTES: 45`. `src/lib/phases.ts:96-98` marks `spec-review`
`stallable: true` with `actor: 'worker'`, so the probe is addressed to the right pane.
`src/supervisor/tasks.ts:172-175` is the early return that means no prompt is rendered, and
`src/supervisor/stall.ts:117-121` is the `phase_entered_at`-keyed reset.

**Concrete fix.** Rewrite A5 to state the mechanism truthfully and completely:

- `cmdRewind`'s success text is where the **human** learns the path;
- `src/supervisor/stall.ts:203` is where the **agent** learns it, at `TASK_STALL_MINUTES` after the
  rewind, and is the only automatic carrier;
- therefore a rewind onto a review row is expected to leave the row idle until the human relays the
  path or the first stall probe fires, and that is the accepted cost of not re-delivering the prompt
  (the rejected alternative at `:444-446`).

Then add it to the runbook as step 2b: after the direct `hpipe rewind … spec-review`, confirm the row
does **not** advance on its own, that the first stall probe names the reserved path, and that the
earlier verdict files are untouched — so the behaviour is observed deliberately rather than reported
later as a stall bug.

---

## MINOR 1 — A2's "only three call sites" argument is about `reserveVerdict`, but the invariant it needs is about its enclosing functions, and `promptForRunPhase` has two callers

A2 (`:292-295`) makes non-idempotence safe by pinning call sites: *"the guard is 'call it only here',
enforced by there being only three call sites, not by the function."* The invariant actually required
is stronger — each of those three enclosing functions must be reached at most once per phase entry —
and `promptForRunPhase` has two callers, not one:

    src/supervisor/deliver.ts:242   const nextPrompt = await promptForRunPhase(run, config)
    src/supervisor/main.ts:217        : await promptForRunPhase(run, config)

I verified the second is currently unreachable, so this is a documentation gap and not a live
double-allocation: `runPhaseBefore` is captured at `src/supervisor/main.ts:184` **after** `evaluateRun`
has already run and mutated `run.phase` at `:182`, and `grep -rn "run\.phase *=\|enterRunPhase" src/`
shows the only writers are `src/cli.ts`, `src/lib/machine.ts` and `src/supervisor/stall.ts:371` — and
the stall block is constructed at `:266`, after `:215`. So `run.phase === runPhaseBefore` is always
true at `:215` and the second call always yields `''`. Pass 1 established this (its MINOR 1); pass 2
dropped it. Add a sentence to A2 naming `src/supervisor/main.ts:215-217` and why it cannot fire, so a
later change to the tick order does not silently burn an ordinal per tick.

## MINOR 2 — pass-1 MINOR 3 is half-applied: the `checkout_path === null` row answers a different question than the one raised

Pass-1 MINOR 3 asked for the row because *"C4 probes the **main checkout**, where merged reviews for
the same issue do exist, and redirects away from a name that is free where the review will actually
be written"*, and suggested declining to probe with no checkout. The pass-2 error table does add the
row, but it answers a different concern entirely: *"`reserveVerdict`'s `base` uses the same
expression, so the probe never resolves against the process cwd"* (`:276`). Process-cwd resolution was
never the hazard; probing the **wrong tree** was. Restate the row as: with `checkout_path === null`
the probe runs against `run.repo_root`, which carries every merged sibling's reviews, so condition 2
can skip an ordinal that is free where the file will actually be written — harmless, because skipping
forward never loses a review, but stated rather than implied. `src/cli.ts:224` initialises
`checkout_path: null` and `src/supervisor/tick.ts:169` is the only writer, so the window is real.

## MINOR 3 — `{{pass}}` and the file ordinal now diverge, and nothing says so

Every review prompt puts the counter in its title — `prompts/spec-review.md:1`
(*"pass {{pass}}"*), `prompts/pr-review-intent.md:1`, and the rest — fed by
`pass: String(counterFor(task, task.phase))` (`src/supervisor/tasks.ts:54`), which the design
deliberately leaves alone. After this change the two numbers come apart in both of the cases the
design is *for*: the `hpipe rewind <run> spec --task t1` flow (`:244-247`) renders *"pass 0"* into
`…-spec-review-2.md`, and the `pr-review-intent` re-entry (A12) renders *"pass 0"* into
`…-pr-review-intent-1.md`. Nothing parses `{{pass}}` back, so this is cosmetic — but the reviews are
the audit trail this issue exists to protect, and A5 claims the residual gaps are explicit. Add a line
to A4 or A5: the ordinal is the file identity and `{{pass}}` remains the escalation budget; they are
expected to disagree after a rewind or a loop re-entry.

## MINOR 4 — A10's exhaustion behaviour is self-inconsistent, and its cited precedent is the comment, not the guard

Two things in the bound. First, *"Records nothing, returns ordinal 0's path"* (`:278`) reproduces
BLOCKER 1 in miniature: the returned path is below the recorded maximum, so the prompt and
`recordedVerdict` disagree — and unlike BLOCKER 1's case it is specified deliberately. Under the fix
proposed there, the natural degradation is to return the floor (`highest recorded + 1`) and record it,
which keeps the pair in agreement; say that instead. Second, A10 cites
*"`src/supervisor/deliver.ts:130-137` already guards that loop against a synchronous throw"* — `:130-137`
is the comment block explaining the guard; the guard itself is the `try`/`catch` at `:139-148`. Cite
`:138-149`.

## MINOR 5 — the relative/absolute handoff at the two render sites is stated as a property but never as a step, and three smaller specification gaps ride with it

Pass-1 MAJOR 2's fix asked the spec to *"say explicitly that the value written to
`artifacts.verdicts[key]` is relative and the value rendered into `{{verdict_path}}` is absolute"*.
A7 (`:322-325`) does the first half well. The second half is left implicit: `reserveVerdict` returns
repo-relative, but both render sites need absolute — `src/supervisor/tasks.ts:55` is
`verdict_path: absoluteArtifactPath(run, task) ?? ''` and `src/supervisor/deliver.ts:248` joins
`run.repo_root` — so the required order is *reserve first, then read through `absoluteArtifactPath`*,
and the spec never says it. It would be caught (`test/tasks.test.ts:310` asserts the prompt contains
the absolute path), but it belongs in C2. Three smaller gaps in the same area: C2's pseudocode
(`:167-173`) shows only the `if (task)` branch and leaves the run branch (`src/supervisor/deliver.ts:105-106`)
to prose; `src/cli.ts:13` imports `taskRow` but not `runRow`, which C3's run branch needs
(`src/lib/phases.ts:77-81`); and while A6 correctly single-sources the *filename*, the base-directory
expression `task?.checkout_path ?? run.repo_root` (`src/supervisor/deliver.ts:113`) gains three new
copies at the reservation sites, which is the same drift one step down — worth either a tiny exported
helper or an explicit note that it is deliberately duplicated.

## MINOR 6 — two self-references are stale at HEAD

The header says *"Written against this worktree at `6688ffc`"* (`:3`) and *"answering
`docs/superpowers/reviews/issue-26-spec-review-1.md`"* (`:4-5`). HEAD is `b43b73f`, and that review
file no longer exists — `b43b73f` renamed both earlier reviews to `…-pass0-preserved.md` and
`…-pass1-preserved.md` precisely so this path could be reused. Every code citation still resolves
(nothing under `src/` changed in `3084e2c` or `b43b73f`), so this costs only a dangling pointer in the
audit trail — but that trail is what the issue is about. Repoint both.

---

BLOCKER 1 is the one that has to go back: C1's two functions are specified as a matched pair and are
not one, the disagreement is reachable through a workflow this repo's own history records four times,
and its symptom is the silent deadlock the ruling exists to prevent. The fix is a one-clause change to
`reserveVerdict`'s walk plus one unit test, but an implementer following the spec literally ships the
defect, and the spec's own contract test would not catch it. MAJOR 1 is an inline correction to A5 and
one added runbook step; it changes no decision.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 1
