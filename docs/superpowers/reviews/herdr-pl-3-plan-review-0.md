Tier: standard

# herdr-pl-3 plan review 0

Plan: `docs/superpowers/plans/2026-11-14-herdr-pl-3-plan.md`
Spec: `docs/superpowers/specs/2026-11-14-herdr-pl-3-design.md`

## What I checked

- **Spec coverage.** Every Architecture item maps to a step: the field (§1) to Step 1.1, recording
  on a move (§2) to Step 1.3, `holdsPane` (§3) to Step 2.2, the three guards (§4) to Steps 3.2, 4.2
  and 5.2, and clearing with the pane (§5) to Step 2.2 (`releaseWorkerPane`, a changing
  `bindWorkerPane`) and Step 6.2 (`forget`). Every test in the spec's Testing strategy has a
  counterpart, including the dedupe (plan :60-68), the keeps-the-id case (:71-76), the duplicate
  event (:78-83), both finished-task guards (:317-323, :435-443) and the human-blocked resume after
  release (:325-337). No step narrows a requirement.
- **Every write of `task.pane_id` is covered by the clearing rule.** `grep "pane_id ="` over `src`
  finds only `src/cli.ts:3198` (`forget`, Step 6.2), `src/lib/unstarted.ts:236` (`bindWorkerPane`,
  Step 2.2), `src/lib/unstarted.ts:259` (`releaseWorkerPane`, Step 2.2) and
  `src/supervisor/tick.ts:509` (the move itself, Step 1.3). Every supervisor release reaches
  `releaseWorkerPane`: `losePane` (`tick.ts:292`, `:303`), `releaseAbortedPane` (`tick.ts:326`),
  agent released (`tick.ts:535`), teardown (`teardown.ts:57`). `cli.ts:405` is the orchestrator
  record, not a task.
- **A stale-id event cannot wipe the list.** A `pane.agent_detected` carrying the old id matches no
  task, because `tick.ts:518-519` matches on `t.pane_id`, so it never reaches `bindWorkerPane`. The
  brief hand-over binds the pane the orchestrator passes (`cli.ts:1400`), and a re-brief to the
  current id takes the early return and keeps the list (plan :165-166 tests that).
- **The fixtures the new tests lean on exist and behave as assumed.** `abortableRun`
  (`test/cli-commands.test.ts:103-113`) gives t1 `implement` and t4 `done`; `cmdAbort` leaves
  `pane_id` in place (existing test `:347-356` refuses `w3:p1` after an abort); a `pane.closed` on
  an aborted run goes `losePane` → `releaseAbortedPane` → `releaseWorkerPane` (`tick.ts:286-288`,
  `:323-327`), so Task 4's third test exercises the real release path. `heldTask` defaults to
  `w7:p1` (`test/before-merge-cli.test.ts:151-161`), so Task 5's finished-task test is not refused
  by t1's own pane. `applyEvents`, `listRuns` and `saveRun` are already imported in
  `cli-commands.test.ts` (`:21`, `:23`).
- **Guard logic.** Step 1.3's extra `event.previous_pane_id !== undefined` changes nothing at
  runtime (`found` is already null when it is undefined, `tick.ts:504-506`); it narrows the type for
  the append. The resume rewrite keeps the null handling (`?? null` then `caller === null`), and
  `tier` keeps its own null check (`cli.ts:2930`).
- **File lock.** The two `FILES:` lines (plan :6-7) sit at column 0 outside any fence and name every
  file the steps touch: the five `src` files and the five test files. No step touches anything else.
- **No push or PR step.** The plan says never push (:4, :550) and leaves the live check to after
  merge (:552-557).

## Findings

No BLOCKERs, no MAJORs.

### MINOR 1 — Step 4.1 gives the wrong reason the release test passes before Step 4.2

**Claim.** Plan :343-345: "the third passes because Task 2 already clears the list on release."

**Problem.** At Step 4.1, `resume` still matches on `task.pane_id` alone (`src/cli.ts:3115-3116`),
and the released task's `pane_id` is null, so the final `ok` is `true` whether or not Task 2 cleared
anything. Only the `toBeUndefined()` assertion on `former_pane_ids` (plan :334) depends on Task 2.
The resume half of that test starts guarding something only once Step 4.2 lands. A tester reading
the note could think the green run at 4.1 proved the clearing reaches `resume`.

**Fix.** Reword :344-345 to: "The other two pass: the second guards the phase filter; the third's
`former_pane_ids` assertion passes because Task 2 clears the list on release, and its resume
assertion starts to guard that clearing once Step 4.2 makes `resume` read former ids."

### MINOR 2 — Step 7.1 tells the implementer to fix an outside test "inside this plan's files"

**Claim.** Plan :541-543: if a test outside the listed files fails because of this change, "fix it
inside this plan's files and declare any new file in your report."

**Problem.** A test outside the listed files cannot be fixed inside them, so the sentence invites an
edit outside the `FILES:` lock and reports it afterwards. I found no such test likely to break: the
existing move and release tests assert single fields, and `test/teardown.test.ts:66, :72` uses
`toMatchObject`, which ignores an absent extra field.

**Fix.** Replace the sentence with: "If this change caused it and the file is not on a `FILES:` line,
stop and raise it with `hpipe decide` before editing; the lock does not cover it."

## Verdict

The plan implements every requirement in the spec, clears the list on every path that unbinds or
replaces a task's pane, and its tests check the guards from both the current and the former id with
exact-text comparison. The two MINORs are about wording and can be fixed where they stand.

VERDICT: CLEAR
