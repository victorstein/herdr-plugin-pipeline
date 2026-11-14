Tier: heavy

# herdr-pl-4 plan review 0 — board: enter stages a worker, tab focuses, z zooms

Reviewed: `docs/superpowers/plans/2026-11-14-herdr-pl-4-plan.md` at `54e5548`, against
`docs/superpowers/specs/2026-11-14-herdr-pl-4-design.md`. I checked it against the code on this branch:
`src/board/ui.ts`, `src/kit/stage.ts`, `src/lib/boards.ts`, `src/lib/store.ts`,
`src/supervisor/boards.ts`, `src/actions/board.ts`, `src/supervisor/tick.ts`, `test/kit/*` and
`test/helpers/before-merge.ts`. I did not apply or build the plan.

## Verified and holding

- **Spec coverage.** Every requirement maps to a step:
  - the spec's six functions (Tasks 1–4);
  - `ui.ts`: `staged`, reconcile last in both `refresh` branches, `enter` with the A19 re-read,
    `tab`/`z`, and `quit` on `serial` (Task 7);
  - `KEYS` (Task 5), the manifest pane (Task 6) and the README (Task 8).
  
  Every test in the spec's list has a counterpart in Tasks 1–6. The live-check steps that replace the
  spec's "run this branch's rebind" with the rebind's input (the same `term=` under a new pane id) are
  flagged in the plan itself (`plan:893-896`). Their reasoning holds, because `tick.ts:503-516` is
  unchanged and unit-tested.
- **The unit tests are not hollow.** I traced each fixture through the kit:
  - The `expected` test (`plan:242-257`) fails if `syncStage` drops `expected`. Its evict move clears
    the record before `recordStaged` runs.
  - The replaced-mid-move test (`plan:385-408`) fails if the post-move guard is missing.
  - The order test (`plan:358-366`) pins the move home before the new placeholder opens.
  - The A17 test covers `workspace_id: null` and the under-this-board pass.
  - The expected counts (5/10/15/17) match the tests written.
- **Ordering.** `syncStage` keeps `refresh`'s snapshot, read before the record (A18). `quit`'s
  `.finally` is registered before any refresh queued after it, so `process.exit` runs first.
- **File lock.** The `FILES:` lines at `plan:28-30` sit at column 0, outside any fence, and list every
  file Tasks 1–8 touch. Task 9 writes only under `$HPL4_STATE`, outside the repo.
- **Steps after implementation.** No step pushes, opens a PR or runs `hpipe submit`. Task 9 ends in
  `hpipe decide`, with the required `--recommend` (`src/cli.ts:2238`).

## Findings

### MAJOR 1 — Task 9's `hpipe decide` steers the owner to skip the only check of `ui.ts`, and claims that check is already covered

**Claim.** Step 12's recommendation (`plan:1098`) says to check the keys after release, because "the
keys only wire the harness-verified functions to stdin, the \n/\r split is unit-tested".

**Problem.** That is not what Task 7 writes. Task 7 adds logic of its own that no unit test or
harness step runs (`plan:630-631` says only `tsc` and the full suite verify it):

- **The A19 re-read.** `snap = await readSnapshot(herdr)` after `stageCard` (`plan:750-751`) is the
  fix for spec review 0 MAJOR 1. The harness cannot show that bug: its `focus` and `zoom` commands
  read a fresh snapshot on every call (`plan:943-946, 964-971`). Delete line 751 and every harness
  step still passes. The spec's own "Changes after review 0" row says "the harness covers it once the
  keys run live" (spec `:382`). The recommendation defers exactly that.
- **`quit` on `serial`.** The quit runs on `serial` with `unstageOwn`, `quitting` gates further keys,
  and stdin `end`, SIGHUP and stdout `error` now route through `quit` (`plan:780-840`). The harness
  `quit` command calls `unstageOwn` directly, not through any of these.
- **Reconcile in the no-run branch.** `refresh` now reconciles in both branches, and every refresh
  clears `message` (`ui.ts:77-81`).
- **The key mapping.** `\r`/`\n` → `stageWorker`, `\t` → `focusStage`, `z` → `zoomStage`
  (`plan:824-827`). Only `splitKeys` is unit-tested (`test/board-keys.test.ts:11-12`). Nothing tests
  that `onKey` maps those keys.

If the owner takes the recommendation, all of this ships without ever running, and the owner
believes it was covered.

**Evidence.** `plan:630-631, 750-751, 943-946, 964-971, 1092-1099`; spec `:371-374, 382`;
`src/board/ui.ts:77-81, 158-175`.

**Fix (inline).** Either:

- **(a, preferred) Drive `ui.ts` in the scratch session without a link.** `PIPELINE`
  (`src/board/ui.ts:22`) is an exported plain object. A harness entry can:
  1. set `PIPELINE.pluginId = 'stein.pasture'`;
  2. write a minimal current-schema run to `$HPL4_STATE` whose `repo_key` gives the harness slug
     (`runForSlug`, `src/board/data.ts:11-15`), with a task bound to `W1`;
  3. record the board pane, as `L record` does;
  4. call `runBoardUi({ stateDir, session: 'scratch', slug })` in a scratch pane, with that pane's
     `HERDR_PANE_ID` and the scratch `HERDR_SOCKET_PATH`.
  
  Then send that pane `enter` and `tab` in one send-keys chunk, and check that the focused pane is the
  worker's new id. Then send `z`, then `q`, and check that the worker is home and `staged` is `null`.
  This tests A19, the key mapping and the quit path, and removes the need for the decision.

- **(b, minimum) Rewrite `--recommend` to say plainly what stays unverified:** the A19 re-read, the
  quit path through `serial` and `unstageOwn`, the no-run reconcile, and the `onKey` mapping. The
  owner then decides with accurate information.

### MINOR 1 — the "no change, no write" test cannot see a write

**Claim.** "syncStage keeps a stage still under the board without a call or a change"
(`plan:224-230`) covers spec `:319`: "makes no write (record bytes unchanged)".

**Problem.** If the `JSON.stringify` compare (`plan:303`) is dropped, the test still passes.
`recordStaged` with `expected = recorded` writes back a stage equal to `STAGED`, so `toEqual(STAGED)`
holds, and so would a check on the file's bytes. The compare is the only thing that stops a locked
`boards.<session>.json` rewrite on every 2 s poll, a file the supervisor also writes.

**Evidence.** `writeJson` writes a temp file and renames it (`src/lib/store.ts:24-26`), so any write
replaces the inode.

**Fix.** In that test:

1. Before the call, read `statSync(join(dir, 'boards.personal.json')).ino`.
2. After the call, assert the inode is unchanged.

Import `statSync` next to `mkdtempSync`.

### MINOR 2 — the live harness keeps its scratch socket in shell variables that a fresh shell drops

**Claim.** Steps 1–3 `export S`, `HPL4_STATE` and the pane ids, and define `L()` "once in the shell
that runs the steps" (`plan:908-909, 982-987, 1001`).

**Problem.** The worker's Bash tool starts a fresh shell for every call. From the second call on,
`$S` and `$HPL4_STATE` are empty. The kit fails safe, because `HERDR_SOCKET_PATH=''` is not nullish
(`src/kit/herdr.ts:18`). The bare `herdr` CLI calls are another matter:

- `HERDR_SOCKET_PATH=$S herdr workspace create …` (`plan:995-997`);
- `HERDR_SOCKET_PATH=$S herdr workspace close $WH1` (`plan:1066`), which runs with both variables
  empty.

Neither has a guard if the CLI falls back to the default socket on an empty value. Step 2's guard
runs only once.

**Fix.**

1. Use a fixed state dir under the scratchpad instead of `mktemp -d`.
2. Write `S`, `HPL4_STATE`, the `L` function and each id into `$STATE/env.sh` as they are learned.
3. Start every later command with `. <that path>/env.sh && : "${S:?}"`.

## Summary

The plan carries the spec faithfully, and its unit tests are sound. The main gap is the verification
story for `ui.ts`: the plan's own recommendation would ship that wiring untested while saying it was
covered. Both findings above are fixed inline. Neither needs another review pass.

Counts: 0 BLOCKER, 1 MAJOR, 2 MINOR.

VERDICT: CLEAR
