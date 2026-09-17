# Plan review pass 0 — issue #9, artifact path adoption

**Plan:** `docs/superpowers/plans/2026-09-17-issue-9-plan.md`
**Spec:** `docs/superpowers/specs/2026-09-17-issue-9-design.md` (v3, cleared at spec pass 1)
**Baseline confirmed:** `bun test` → 351 pass / 0 fail / 33 files; `bun run typecheck` clean at `7263fbb`.

## Method

I did not read the plan and reason about it. I executed it. The whole worktree was rsync'd to a
scratch copy outside the repo, steps 1-9 were applied **literally** — the code blocks as written,
the prompt replacement as written, the tests as written — and the step-10 gate was run against the
result. The git behaviours the plan asserts (`--diff-filter=A` under `diff.renames=false`, the
`rev-parse`/`diff` exit codes in a repo with no `main`, `Bun.spawn` with a null `-C`) were each
reproduced in throwaway repos. The repo worktree itself was never modified.

**Result of executing the plan as written: 360 pass / 1 fail.** Typecheck clean. One finding below
is that failure; the rest are gaps the green suite does not catch.

---

## BLOCKER 1 — step 9's green does not make step 9's red pass; the final gate fails

**Claim.** Plan:610, after the `prompts/worker-brief.md` replacement: "→ passes." And plan:619:
"`bun test` # expect 361 pass, 0 fail, 33 files".

**Problem.** The assertion string at plan:586 spans a hard line break in the replacement text at
plan:604-607, so `toContain` cannot match it. `renderPrompt` does no whitespace normalisation
(`src/lib/render.ts:8-14` — a single `String.replace` over `{{...}}` tokens), so the newline reaches
the assertion verbatim. Executed literally, step 9 ends red and step 10's gate fails.

**Evidence.**

    plan:586   expect(result.text).toContain('does not satisfy this phase\'s contract')

    plan:606   number, and every later phase cites the path by name. An artifact written anywhere else does not
    plan:607   satisfy this phase's contract.

Applied to the scratch copy and run:

    $ bun test
    331 |   expect(result.text).toContain('does not satisfy this phase\'s contract')
    error: expect(received).toContain(expected)
    Expected to contain: "does not satisfy this phase's contract"
    Received: "... An artifact written anywhere else does not\nsatisfy this phase's contract. ..."
    (fail) the brief states the path contract without promising a recovery
     360 pass
     1 fail
    Ran 361 tests across 33 files.

The other eight new tests pass, typecheck is clean, and the 361/33 arithmetic is exactly right — so
this is the single defect standing between the plan and its own gate.

There is a second-order problem. Plan:7-9 states: *"Every step below was executed end to end against
this worktree before the plan was written, then reverted. The code in each step compiles and its
tests pass."* That is demonstrably untrue of step 9, which means the sentence cannot be relied on as
provenance for the rest of the document. (I checked the rest independently; it holds. But the claim
itself has to go or be scoped.)

**Fix.** Rewrap the replacement text so the asserted phrase is contiguous. Verified in the scratch
copy — with this and nothing else changed, `bun test` → **361 pass / 0 fail / 33 files**, typecheck
clean:

```
Those paths are relative to this worktree, which is your cwd. Write them exactly as given, stem and
all — do not re-derive them from the conventions you see in `docs/`. The stem carries the issue
number, and every later phase cites the path by name. An artifact written anywhere else
does not satisfy this phase's contract.
```

(Reflowing the test's assertion instead — `toContain("satisfy this phase's contract")` — also goes
green, but it drops the word the assertion exists to pin: pass-1 MAJOR 2 was specifically about
*"does not **complete the phase**"* versus *"does not **satisfy** this phase's contract"*, and an
assertion that no longer contains "does not" stops guarding that distinction. Rewrap the prompt.)

Also amend plan:7-9 so it claims only what was done.

---

## MAJOR 1 — step 4 does not start with a failing test, and the code it adds is behaviourally inert

**Claim.** Plan:266: "→ fails to compile: `adoptableArtifacts(null, …)` is not assignable to
`string`." Plan:268: "**Green.** Widen the signature and add the two guards…"

**Problem.** `bun test` does not typecheck — Bun strips types. Step 4's test **passes** against the
step-3 implementation, and it passes for the same reason after the change: every one of its three
cases already returns `[]` through the `diff.code !== 0` path. Neither guard the step introduces
changes any observable behaviour, and nothing in the suite would notice if an implementer skipped
them. Spec **A7** ("a null `checkout_path` would point the scan at the main checkout — the
wrong-adoption branch A5 calls unrecoverable", spec:391-397) and **A3** (spec:360-364) are therefore
asserted in the plan and untested in the result.

**Evidence.** In the scratch copy, both guards removed and the parameter loosened, step 4's test left
exactly as the plan writes it:

    $ bun test test/deliver.test.ts
     30 pass
     0 fail

And the reason each case is already inert — `Bun.spawn` stringifies the null, so `git -C null` can
never reach the process cwd:

    $ bun run t.ts     # git(null, ['diff','-z','--name-only','--diff-filter=A','main...HEAD','--','docs/'])
    {"code":128,"text":""}

    $ git init -q --initial-branch=trunk . && git commit -qm base      # the "no main" case
    $ git diff -z --name-only --diff-filter=A main...HEAD -- docs/
    fatal: bad revision 'main...HEAD'                                   → rc=128

**Fix.** Two honest options; take either, but stop calling it a red step.

1. Relabel step 4 as a **characterisation + hardening** step: state plainly that the red is
   `bun run typecheck`, not `bun test`, that the three cases already hold through the non-zero-exit
   path, and that the guards are kept because A3 and A7 want the contract expressed at the top of the
   function rather than inferred from git's exit codes. Fold its assertions into step 1 as
   characterisation tests so the plan has no step whose "red" is unrunnable.
2. Or drop the two guards and let the `diff.code !== 0` path carry both, adjusting the spec's error
   table row wording to match. (I do **not** recommend this — the guards are the only place the
   design's intent is legible — but it would at least make the step's claim true.)

---

## MAJOR 2 — spec test row T7 has no step; nothing pins the cost gate that the spec calls load-bearing

**Claim.** The plan's Files table (plan:13-21) maps steps to files, and steps 6-8 cover the
`gatherSignals` wiring.

**Problem.** Spec:480 requires **T7 — `liveIdle: false` with a valid candidate present → no adoption,
"proves the scan is gated, not merely ineffective."** No step implements it. This is not a spare
test: spec:231 says *"The `if (!actorIdle) return base` guard stays first and is load-bearing for
cost"*, and step 6 is precisely the step that restructures that block — it converts today's negative
early-return on `isFresh` into a positive branch and inserts nine new lines plus two git subprocess
spawns below it. Nothing in the suite would fail if the `actorIdle` guard were moved below the
adoption scan, which would spawn two `git` processes per task per 1s tick for the whole of every
`research`, `spec` and `plan` phase.

The existing test that looks like it might cover this does not:
`test/tasks.test.ts:66-74` sets `liveIdle: false` on a `spec` task, but its `checkout_path` is
`'/r/.worktrees/feat-x'`, which does not exist — so the scan would return `[]` there whether it is
gated or not. It cannot distinguish "gated" from "ineffective", which is the exact wording spec:480
uses.

**Evidence.** `grep -n "liveIdle" docs/superpowers/plans/2026-09-17-issue-9-plan.md` → no match. No
step mentions a busy actor with a live candidate.

**Fix.** Add to step 6, after its adoption test (a real candidate plus a busy worker):

```ts
test('the adoption scan does not run while the worker is still working', async () => {
  const worktree = repoWithWorktree(['docs/superpowers/plans/old-a.md'])
  commitIn(worktree, 'docs/superpowers/notes/misfiled.md', 'the note\n')

  const run = mkRun([mkTask({
    phase: 'research', phase_entered_at: 0, checkout_path: worktree, artifacts: designArtifacts(),
  })])

  await advanceTasks(run, deps({ liveIdle: async () => false }))
  expect(run.tasks[0]?.phase).toBe('research')
  expect(run.tasks[0]?.artifacts.research).toBe(designArtifacts().research)
})
```

The fixture is identical to step 6's, so this is one paste; it is red if the `actorIdle` guard ever
moves, which is the property spec:480 is buying.

---

## MINOR 1 — spec test rows T2 and T4 have no step either

Spec:475 (**T2** — pre-existing docs `touch`ed after the worker's commit, still adopted, "proves
mtime-independence") and spec:477 (**T4** — no commits on the branch → no adoption) are unmapped. No
plan step calls `utimesSync`/`touch`, and no step exercises a worktree with `main` present and no new
commit.

T2's underlying property is subsumed — step 6's fixture is a real `git worktree add`, so every
pre-existing doc already carries a current mtime, and step 6's test would fail against v1's mtime
design with four candidates. But the spec calls the explicit touch "the property that makes it worth
writing" (spec:469-470), and an mtime-free implementation is exactly the thing a future refactor
might quietly undo. T4's zero-candidate path is exercised incidentally by step 5's rename test, never
by name.

**Fix.** Two short additions to step 6, sharing its fixture: one that `utimesSync`es the pre-existing
docs to `Date.now()` after `commitIn` and asserts the adoption still happens; one on a worktree with
no commit past the base, asserting `artifacts.research` is untouched and the phase stays.

## MINOR 2 — `loggedAmbiguous`'s stated precedent does not hold for its storage, and it couples tests

Step 8's comment (plan:529-533) says the dedup Set is "like stall.ts's `alreadyProbed`
(src/supervisor/stall.ts:62-64)". The citation is right about the *key shape* —
`taskStallKey` at `src/supervisor/stall.ts:62-64` is `${run_id}:${task_id}:${phase}:${phase_entered_at}`
— but `alreadyProbed` is a **parameter**, owned by its caller
(`src/supervisor/stall.ts:29,67`; created at `src/supervisor/main.ts:109` inside the supervisor loop
and threaded through at `:239,:255`). The plan's version is a module-level singleton, which is not
that pattern. Consequence in the suite: step 8's key is `t1:research:0`, the same tuple step 6's task
carries, and `bun test` shares a module registry across files — any future test that produces two
candidates for `t1`/`research`/`0` will see zero log lines and fail for a reason that has nothing to
do with its subject.

**Fix.** Either correct the comment to say it mirrors the key shape and not the ownership, or (better,
and no larger) pass the Set in on `TaskDeps` the way `alreadyProbed` is passed, which also makes step
8's test independent of module load order.

## MINOR 3 — the new git fixtures leak real repos and worktrees, with no teardown

`repoWithWorktree` (plan:57-72) creates two `mkdtemp` trees and registers a linked worktree in the
first one's `.git/worktrees/`, per call. Nine new tests call it; nothing removes them, and
`test/deliver.test.ts` and `test/tasks.test.ts` have no `afterEach`. `test/cli-commands.test.ts:24-27`
shows the repo does have the `rmSync` habit, and the existing `worktreeWith` leak
(`test/tasks.test.ts:247-252`) is a single empty temp dir, not a git repo with worktree metadata.

**Fix.** Have `repoWithWorktree` and `commitIn`'s callers register their dirs in a module-level array
and add one `afterEach(() => { for (const d of created) rmSync(d, { recursive: true, force: true }) })`
to each of the two test files.

---

## Verified sound, and deliberately not raised as findings

So the fixes above are not read as a general verdict on the plan, here is what I checked and found
correct. All of it was run, not reasoned about.

- **Step 5's rename claim is real, and the pinned flag is the right fix.** Reproduced in a scratch
  repo with `diff.renames=false` in repo config and a linked worktree (config is shared via the common
  dir, so the fixture's `repoConfig` does reach the worktree): the default read returns
  `docs/superpowers/notes/renamed.md`; `-c diff.renames=true` returns empty.
- **Step 5's non-ASCII test passes as claimed**, on APFS, with the stored path raw UTF-8.
- **Step 6 leaves the tree committable.** I removed the step-7 `existsSync` line from the finished
  copy to reproduce the step-6 intermediate: `bun test test/tasks.test.ts` → 30 pass / 1 fail, and the
  single failure is step 7's own test. No pre-existing test breaks in between. In particular
  `test/tasks.test.ts:265-274` (the stale-file guard) survives step 6 because its `worktreeWith` dir
  is not a git repo, so the scan returns `[]` — and survives step 7 through the `existsSync` branch,
  exactly as plan:623-629 says.
- **Step 7's red is the production hazard it claims to be**: `commitIn`'s `git add -A` does sweep the
  canonical spec into the commit, `claimed` does filter it out, and the stray doc is the lone
  survivor. Confirmed by running the step-6 intermediate.
- **`noUncheckedIndexedAccess` is on and `noUnusedLocals` is off** (`tsconfig.json`), so step 6's
  `candidates.length === 1 ? candidates[0] : undefined` typechecks and step 6's `existsSync` import,
  unused until step 7, does not break the intermediate commit. There is no lint step in CI
  (`.github/workflows/` carries only PR-title lint and release-please), so nothing else gates it.
- **Step 10's numbers are exact**: 361 pass, 0 fail, 33 files — the helper at `test/helpers/` is not
  matched as a test file, and the per-step arithmetic (352, 353, 354, 355, 357, 358, 359, 360, 361)
  is right at every step.
- **The `adoptableArtifacts` deviation from spec §C1's `adoptableArtifact(): Promise<string|null>` is
  correct and correctly declared** (plan:26-33). §C1's log line needs the count and the paths; the
  `length === 1` / `length > 1` split is exactly §Data-and-control-flow steps 4-6, and `isSettled` is
  still called on the single survivor only, per spec:337-339.
- **Every cited `file:line` in the plan resolves.** `src/supervisor/deliver.ts:89,93` (verdicts read,
  never written), `src/lib/predicates.ts:10-20`, `src/lib/machine.ts:94`, `src/lib/phases.ts:97,102-103`,
  `test/tasks.test.ts:254-263` and `:265-274`, `test/cli-commands.test.ts:159-176` and `:304-319`,
  `prompts/worker-brief.md`'s replaced paragraph (byte-identical to the quote at plan:596-598),
  `src/lib/gh.ts:30-42` as the spawn precedent, `prompts/dispatch.md:8` for `--base main`.
- **Function names, signatures and types stay consistent step to step.** `adoptableArtifacts`
  widens `string` → `string | null` once, at step 4, and every later call site matches. `Task['artifacts']`
  indexing by `taskRow(phase).artifact` is sound against `src/lib/types.ts:63-68` and
  `src/lib/phases.ts:16`. No placeholders, no "then wire it up" steps: every step gives the exact
  insertion anchor and the exact text.

BLOCKER 1 is a one-line rewrap and MAJOR 1-2 are contained edits to steps 4 and 6; none of them
touches a decision the spec settled, and none needs a human call. The verdict below is BLOCKER only
because, executed literally, this plan does not reach green — and because the provenance sentence at
plan:7-9 has to be corrected alongside it.

VERDICT: BLOCKER
BLOCKERS: 1
MAJORS: 2
