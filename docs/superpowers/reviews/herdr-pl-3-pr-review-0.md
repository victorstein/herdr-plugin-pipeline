Tier: standard

# herdr-pl-3 PR review 0 — PR #174, `fix/moved-pane-guards`

Reviewed `gh pr diff 174` (code: `src/cli.ts`, `src/lib/tiers.ts`, `src/lib/types.ts`,
`src/lib/unstarted.ts`, `src/supervisor/tick.ts`; tests in five files) against the brief
(`hpipe brief --task t3`), the spec `docs/superpowers/specs/2026-11-14-herdr-pl-3-design.md` and the
plan `docs/superpowers/plans/2026-11-14-herdr-pl-3-plan.md`.

Verification run here: `bunx tsc --noEmit` clean. The five touched test files: 365 pass, 0 fail.
The full `bun test` run gave 2365 pass and 1 fail. The failure was
`test/cli-argv.test.ts` "--help and -h print that subcommand's usage before any side effect", which
timed out at its 5000 ms limit on a machine at load average about 14. It passes alone with
`--timeout 30000`. It only spawns `--help` subprocesses, and no code it touches is in this diff, so it
is an environment timeout, not a regression.

## Intent

**Acceptance criteria.**

- `test/tick.test.ts`: a move from `w3:p2` to `w5:p2` sets `pane_id` and `former_pane_ids: ['w3:p2']`.
  A second move appends (`test/tick.test.ts:1149-1162`). A move that keeps the id leaves the field
  undefined (`:1126`). Met.
- `test/tiers.test.ts`: `pipelinePanes` includes former ids (`test/tiers.test.ts:70-72`). Met.
- `resume` and a before-merge check are refused from a former id with the same wording as from the
  current one. `resume` is tested at `test/cli-commands.test.ts:366-379`. `hold` and `confirm` are
  tested at `test/before-merge-cli.test.ts:187-209`. Each test compares the former-id text with the
  current-id text after swapping the id. Met. The before-merge test is in `before-merge-cli.test.ts`,
  not `cli-commands.test.ts`, so it can reuse that file's fixtures. The spec (Testing strategy), the
  plan (Task 5) and the PR body all say so, so this is a flagged departure, not a silent one.
- `tsc` and `bun test` pass, apart from the load-related timeout above.

**Spec requirements.**

- §1, the field: `src/lib/types.ts:274-280`. It is optional and its doc comment follows
  `last_pane_id`'s. Done.
- §2, the append on a move: `src/supervisor/tick.ts:508-515`. It skips duplicates, and `findTask`
  still matches on `pane_id` only (A6). The test that delivers herdr's event and then the reconcile's
  own copy now asserts a single entry (`test/tick.test.ts:1250`). Done.
- §3, `holdsPane` in `unstarted.ts` beside the pane helpers: `src/lib/unstarted.ts:268-274`. Done.
- §4: `paneRefusal` (`src/cli.ts:2399`) and `resume` (`src/cli.ts:3114-3121`) use `holdsPane`, and
  both messages are unchanged. `pipelinePanes` adds the former ids with no phase filter
  (`src/lib/tiers.ts:73`). Its doc comment drops the moved-pane gap and keeps the `claim` gap. The
  tier guard at `src/cli.ts:2930` reads `pipelinePanes`, so it is covered with no CLI change. Done.
- §5, the list goes with the pane: `releaseWorkerPane` (`src/lib/unstarted.ts:261`), `forget`
  (`src/cli.ts:3201`) and `bindWorkerPane` after its same-pane early return (`src/lib/unstarted.ts:237`)
  all delete it. I grepped every write to `pane_id` in `src/`. The only writes are these three, the
  move handler (`tick.ts:514`) and task creation. Every supervisor release (`tick.ts:292, 303, 326, 540`,
  `teardown.ts:57`) goes through `releaseWorkerPane`, so no path leaves a stale former id behind. Done.
- Testing strategy: every bullet has a test. These include a finished task's former id, for both
  `resume` (`test/cli-commands.test.ts:381-387`) and `hold` (`test/before-merge-cli.test.ts:211-218`).
  The human's `resume` succeeds after the moved pane closes, and that test drives the real `pane.closed`
  path through `applyEvents` (`test/cli-commands.test.ts:389-401`). There are also release and rebind
  clearing tests (`test/unstarted.test.ts:204-219`) and a `forget` clearing test
  (`test/cli-commands.test.ts:486-495`).

**Scope.** Nothing outside the three guards and the field's lifecycle is touched. No schema bump and
no `phases.ts` change, matching A1. No scope reduction and no expansion.

**Plan conformance.** The code matches the plan's steps exactly, including the extra
`event.previous_pane_id !== undefined` clause in Step 1.3 (needed for type narrowing) and the
`caller` local in Step 4.2. Each plan task is its own commit. The tests in the moved-back case
(`test/tick.test.ts:1164-1172`) are an addition the plan also carries.

**Tests exercise behaviour.** The guard tests go through `cmdResume`, `hold` and `confirm` against a
saved ledger and compare the refusal text between the two ids. They do not just call `holdsPane`. The
clearing test for `resume` reaches the cleared state through a real `pane.closed` event, not by
editing the ledger.

## Quality

- **One way to do it.** The field copies `last_pane_id`'s pattern: optional `Task` field, written in
  the task-pane helpers, read by `pipelinePanes`. `holdsPane` is the one predicate both CLI guards
  use, and it sits beside `bindWorkerPane` and `releaseWorkerPane`. `pipelinePanes` reads the field
  directly because it builds a set (spec A8). That is consistent, not a second path.
- **Naming and structure** match the siblings (`former_pane_ids` next to `last_pane_id`, `holdsPane`
  next to `bindWorkerPane` and `releaseWorkerPane`).
- **Comments.** The new doc comments on the field, `holdsPane` and `pipelinePanes`, and the rewritten
  `resume` comment, each give a reason the code cannot show: the agent's stale `HERDR_PANE_ID`, and
  herdr reusing ids. None restates the next line. There is no dead or commented-out code.
- **Error handling.** No new failure mode. Every read of the field tolerates its absence (`?.`,
  `?? []`, `?? false`), and the null-caller handling of all three guards is unchanged.
- **Duplication.** None. The tests reuse each file's existing fixtures (`abortableRun`, `heldTask`,
  `perTaskRun`, `mkTask`, `mkRun`) and do not add new helpers.

## Findings

None. The work meets every acceptance criterion and spec requirement. The one departure, the test
file for the before-merge guard, is flagged in the spec, the plan and the PR body. I found no defect,
drift or duplication worth ranking.

VERDICT: CLEAR
