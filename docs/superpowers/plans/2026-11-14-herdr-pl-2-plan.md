# Board stage record — Implementation Plan (herdr-pl-2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Tasks 1–8 are for the subagent. Task 9 (live check) is run by the worker that owns this branch, not by the subagent. Commit; never push.**

**Goal:** Record a board's staged worker, move it home before every board close, keep it across a herdr restart, and close it at teardown — per `docs/superpowers/specs/2026-11-14-herdr-pl-2-design.md`.

**Architecture:** `src/lib/boards.ts` gains the `staged` field and three functions (`recordStaged`, `unstageBoard`, `closeStagedWorker`) that talk to herdr through the kit socket client (`src/kit/herdr.ts`). The supervisor, the "Open board" action, startup and teardown call them through injected deps, so their existing fake-herdr tests stay fakes.

**Tech Stack:** Bun 1.3.14, TypeScript 5.9.3, `bun:test`. No runtime dependencies.

FILES: src/lib/boards.ts, src/supervisor/boards.ts, src/actions/board.ts, src/startup.ts, src/supervisor/teardown.ts, src/supervisor/main.ts
FILES: test/boards-stage.test.ts, test/board.test.ts, test/startup.test.ts, test/teardown.test.ts

---

## Ground rules (read once)

- Worktree: `/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/feat-board-stage-record`. Run every command from there. Branch `feat/board-stage-record`. Never commit to `main`. Never push.
- **Never edit `src/kit/` or `test/kit/`.** `scripts/sync-kit.ts` deletes and re-copies them. Importing from them is fine.
- Re-read every file before you edit it: a sibling task may have changed it since this plan was written. If an `old` snippet below no longer matches, find the same spot by meaning, and say so in your report.
- Comments carry the *why* only. Do not add a comment that restates the line below it.
- Run one test file with `bun test <file>`. The full suite takes ~3.5 minutes: `bun test` with a 600 s timeout. Typecheck: `bunx tsc --noEmit`.
- **Baseline:** on `8514924` the full suite already reports **1 failing test** before any change (2355 tests, 1 fail): `--help and -h print that subcommand's usage before any side effect, from anywhere` (it ran 5.8 s, a timeout under load; it touches none of these files). In Task 8 confirm it is the only failure.
- Conventional commit messages; end every commit message with the line
  `Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu`.

---

### Task 1: `staged` on the board record, and `recordStaged`

**Files:**
- Modify: `src/lib/boards.ts`
- Create: `test/boards-stage.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/boards-stage.test.ts` (modelled on `test/board-data.test.ts`: temp state dir per test, assert with `readBoards`):

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoards, recordStaged, type StagedWorker, updateBoards } from '../src/lib/boards'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boards-stage-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const SLUG = 'meter-abc123'
const BOARD = { pane_id: 'wP:p1', shell_pid: 321, opened_at_ms: 1 }

const STAGED: StagedWorker = {
  terminalId: 't1', paneId: 'wP:p2', homeWorkspaceId: 'w1', homeTabId: 'w1:t1',
  homeTabLabel: 'feat-x', placeholderPaneId: 'w1:p2', title: 'feat-x',
  host: { workspaceId: 'wP', tabId: 'wP:t1', boardPaneId: 'wP:p1' },
}

const withBoard = (staged?: StagedWorker | null) =>
  updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { ...BOARD, ...(staged !== undefined && { staged }) } })

test('recordStaged writes onto an existing record, and nowhere without one', async () => {
  expect(await recordStaged(dir, 'personal', SLUG, STAGED)).toBe(false)
  expect(await readBoards(dir, 'personal')).toEqual({})
  await withBoard()
  expect(await recordStaged(dir, 'personal', SLUG, STAGED)).toBe(true)
  expect((await readBoards(dir, 'personal'))[SLUG]).toEqual({ ...BOARD, staged: STAGED })
})

test('recordStaged with an expected stage writes only over that stage', async () => {
  await withBoard(STAGED)
  const other = { ...STAGED, terminalId: 't9', paneId: 'wP:p9' }
  expect(await recordStaged(dir, 'personal', SLUG, null, other)).toBe(false)
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toEqual(STAGED)
  expect(await recordStaged(dir, 'personal', SLUG, null, STAGED)).toBe(true)
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toBeNull()
  expect(await recordStaged(dir, 'personal', SLUG, STAGED, null)).toBe(true)
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toEqual(STAGED)
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/boards-stage.test.ts`
Expected: FAIL — `recordStaged` is not exported (`SyntaxError: Export named 'recordStaged' not found` or `recordStaged is not a function`).

- [ ] **Step 3: Implement**

In `src/lib/boards.ts`, add this import after the existing `import { readJson, withFileLock, writeJson } from './store'` line:

```ts
import type { Host, Staged } from '../kit/stage'
```

Replace the `BoardRecord` interface:

```ts
export interface BoardRecord {
  pane_id: string | null
  shell_pid: number | null
  opened_at_ms: number
  /** Done cards the user cleared with `x`; only for the run they were cleared in. */
  cleared?: { run_id: string; tasks: string[] }
}
```

with:

```ts
export interface BoardRecord {
  pane_id: string | null
  shell_pid: number | null
  opened_at_ms: number
  /** Done cards the user cleared with `x`; only for the run they were cleared in. */
  cleared?: { run_id: string; tasks: string[] }
  staged?: StagedWorker | null
}

/** The host is kept so the stage can still be undone once the board pane that made it is gone. */
export type StagedWorker = Staged & { host: Host }
```

Append to the end of the file:

```ts
export function sameStage(a: Staged | null | undefined, b: Staged | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return a.paneId === b.paneId && a.terminalId === b.terminalId
}

/**
 * False when no record names this board, or when `expected` is given and the
 * recorded stage is no longer it: the board writes a reconcile result back
 * only over the stage it read, so a stage the supervisor cleared meanwhile is
 * not resurrected.
 */
export async function recordStaged(
  stateDir: string, session: string, slug: string, staged: StagedWorker | null, expected?: StagedWorker | null,
): Promise<boolean> {
  return updateBoards(stateDir, session, (boards) => {
    const board = boards[slug]
    if (!board) return false
    if (expected !== undefined && !sameStage(board.staged, expected)) return false
    board.staged = staged
    return true
  })
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `bun test test/boards-stage.test.ts && bunx tsc --noEmit`
Expected: 2 pass, 0 fail; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boards.ts test/boards-stage.test.ts
git commit -m "feat: record a board's staged worker

Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu"
```

---

### Task 2: `unstageBoard`

**Files:**
- Modify: `src/lib/boards.ts`
- Modify: `test/boards-stage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/boards-stage.test.ts`, replace the import line
`import { readBoards, recordStaged, type StagedWorker, updateBoards } from '../src/lib/boards'` with:

```ts
import { readBoards, recordStaged, type StagedWorker, unstageBoard, updateBoards } from '../src/lib/boards'
import type { Snapshot } from '../src/kit/types'
import { fakeHerdr, moved } from './kit/fake-herdr'
import { agent, snapshot } from './kit/fixtures'
```

Add after the `withBoard` helper:

```ts
const GENERAL = { workspace_id: 'w1', label: 'General', active_tab_id: 'w1:t1' }
const BOARD_SPACE = { workspace_id: 'wP', label: 'pipeline', active_tab_id: 'wP:t1' }
const PLACEHOLDER = { pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', terminal_id: 'tph', agent: null, agent_status: 'unknown' as const }

/** The worker under the board in the pipeline workspace, its placeholder at home. */
function onStage(worker: { terminal_id?: string; tab_id?: string } = {}): Snapshot {
  const snap = snapshot(
    [agent({ terminal_id: worker.terminal_id ?? 't1', pane_id: 'wP:p2', tab_id: worker.tab_id ?? 'wP:t1', workspace_id: 'wP' })],
    { workspaces: [GENERAL, BOARD_SPACE] },
  )
  snap.panes.push(PLACEHOLDER)
  return snap
}

const HOME_MOVE = {
  method: 'pane.move',
  params: { pane_id: 'wP:p2', destination: { type: 'tab', tab_id: 'w1:t1', target_pane_id: 'w1:p2', split: 'right' }, focus: false },
}
```

Append the tests:

```ts
test('unstageBoard does nothing without a record or a stage', async () => {
  const { herdr, calls } = fakeHerdr({})
  await unstageBoard(herdr, dir, 'personal', SLUG)
  await withBoard()
  await unstageBoard(herdr, dir, 'personal', SLUG)
  await withBoard(null)
  await unstageBoard(herdr, dir, 'personal', SLUG)
  expect(calls).toEqual([])
})

test('unstageBoard moves the worker back next to its placeholder, closes it, and forgets the stage', async () => {
  await withBoard(STAGED)
  const { herdr, calls } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage() }),
    'pane.move': () => moved('w1:p3'),
    'pane.close': () => ({ type: 'ok' }),
  })
  await unstageBoard(herdr, dir, 'personal', SLUG)
  expect(calls.slice(1)).toEqual([HOME_MOVE, { method: 'pane.close', params: { pane_id: 'w1:p2' } }])
  expect((await readBoards(dir, 'personal'))[SLUG]).toEqual({ ...BOARD, staged: null })
})

test('after a herdr restart the worker is found by its pane id and still goes home', async () => {
  await withBoard(STAGED)
  const { herdr, calls } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage({ terminal_id: 't-new' }) }),
    'pane.move': () => moved('w1:p3'),
    'pane.close': () => ({ type: 'ok' }),
  })
  await unstageBoard(herdr, dir, 'personal', SLUG)
  expect(calls.slice(1)).toEqual([HOME_MOVE, { method: 'pane.close', params: { pane_id: 'w1:p2' } }])
})

test("a worker moved to another tab of the board's workspace still goes home", async () => {
  await withBoard(STAGED)
  const { herdr, calls } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage({ tab_id: 'wP:t2' }) }),
    'pane.move': () => moved('w1:p3'),
    'pane.close': () => ({ type: 'ok' }),
  })
  await unstageBoard(herdr, dir, 'personal', SLUG)
  expect(calls.slice(1)).toEqual([HOME_MOVE, { method: 'pane.close', params: { pane_id: 'w1:p2' } }])
})

test('a stage recorded while unstaging is not wiped', async () => {
  await withBoard(STAGED)
  const next = { ...STAGED, terminalId: 't2', paneId: 'wP:p5' }
  const { herdr } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage() }),
    'pane.move': () => moved('w1:p3'),
    'pane.close': async () => {
      await recordStaged(dir, 'personal', SLUG, next)
      return { type: 'ok' }
    },
  })
  await unstageBoard(herdr, dir, 'personal', SLUG)
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toEqual(next)
})

test('a move herdr refuses leaves the stage recorded', async () => {
  await withBoard(STAGED)
  const { herdr } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage() }),
    'pane.move': () => moved('wP:p2', false, 'zoomed_tab'),
  })
  await expect(unstageBoard(herdr, dir, 'personal', SLUG)).rejects.toThrow('zoomed_tab')
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toEqual(STAGED)
})
```

Why these discriminate: without the pane-id remap, the restart test's worker (terminal `t-new`) is not found by the kit and only the placeholder is closed; without the own-tab host, the kit refuses a worker in `wP:t2` and only closes the placeholder. Both then fail on `calls.slice(1)`.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test test/boards-stage.test.ts`
Expected: the six new tests FAIL (`unstageBoard` not exported); the two Task 1 tests still pass.

- [ ] **Step 3: Implement**

In `src/lib/boards.ts`, replace the line `import type { Host, Staged } from '../kit/stage'` with:

```ts
import { readSnapshot, type Herdr } from '../kit/herdr'
import { type Host, type Staged, unstage } from '../kit/stage'
import type { Snapshot } from '../kit/types'
```

Append to the end of the file:

```ts
// A move keeps the terminal id and renumbers the pane; a herdr restart keeps the pane id and changes the terminal id.
const stagedPane = (snap: Snapshot, staged: Staged) =>
  snap.panes.find((p) => p.terminal_id === staged.terminalId) ?? snap.panes.find((p) => p.pane_id === staged.paneId)

/**
 * The kit's `unstage` finds the worker by terminal id only, and when it misses
 * — as it does after a herdr restart — it closes the placeholder and gives up,
 * losing the worker's home spot. So the worker is found here and handed over
 * under the ids it has now. The pipeline workspace is never a worker's home,
 * so a worker found anywhere in it goes home from whichever tab it is in.
 */
export async function unstageBoard(herdr: Herdr, stateDir: string, session: string, slug: string): Promise<void> {
  const staged = (await readBoards(stateDir, session))[slug]?.staged
  if (!staged) return
  const snap = await readSnapshot(herdr)
  const pane = stagedPane(snap, staged)
  const current = pane ? { ...staged, terminalId: pane.terminal_id, paneId: pane.pane_id } : staged
  const host = pane?.workspace_id === staged.host.workspaceId ? { ...staged.host, tabId: pane.tab_id } : staged.host
  await unstage(herdr, snap, host, current)
  await recordStaged(stateDir, session, slug, null, staged)
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test test/boards-stage.test.ts && bunx tsc --noEmit`
Expected: 8 pass, 0 fail; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boards.ts test/boards-stage.test.ts
git commit -m "feat: move a board's staged worker home, across a herdr restart too

Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu"
```

---

### Task 3: `closeStagedWorker`

**Files:**
- Modify: `src/lib/boards.ts`
- Modify: `test/boards-stage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/boards-stage.test.ts`, change the boards import to:

```ts
import { closeStagedWorker, readBoards, recordStaged, type StagedWorker, unstageBoard, updateBoards } from '../src/lib/boards'
```

Append:

```ts
test('closeStagedWorker leaves a task that is not staged alone', async () => {
  const { herdr, calls } = fakeHerdr({})
  expect(await closeStagedWorker(herdr, dir, 'personal', SLUG, 'wP:p2')).toBe(false)
  await withBoard(STAGED)
  expect(await closeStagedWorker(herdr, dir, 'personal', SLUG, 'w4:p1')).toBe(false)
  expect(calls).toEqual([])
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toEqual(STAGED)
})

test('closeStagedWorker forgets the stage first, then closes the worker and never the placeholder', async () => {
  await withBoard(STAGED)
  const stagedAtClose: unknown[] = []
  const { herdr, calls } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage() }),
    'pane.close': async () => {
      stagedAtClose.push((await readBoards(dir, 'personal'))[SLUG]?.staged)
      return { type: 'ok' }
    },
  })
  expect(await closeStagedWorker(herdr, dir, 'personal', SLUG, 'wP:p2')).toBe(true)
  expect(calls.slice(1)).toEqual([{ method: 'pane.close', params: { pane_id: 'wP:p2' } }])
  expect(stagedAtClose).toEqual([null])
})

test('closeStagedWorker with the worker already gone still forgets the stage', async () => {
  await withBoard(STAGED)
  const { herdr, methods } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: snapshot([], { workspaces: [GENERAL, BOARD_SPACE] }) }),
  })
  expect(await closeStagedWorker(herdr, dir, 'personal', SLUG, 'wP:p2')).toBe(true)
  expect(methods()).toEqual(['session.snapshot'])
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toBeNull()
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test test/boards-stage.test.ts`
Expected: the three new tests FAIL (`closeStagedWorker` not exported).

- [ ] **Step 3: Implement**

Append to `src/lib/boards.ts`:

```ts
/**
 * Cleared before the close: a live board that sees its staged worker gone
 * reconciles by closing the placeholder, and the placeholder may be the last
 * pane of the worktree's workspace, whose loss turns the worktree removal
 * into the stricter checkout removal. The placeholder is left for the
 * workspace removal to close.
 */
export async function closeStagedWorker(
  herdr: Herdr, stateDir: string, session: string, slug: string, paneId: string,
): Promise<boolean> {
  const staged = await updateBoards(stateDir, session, (boards) => {
    const board = boards[slug]
    if (!board?.staged || board.staged.paneId !== paneId) return null
    const was = board.staged
    board.staged = null
    return was
  })
  if (staged === null) return false
  const pane = stagedPane(await readSnapshot(herdr), staged)
  if (pane) await herdr.call('pane.close', { pane_id: pane.pane_id })
  return true
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test test/boards-stage.test.ts && bunx tsc --noEmit`
Expected: 11 pass, 0 fail; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/lib/boards.ts test/boards-stage.test.ts
git commit -m "feat: close a staged worker, never its placeholder

Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu"
```

---

### Task 4: `syncBoards` unstages before every close or replacement

**Files:**
- Modify: `src/supervisor/boards.ts`
- Modify: `src/supervisor/main.ts`
- Modify: `test/board.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/board.test.ts`:

1. Change the boards import to:

```ts
import { boardLabel, isRenamedBoardLabel, readBoards, type StagedWorker, updateBoards } from '../src/lib/boards'
```

2. In `function deps(...)`, replace

```ts
    now: () => 100_000, hasStore: async () => true, herdr, ...over,
```

with

```ts
    now: () => 100_000, hasStore: async () => true, herdr, unstage: async () => {}, ...over,
```

3. After the `BOARD_PANE` constant, add:

```ts
const STAGED: StagedWorker = {
  terminalId: 't1', paneId: 'w9:p6', homeWorkspaceId: 'w1', homeTabId: 'w1:t1',
  homeTabLabel: 'feat-x', placeholderPaneId: 'w1:p2', title: 'feat-x',
  host: { workspaceId: 'w9', tabId: 'w9:t2', boardPaneId: 'w9:p4' },
}

/** Logs into the fake herdr's `calls`, so an unstage is ordered against the closes and opens. */
const recordingUnstage = (calls: string[]) => ({ unstage: async (slug: string) => { calls.push(`unstage ${slug}`) } })

const stagedBoard = () =>
  updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1, staged: STAGED } })
```

4. Append:

```ts
test("a finished run's staged board is unstaged before it is closed", async () => {
  await stagedBoard()
  const { herdr, calls } = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('done')], deps(herdr, recordingUnstage(calls)))
  expect(calls).toEqual([`unstage ${SLUG}`, 'close w9:p4'])
})

test('a dead staged board is unstaged before it is closed and replaced', async () => {
  await stagedBoard()
  const { herdr, calls } = fakeHerdr([BOARD_PANE], { 'w9:p4': 999 })
  await syncBoards([runIn('execute')], deps(herdr, recordingUnstage(calls)))
  expect(calls).toEqual([`unstage ${SLUG}`, 'close w9:p4', OPEN()])
})

test('a staged board whose pane is gone is still unstaged before it is replaced', async () => {
  await stagedBoard()
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr, recordingUnstage(calls)))
  expect(calls).toEqual([`unstage ${SLUG}`, OPEN()])
})

test('a live staged board is not unstaged, and a board with nothing staged is closed without one', async () => {
  await stagedBoard()
  const live = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('execute')], deps(live.herdr, recordingUnstage(live.calls)))
  expect(live.calls).toEqual([])

  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const plain = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('done')], deps(plain.herdr, recordingUnstage(plain.calls)))
  expect(plain.calls).toEqual(['close w9:p4'])
})

test('openBoard never carries a stage onto the board it opens', async () => {
  const old = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1, staged: STAGED }
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = old })
  const { herdr } = fakeHerdr([], {}, 'w9:p7')
  expect(await openBoard(SLUG, deps(herdr), old)).toBe(true)
  expect((await readBoards(dir, 'personal'))[SLUG]).toEqual({ pane_id: 'w9:p7', shell_pid: null, opened_at_ms: 100_000 })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test test/board.test.ts`
Expected: the first three new tests FAIL (no `unstage …` in `calls`). The fourth and the `openBoard` test PASS already: the fourth pins the no-unstage cases, and `openBoard` already copies only `cleared` (`src/supervisor/boards.ts:30`, spec A4). Every older test still passes.

- [ ] **Step 3: Implement in `src/supervisor/boards.ts`**

Replace the `BoardDeps` interface:

```ts
export interface BoardDeps {
  stateDir: string
  session: string
  pluginId: string
  workspaceId: string
  now: () => number
  hasStore: (slug: string) => Promise<boolean>
  herdr: Pick<Herdr, 'paneList' | 'paneShellPid' | 'paneClose' | 'pluginPaneOpen'>
}
```

with:

```ts
export interface BoardDeps {
  stateDir: string
  session: string
  pluginId: string
  workspaceId: string
  now: () => number
  hasStore: (slug: string) => Promise<boolean>
  herdr: Pick<Herdr, 'paneList' | 'paneShellPid' | 'paneClose' | 'pluginPaneOpen'>
  /** Moves the slug's staged worker home. Must not reject: a failure is logged and the close goes ahead. */
  unstage: (slug: string) => Promise<void>
}
```

Change the `openBoard` signature line

```ts
  slug: string, deps: Omit<BoardDeps, 'hasStore'>, expected: BoardRecord | undefined,
```

to

```ts
  slug: string, deps: Omit<BoardDeps, 'hasStore' | 'unstage'>, expected: BoardRecord | undefined,
```

In `syncBoards`, replace

```ts
  for (const [slug, board] of Object.entries(recorded)) {
    if (wanted.has(slug)) continue
    if (board.pane_id !== null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(board.pane_id)).ok) continue
```

with

```ts
  // Each unstage comes before the listed-pane guard: a board whose pane is gone
  // is not closed, but its record is deleted or replaced all the same, and the
  // stage would go with it.
  for (const [slug, board] of Object.entries(recorded)) {
    if (wanted.has(slug)) continue
    if (board.staged) await deps.unstage(slug)
    if (board.pane_id !== null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(board.pane_id)).ok) continue
```

and replace

```ts
    if (board !== undefined && await isLive(board, listed, deps)) continue
    if (board?.pane_id != null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(board.pane_id)).ok) continue
```

with

```ts
    if (board !== undefined && await isLive(board, listed, deps)) continue
    if (board?.staged) await deps.unstage(slug)
    if (board?.pane_id != null && listed.has(board.pane_id) && !(await deps.herdr.paneClose(board.pane_id)).ok) continue
```

- [ ] **Step 4: Wire it in `src/supervisor/main.ts`**

After the import line `import { readBeadsProject } from '../lib/beads-project'`, add:

```ts
import { unstageBoard } from '../lib/boards'
import { createClient } from '../kit/herdr'
```

Replace `  const herdr = new Herdr()` (the one inside `main`, near line 175) with:

```ts
  const herdr = new Herdr()
  const kit = createClient()
```

In the `'board upkeep'` step, replace

```ts
          await syncBoards(await syncRuns(), {
            stateDir, session, pluginId, workspaceId: pipelineWorkspace, now: Date.now,
            hasStore: async (slug) => (await readBeadsProject(stateDir, slug)) !== null,
            herdr,
          })
```

with

```ts
          await syncBoards(await syncRuns(), {
            stateDir, session, pluginId, workspaceId: pipelineWorkspace, now: Date.now,
            hasStore: async (slug) => (await readBeadsProject(stateDir, slug)) !== null,
            herdr,
            unstage: (slug) => unstageBoard(kit, stateDir, session, slug)
              .catch((error) => console.error(`[pipeline] could not unstage the board for ${slug}: ${error}`)),
          })
```

- [ ] **Step 5: Run and typecheck**

Run: `bun test test/board.test.ts && bunx tsc --noEmit`
Expected: all pass; tsc prints nothing. (`src/actions/board.ts` still compiles because `openBoard` omits `unstage`.)

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/boards.ts src/supervisor/main.ts test/board.test.ts
git commit -m "feat: unstage a board's worker before the supervisor closes or replaces the board

Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu"
```

---

### Task 5: "Open board" unstages before it closes

**Files:**
- Modify: `src/actions/board.ts`
- Modify: `test/board.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/board.test.ts`, in `function actionDeps(...)`, replace

```ts
    workspaceId: async () => 'w9', now: () => 100_000, herdr,
```

with

```ts
    workspaceId: async () => 'w9', now: () => 100_000, herdr, unstage: async () => {},
```

Append:

```ts
test('"Open board" unstages the recorded board before closing it', async () => {
  await withStore()
  await stagedBoard()
  const { herdr, calls } = fakeHerdr([BOARD_PANE], {}, 'w9:p7')
  const { actionDeps: d } = actionDeps(herdr, recordingUnstage(calls))
  expect(await openBoardAction(d)).toBe(0)
  expect(calls).toEqual([`unstage ${SLUG}`, 'close w9:p4', OPEN()])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/board.test.ts`
Expected: the new test FAILS — `calls` is `['close w9:p4', OPEN()]`.

- [ ] **Step 3: Implement in `src/actions/board.ts`**

Replace the imports

```ts
import { readBoards } from '../lib/boards'
```

with

```ts
import { createClient } from '../kit/herdr'
import { readBoards, unstageBoard } from '../lib/boards'
```

In `OpenBoardActionDeps`, after `  herdr: BoardDeps['herdr']`, add:

```ts
  /** As `BoardDeps.unstage`: must not reject. */
  unstage: BoardDeps['unstage']
```

Replace

```ts
  const recorded = (await readBoards(deps.stateDir, deps.session))[slug]
  if (recorded?.pane_id) await deps.herdr.paneClose(recorded.pane_id)
```

with

```ts
  const recorded = (await readBoards(deps.stateDir, deps.session))[slug]
  if (recorded?.staged) await deps.unstage(slug)
  if (recorded?.pane_id) await deps.herdr.paneClose(recorded.pane_id)
```

In the `import.meta.main` block, after `    herdr,` add:

```ts
    unstage: (slug) => unstageBoard(createClient(), stateDir, session, slug)
      .catch((error) => console.error(`[pipeline] could not unstage the board for ${slug}: ${error}`)),
```

- [ ] **Step 4: Run and typecheck**

Run: `bun test test/board.test.ts && bunx tsc --noEmit`
Expected: all pass; tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/actions/board.ts test/board.test.ts
git commit -m "feat: unstage a board's worker before \"Open board\" closes the board

Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu"
```

---

### Task 6: A herdr restart keeps staged and bound panes

**Files:**
- Modify: `src/startup.ts`
- Modify: `test/startup.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/startup.test.ts`, replace

```ts
import {
  clearStrayPanes, ensureWorkspace, keepCrashTail, linkHpipe, reapGhostPanes, reapSupervisorSiblings, startToolsCheck,
} from '../src/startup'
```

with

```ts
import {
  clearStrayPanes, ensureWorkspace, keepCrashTail, linkHpipe, reapGhostPanes, reapSupervisorSiblings, startToolsCheck,
  strayKeepSet,
} from '../src/startup'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'
```

Append:

```ts
const runWith = (phase: Run['phase'], tasks: Pick<Task, 'phase' | 'pane_id'>[]): Run => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: '/code/meter', repoRoot: '/code/meter', title: 'a' })
  run.phase = phase
  run.tasks = tasks as Task[]
  return run
}

test("strayKeepSet keeps board panes, the staged worker and its placeholder, and every unfinished task's pane", () => {
  const staged = {
    terminalId: 't1', paneId: 'w3:p6', homeWorkspaceId: 'w1', homeTabId: 'w1:t1',
    homeTabLabel: 'feat-x', placeholderPaneId: 'w1:p2', title: 'feat-x',
    host: { workspaceId: 'w3', tabId: 'w3:t2', boardPaneId: 'w3:p3' },
  }
  const keep = strayKeepSet(
    {
      'meter-abc123': { pane_id: 'w3:p3', shell_pid: 1, opened_at_ms: 1, staged },
      'other-def456': { pane_id: null, shell_pid: null, opened_at_ms: 1, staged: null },
    },
    [
      runWith('execute', [{ phase: 'implement', pane_id: 'w4:p1' }, { phase: 'done', pane_id: 'w5:p1' }, { phase: 'implement', pane_id: null }]),
      runWith('escalated', [{ phase: 'escalated', pane_id: 'w6:p1' }]),
    ],
  )
  expect([...keep].sort()).toEqual(['w1:p2', 'w3:p3', 'w3:p6', 'w4:p1', 'w6:p1'])
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/startup.test.ts`
Expected: the new test FAILS (`strayKeepSet` not exported).

- [ ] **Step 3: Implement in `src/startup.ts`**

Replace the import line

```ts
import { BOARD_PANE_TITLE, readBoards, recordedBoardPanes } from './lib/boards'
```

with

```ts
import { BOARD_PANE_TITLE, type BoardRegistry, readBoards, recordedBoardPanes } from './lib/boards'
import { isCurrentSchemaRun, listRuns } from './lib/ledger'
import type { Run } from './lib/types'
import { FINISHED } from './supervisor/teardown'
```

Add directly above `export async function clearStrayPanes(`:

```ts
/**
 * A worker staged under a board sits in the pipeline workspace, so without this
 * a herdr restart closed it as a stray and failed its task. Every unfinished
 * task's pane is kept, as `PaneAbsence` binds them, so a worker whose stage
 * record was lost is kept too; a pane kept needlessly costs one stray pane.
 */
export function strayKeepSet(boards: BoardRegistry, runs: readonly Run[]): Set<string> {
  const keep = recordedBoardPanes(boards)
  for (const board of Object.values(boards)) {
    if (!board.staged) continue
    keep.add(board.staged.paneId)
    if (board.staged.placeholderPaneId !== null) keep.add(board.staged.placeholderPaneId)
  }
  for (const task of runs.flatMap((run) => run.tasks)) {
    if (task.pane_id !== null && !FINISHED.has(task.phase)) keep.add(task.pane_id)
  }
  return keep
}
```

In `main`, replace

```ts
    const strays = await clearStrayPanes(herdr, workspaceId, recordedBoardPanes(await readBoards(stateDir, session)))
```

with

```ts
    const runs = (await listRuns(stateDir, session)).filter(isCurrentSchemaRun)
    const strays = await clearStrayPanes(herdr, workspaceId, strayKeepSet(await readBoards(stateDir, session), runs))
```

- [ ] **Step 4: Run and typecheck**

Run: `bun test test/startup.test.ts && bunx tsc --noEmit`
Expected: all pass; tsc prints nothing. If tsc reports an import cycle problem from `./supervisor/teardown` (it should not: `teardown.ts` imports only from `../lib/`), stop and report it rather than moving `FINISHED`.

- [ ] **Step 5: Commit**

```bash
git add src/startup.ts test/startup.test.ts
git commit -m "fix: keep staged and bound worker panes when herdr restarts

Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu"
```

---

### Task 7: Teardown closes a staged worker before removing the worktree

**Files:**
- Modify: `src/supervisor/teardown.ts`
- Modify: `src/supervisor/main.ts`
- Modify: `test/teardown.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `test/teardown.test.ts` (it already imports `Run`, `Task`, `runTeardown`, `mkTask`, `mkRun`, `removingBy`):

```ts
// Asserted from inside removeWorktree: markTornDown releases the pane after a
// `removed` anyway, so the end state cannot tell the two releases apart.
test('a staged worker is closed and released before its worktree is removed', async () => {
  const run = mkRun([mkTask({})])
  const seen: string[] = []
  await runTeardown([run], {
    ...removingBy(async () => {
      seen.push(`remove pane=${run.tasks[0]?.pane_id} last=${run.tasks[0]?.last_pane_id}`)
      return 'removed' as const
    }),
    closeStagedWorker: async (_run, task) => {
      seen.push(`close ${task.pane_id}`)
      return true
    },
  })
  expect(seen).toEqual(['close w7:p1', 'remove pane=null last=w7:p1'])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('a task that is not staged keeps its pane bound through the removal', async () => {
  const run = mkRun([mkTask({})])
  const seen: string[] = []
  await runTeardown([run], {
    ...removingBy(async () => {
      seen.push(`remove pane=${run.tasks[0]?.pane_id}`)
      return 'removed' as const
    }),
    closeStagedWorker: async (_run, task) => {
      seen.push(`close ${task.pane_id}`)
      return false
    },
  })
  expect(seen).toEqual(['close w7:p1', 'remove pane=w7:p1'])
})

test('a task without a pane, or kept by request, is never offered for closing', async () => {
  const offered: string[] = []
  const run = mkRun([mkTask({ task_id: 't1', pane_id: null }), mkTask({ task_id: 't2', keep_worktree: true })])
  await runTeardown([run], {
    ...removingBy(async () => 'removed' as const),
    closeStagedWorker: async (_run: Run, task: Task) => {
      offered.push(task.task_id)
      return true
    },
  })
  expect(offered).toEqual([])
})
```

The existing tests in this file build `TeardownDeps` without `closeStagedWorker`; they are the "no dep behaves as today" check.

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test test/teardown.test.ts`
Expected: the first two new tests FAIL (`seen` lacks `close …`); the third passes already (nothing is offered yet). Older tests pass.

- [ ] **Step 3: Implement in `src/supervisor/teardown.ts`**

Replace the `TeardownDeps` interface:

```ts
export interface TeardownDeps {
  removeWorktree: (workspaceId: string) => Promise<WorktreeRemoval>
  /** For a checkout whose workspace is gone: herdr 0.9.0's `worktree remove` takes only a workspace. */
  removeCheckout: (
    repoRoot: string, checkoutPath: string, branch: string, pr: number | null, batchBranch: string | null,
  ) => Promise<CheckoutRemoval>
}
```

with:

```ts
export interface TeardownDeps {
  removeWorktree: (workspaceId: string) => Promise<WorktreeRemoval>
  /** For a checkout whose workspace is gone: herdr 0.9.0's `worktree remove` takes only a workspace. */
  removeCheckout: (
    repoRoot: string, checkoutPath: string, branch: string, pr: number | null, batchBranch: string | null,
  ) => Promise<CheckoutRemoval>
  /**
   * True when the task's worker was staged under a board and is now closed. A
   * staged worker lives in the pipeline workspace, which removing the worktree
   * does not touch. Optional: absent, teardown behaves as before staging existed.
   */
  closeStagedWorker?: (run: Run, task: Task) => Promise<boolean>
}
```

In `runTeardown`, replace

```ts
      if (task.keep_worktree) {
        enterTaskPhase(run, task, 'done', 'worktree kept by request')
        continue
      }

      const workspaceId = task.workspace_id
```

with

```ts
      if (task.keep_worktree) {
        enterTaskPhase(run, task, 'done', 'worktree kept by request')
        continue
      }

      if (task.pane_id !== null && await deps.closeStagedWorker?.(run, task)) releaseWorkerPane(task)

      const workspaceId = task.workspace_id
```

- [ ] **Step 4: Wire it in `src/supervisor/main.ts`**

Replace the two import lines Task 4 left:

```ts
import { readBeadsProject } from '../lib/beads-project'
import { unstageBoard } from '../lib/boards'
```

with

```ts
import { beadsSlug, readBeadsProject } from '../lib/beads-project'
import { closeStagedWorker, unstageBoard } from '../lib/boards'
```

In the `advanceTasks(run, { … })` deps (near line 373), replace

```ts
            removeCheckout: removeCheckoutWithGit,
```

with

```ts
            removeCheckout: removeCheckoutWithGit,
            closeStagedWorker: async (taskRun, task) => {
              if (task.pane_id === null) return false
              try {
                return await closeStagedWorker(kit, stateDir, session, beadsSlug(taskRun.repo_key), task.pane_id)
              } catch (error) {
                console.error(`[pipeline] run ${taskRun.run_id}: could not close ${task.task_id}'s staged worker: ${error}`)
                return false
              }
            },
```

(`kit` is the `createClient()` Task 4 added beside `herdr` in `main`.)

- [ ] **Step 5: Run and typecheck**

Run: `bun test test/teardown.test.ts test/tasks.test.ts && bunx tsc --noEmit`
Expected: all pass; tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/teardown.ts src/supervisor/main.ts test/teardown.test.ts
git commit -m "feat: teardown closes a staged worker before removing its worktree

Claude-Session: https://claude.ai/code/session_01F3fK9hLu5kDYTAFutygBxu"
```

---

### Task 8: Whole-suite check

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no output, exit 0.

- [ ] **Step 2: Full suite**

Run: `bun test 2>&1 | grep -E "\(fail\)|^ *[0-9]+ (pass|fail)"` (timeout 600 s)
Expected: the same single pre-existing failure as the baseline (see Ground rules), and no other. If anything in `test/boards-stage.test.ts`, `test/board.test.ts`, `test/startup.test.ts`, `test/teardown.test.ts`, `test/tasks.test.ts` or any `*-wiring.test.ts` fails, fix it before reporting.

- [ ] **Step 3: Report**

Report to the worker: the commits made, the full-suite pass/fail counts, the name of the one failing test and why it is unrelated, and any `old` snippet that had moved.

---

### Task 9: Live check in a scratch herdr session (worker only, not the subagent)

Spec "Live verification" and A5: the claim that pane ids survive a herdr restart is unmeasured and contradicted in the repo (`src/supervisor/tick.ts:339-341` vs `src/startup.ts:135-136`, `src/supervisor/boards.ts:72-73`). This task measures it. **Never point any of this at the live `default` or `herdr-plugin` session.**

- [ ] **Step 1: Start the scratch session**

```bash
tmux new-session -d -s hpl2 -x 220 -y 60 'herdr --session hpl2-scratch'
herdr session list
```

Re-run `herdr session list` until `hpl2-scratch` reads `running`. Then:

```bash
export S=$(herdr session list | awk '$1=="hpl2-scratch"{print $4}')
export HPL2_STATE=$(mktemp -d)
echo "$S"
```

Expected: `S` ends in `/sessions/hpl2-scratch/herdr.sock`. The installed stein.pipeline plugin also boots in this session (plugins are global) and opens its own pipeline workspace; it is left alone.

- [ ] **Step 2: Guard — the CLI really talks to the scratch session**

```bash
herdr workspace list > /tmp/hpl2-live-ws.txt
HERDR_SOCKET_PATH=$S herdr workspace list > /tmp/hpl2-scratch-ws.txt
diff -q /tmp/hpl2-live-ws.txt /tmp/hpl2-scratch-ws.txt
```

Expected: `diff` reports the files differ. **If they are identical, stop**: the CLI ignores `HERDR_SOCKET_PATH` and every later step would act on the live session.

- [ ] **Step 3: Write the helper script (outside the repo)**

Create `$HPL2_STATE/live.ts`:

```ts
const repo = '/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/feat-board-stage-record'
const { createClient, readSnapshot } = await import(`${repo}/src/kit/herdr.ts`)
const { readBoards, recordStaged, unstageBoard, updateBoards } = await import(`${repo}/src/lib/boards.ts`)
const { clearStrayPanes, strayKeepSet } = await import(`${repo}/src/startup.ts`)
const { Herdr } = await import(`${repo}/src/lib/herdr.ts`)

const stateDir = process.env.HPL2_STATE!
const session = 'scratch'
const slug = 'scratch-abc123'
const kit = createClient()
const [cmd, ...args] = process.argv.slice(2)

if (cmd === 'panes') {
  const snap = await readSnapshot(kit)
  for (const p of snap.panes) console.log(`${p.pane_id}\ttab=${p.tab_id}\tws=${p.workspace_id}\tterm=${p.terminal_id}\tagent=${p.agent ?? '-'}`)
  for (const t of snap.tabs) console.log(`tab ${t.tab_id}\tws=${t.workspace_id}\t${t.label}`)
} else if (cmd === 'record') {
  const [boardPaneId, workerPaneId, placeholderPaneId] = args
  const snap = await readSnapshot(kit)
  const board = snap.panes.find((p) => p.pane_id === boardPaneId)!
  const worker = snap.panes.find((p) => p.pane_id === workerPaneId)!
  const placeholder = snap.panes.find((p) => p.pane_id === placeholderPaneId)!
  await updateBoards(stateDir, session, (boards) => { boards[slug] = { pane_id: boardPaneId, shell_pid: 0, opened_at_ms: Date.now() } })
  console.log(await recordStaged(stateDir, session, slug, {
    terminalId: worker.terminal_id, paneId: worker.pane_id,
    homeWorkspaceId: placeholder.workspace_id, homeTabId: placeholder.tab_id, homeTabLabel: 'hpl2-home',
    placeholderPaneId, title: 'hpl2-worker',
    host: { workspaceId: board.workspace_id, tabId: board.tab_id, boardPaneId },
  }))
} else if (cmd === 'show') {
  console.log(JSON.stringify((await readBoards(stateDir, session))[slug], null, 2))
} else if (cmd === 'unstage') {
  await unstageBoard(kit, stateDir, session, slug)
  console.log('unstaged')
} else if (cmd === 'clear') {
  console.log('closed:', await clearStrayPanes(new Herdr(), args[0]!, strayKeepSet(await readBoards(stateDir, session), [])))
}
```

All later `bun` calls run as `HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts <cmd>`.

- [ ] **Step 4: Build a stage by hand**

```bash
HERDR_SOCKET_PATH=$S herdr workspace create --label hpl2-home --no-focus
HERDR_SOCKET_PATH=$S herdr workspace create --label hpl2-board --no-focus
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts panes
```

From the output, note `WH` (hpl2-home's workspace id), `WORKER` (its one pane), `WB` (hpl2-board's id), `BOARD` (its one pane) and `TB` (that pane's tab). Then:

```bash
HERDR_SOCKET_PATH=$S herdr pane split $WORKER --direction right --no-focus
HERDR_SOCKET_PATH=$S herdr pane move $WORKER --tab $TB --split down --target-pane $BOARD --no-focus
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts panes
```

Note `PH` (the new pane in `WH`, the placeholder) and `MOVED` (the worker's new id in `WB`, same `term=` as before). Then:

```bash
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts record $BOARD $MOVED $PH
```

Expected: `true`.

- [ ] **Step 5: Unstage, no restart**

```bash
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts unstage
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts panes
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts show
```

Expected: the worker's terminal is back in `WH`'s tab, `PH` is gone, `"staged": null`.

- [ ] **Step 6: Restage, then restart herdr**

Repeat Step 4's split, move and `record` with the worker's current pane id (new `PH`, new `MOVED`). Then:

```bash
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts panes > $HPL2_STATE/before.txt
herdr session stop hpl2-scratch
tmux kill-session -t hpl2
tmux new-session -d -s hpl2 -x 220 -y 60 'herdr --session hpl2-scratch'
herdr session list
```

Re-run `herdr session list` until `hpl2-scratch` is `running`, then:

```bash
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts panes > $HPL2_STATE/after.txt
diff $HPL2_STATE/before.txt $HPL2_STATE/after.txt
```

Record, in words: did the panes come back at all; did pane ids survive; did tab ids survive; did terminal ids change.

- [ ] **Step 7: Startup clear, then unstage after the restart**

```bash
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts clear $WB
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts unstage
HERDR_SOCKET_PATH=$S bun $HPL2_STATE/live.ts panes
```

Expected if pane ids survive: `closed: []` (the board pane is recorded, the worker is `staged.paneId`), then the worker goes home next to `PH`, and `PH` closes.

- [ ] **Step 8: Write the result into the spec, and act on it**

Edit A5 in `docs/superpowers/specs/2026-11-14-herdr-pl-2-design.md`: replace "Unmeasured, and contradicted in the repo" with what Step 6 measured (herdr 0.9.1, date, ids that survived). Then:
- **Pane ids survived:** the comments at `src/startup.ts:135-136` and `src/supervisor/boards.ts:72-73` are wrong; fix their wording in this branch (both files are this task's). Commit `docs: …`.
- **Pane ids did not survive:** do not open the PR. Run `hpipe decide --task t2` with the measurement and a recommendation (the restart remap and A15 do not hold; `tick.ts:339-341` and the kit are wrong too).
- **Panes did not come back at all:** a staged worker cannot outlive a restart either way; record it in A5, and `hpipe discover` the kit comment.

- [ ] **Step 9: Clean up**

```bash
herdr session stop hpl2-scratch
herdr session delete hpl2-scratch
tmux kill-session -t hpl2
rm -rf "$HPL2_STATE" /tmp/hpl2-live-ws.txt /tmp/hpl2-scratch-ws.txt
```
