# PR #27 — intent review, pass 0

**Branch:** `fix/9-artifact-paths` · **PR:** #27 · **Issue:** #9
**Judged against:** issue #9 (original text, the 2026-09-17 research correction, and the 2026-09-17
scope ruling), `docs/superpowers/specs/2026-09-17-issue-9-design.md` (v3) and
`docs/superpowers/plans/2026-09-17-issue-9-plan.md` (v3).
**Scope of this pass:** intent only — completeness against the two documents, silent scope
reduction, scope expansion, and whether the tests exercise behaviour. Code quality is stage 2 and is
not assessed here.

## Gate, re-run independently

    $ bun test          → 368 pass / 0 fail / 795 expect() / 33 files
    $ bun run typecheck → clean (no output)

Matches plan §Step 10's declared gate (`368 pass, 0 fail, 33 files`) and the PR body exactly. Working
tree was clean before and after; the git fixtures live in `tmpdir()` and are reaped by
`cleanupFixtures` (`test/helpers/git-worktree.ts:47-50`).

## Issue coverage

The issue as it stands is not the original text: the 2026-09-17 research correction supersedes the
"Directions" section and instructs the spec to *"choose between fixing the path, the delivery, or the
missing-artifact signal, and justify the choice against the measured discriminator"*, and the
2026-09-17 scope ruling narrows the deliverable to *"a task whose worker misfiled its artifact
advances whenever the branch identifies exactly one candidate … plus a supervisor log line on the
branches where it cannot."*

| Issue requirement | Status |
|---|---|
| Choose one of the three fixes and justify against the measured discriminator | **Met.** Detection is fixed, not the path or the delivery; spec §Problem and **A2** justify it, and the PR body carries the same reasoning. |
| Decline of direction 1 (derive the directory) is argued, not silently dropped | **Met.** Spec **A11** (spec:412-419) plus a body section; the decline is grounded in the three measured filenames, which deviated in stem as well as directory. |
| Adoption advances the task whenever the branch names exactly one candidate | **Met.** `src/supervisor/tasks.ts:257` adopts on `length === 1`; `deliver.ts:142-163` produces the set. |
| Covers all three measured berean-os failures | **Met in principle and reproduced in test.** The spec's three `git diff` transcripts against the real commits each return one candidate, and `test/tasks.test.ts:315` reproduces the shape in a real worktree where the canonical `docs/superpowers/research/…` directory does not exist. |
| A supervisor log line where adoption cannot fire | **Met on the ambiguous branch only** — see MINOR 1. |
| The human-visible "artifact is absent" signal | **Correctly out of scope.** The ruling assigns it to #23; spec §Non-goals and the PR body both say so. |
| Stall probe's `{{artifact_path}}` substitution (`src/supervisor/main.ts:262-264`) | **Correctly out of scope.** The issue's correction says to coordinate with #15; #15 has claimed it. Nothing in the diff touches `main.ts`. |

## Spec coverage

Every numbered step of §C1 is present and in order: null checkout (`deliver.ts:148`), `rev-parse
--verify --quiet main` (`:150`), `git diff -z --name-only --diff-filter=A main...HEAD -- docs/`
(`:153-155`), the `docs/superpowers/reviews/` drop (`:161`), the `claimed` drop (`:162`), and
"exactly one survivor" in the caller (`tasks.ts:257`). The §C1 wiring lands as specified: the
`actorIdle` guard stays first (`tasks.ts:232`), the happy path is unchanged in behaviour
(`:237-240`), the **absence** gate — pass 1's MAJOR 1 — is `existsSync(absolute)` at `:246`, not
`!isFresh`, and the adopted path is written back to `task.artifacts[slot]` at `:269`, which
`src/supervisor/main.ts:217` persists. Error handling matches the spec's table row for row, including
`-c diff.renames=true` pinned on every invocation (`deliver.ts:121`) per **A12**, and `isSettled`
called on the single survivor only (`tasks.ts:266`).

§C2 lands verbatim: `prompts/worker-brief.md:31-34` is the spec's replacement sentence word for word,
the falsified *"stats those paths and nothing else"* clause is gone, and the firm register **A10**
demanded is intact — the brief does not advertise the fallback. I grepped `prompts/` and `src/` for
other copies of the now-false claim and there are none, so C2 is complete rather than partial.
`src/lib/worker-prompt.ts` and `src/cli.ts` are untouched, exactly as spec v3 and plan §"What is
deliberately not here" say they should be.

Spec test rows T1-T13 all land, and each is the behavioural assertion the row asks for rather than a
restatement of the implementation — phase transition plus the recorded path, against a real
`git init` + `git worktree add` fixture:

T1 `test/tasks.test.ts:315` (3 pre-existing docs, canonical directory absent) · T2 `:332` with an
explicit `utimesSync` · T3 `:409` (three ticks, exactly one log line) · T4 `:364` · T5
`test/deliver.test.ts:287` · T6 `test/tasks.test.ts:435` (with `run.repo_root` pointing at a repo
that does hold a stray candidate) · T7 `:351` · T8 `:376` · T9 the two pre-existing tests at `:254`
and `:265`, unmodified and green · T10 `test/deliver.test.ts:275` · T11 `:393` · T12
`test/deliver.test.ts:308` · T13 `:319`.

T5's test asserts the verdict is filtered *out of a two-path set* rather than that a verdict-only
branch yields nothing; that is the stronger of the two, and the zero-candidate caller behaviour is
pinned separately at `test/tasks.test.ts:364`, so the row is covered in substance.

Both deviations from the spec are declared in the plan (§Deviations) **and** in the PR body:
`adoptableArtifacts(): Promise<string[]>` instead of the sketched nullable singular, and a separate
`cmdBrief` test (`test/cli-commands.test.ts:321`) instead of extending `:304`. Neither changes
behaviour. The plan's three characterisation tests are labelled as unable to go red and the PR body
repeats that, which is honest disclosure rather than coverage theatre. `TaskDeps.ambiguityLog?` being
optional (`tasks.ts:37`) is the plan's declared reason for not editing `main.ts`, i.e. it exists to
*avoid* scope expansion.

## Scope expansion

None. The diff is `src/supervisor/deliver.ts`, `src/supervisor/tasks.ts`, `prompts/worker-brief.md`,
three test files and one new test helper, plus this task's own pipeline docs. All three source/prompt
files are inside `t1.files`; `src/cli.ts` and `src/lib/worker-prompt.ts` — also in the set — are
deliberately untouched. Nothing reaches `t2`'s files (`main.ts`, `stall.ts`, `status.ts`,
`prompts/stall-probe.md`), nor `types.ts`, `phases.ts` or `machine.ts`. No new `Task` field, no phase
machine change.

## Findings

### MINOR 1 — the zero-candidate branch still returns in silence, and the body does not say so in those words

`tasks.ts:258-263` logs only when `candidates.length > 1`. The zero-candidate case — the worker went
idle, the canonical path is absent, and the branch added no adoptable doc — returns `base` with
nothing emitted, which is today's behaviour.

This is what the spec prescribes (spec:308 *"Zero survivors → `base`. Identical to today."*,
spec:335, and **A13** as applied from pass 1's MAJOR 3), so the implementation is faithful. But the
spec's own Goal two hundred lines earlier says *"On the branches where it cannot, the supervisor
**logs why** rather than returning silently"* (spec:110), and the scope ruling on #9 says *"plus a
supervisor log line on the branches where it cannot"* — plural, and zero-candidate is one of them.
The PR body's "Not covered, deliberately" describes the omission as the *human-visible* signal on
both branches, which is true but understates it: on the zero-candidate branch there is no log line
either.

No change requested. The design reason is sound and the spec settled it twice (a zero-candidate log
would fire once per phase entry on every worker that merely goes idle before writing, and the dedup
key would then suppress the message at the point it would actually mean something), and #23 owns the
real signal. Worth one sentence in the body so a later reader does not infer from "a supervisor log
line on the branches where it cannot" that both branches log. A body edit, not a code change.

---

No BLOCKERs and no MAJORs. The load-bearing mechanism is the one the cleared spec specifies, the gate
it claims is the gate it reaches, the guards that pass 1 found unpinned are now pinned by tests that
were each verified to bite, and the two declared deviations are declared in both documents that
matter. The decline of issue direction 1 is a documented, evidence-backed choice the issue's own
correction invited, not a silent reduction.

VERDICT: CLEAR
