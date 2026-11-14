# herdr-pl-4 plan — board: enter stages a worker, tab focuses, z zooms

Spec: `docs/superpowers/specs/2026-11-14-herdr-pl-4-design.md` (cleared review 0). Read it first; the
`A<n>` labels below are its assumptions. Branch `feat/board-staging`.

**Goal.** `enter` on a task card moves that task's worker under the board, `tab` focuses it, `z`
zooms it; the board reconciles the stage on every refresh and sends the worker home when it quits.

**Architecture.** A new `src/board/stage.ts` holds every stage decision as functions of explicit
arguments (herdr client, state dir, session, slug, snapshot, host, identity), so they are tested with
`test/kit/fake-herdr.ts` and a temp state dir. `src/board/ui.ts` only wires them to keys, the refresh
and the quit. The kit (`src/kit/stage.ts`) and `src/lib/boards.ts` are used as they are.

**Modelled on.** Pasture's board, `~/Documents/development/personal/herdr-pasture/src/board.ts`
(`stage` `:101-109`, `focusStage`/`zoomStage` `:181-191`, reconcile `:70-85`). Tests model on
`test/boards-stage.test.ts` and `test/kit/stage.test.ts`.

**Rules for whoever carries this out.**
- Re-read every file before you edit it: a sibling task may have changed it since this plan was
  written. If an "old" block below no longer matches, stop and report rather than guess.
- **Do not edit `src/kit/` or `src/lib/boards.ts`.**
- Comments carry the *why* only (`.claude/agents/plugin-dev.md`); do not add comments that restate
  the code. The code below already has the only comments it needs.
- Commit after every task with the message given. Never push.
- Tasks 1–8 are for the implementing subagent. **Task 9 is for the worker only** (it needs a scratch
  herdr session and possibly a decision).

FILES: src/board/stage.ts, test/board-stage.test.ts, src/board/ui.ts
FILES: src/board/view.ts, test/board-view.test.ts
FILES: herdr-plugin.toml, test/prompts.test.ts, README.md

---

### Task 1: `boardHost` and `workerFor`

Spec "`src/board/stage.ts`", A6, A17.

- [ ] **Step 1: Write the failing tests.** Create `test/board-stage.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boardHost, ELSEWHERE, NO_WORKER, workerFor } from '../src/board/stage'
import type { Host, Identity } from '../src/kit/stage'
import type { Snapshot } from '../src/kit/types'
import { type BoardRecord, readBoards, type StagedWorker, updateBoards } from '../src/lib/boards'
import { heldTask, perTaskRun } from './helpers/before-merge'
import { fakeHerdr, moved, opened } from './kit/fake-herdr'
import { agent, snapshot } from './kit/fixtures'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-stage-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const SESSION = 'personal'
const SLUG = 'meter-abc123'
const HOST: Host = { workspaceId: 'wP', tabId: 'wP:t1', boardPaneId: 'wP:p1' }
const IDENTITY: Identity = { pluginId: 'stein.example', placeholderEntrypoint: 'placeholder', peekEntrypoint: 'peek', stageName: 'example' }
const BOARD: BoardRecord = { pane_id: 'wP:p1', shell_pid: 321, opened_at_ms: 1 }
const GENERAL = { workspace_id: 'w1', label: 'General', active_tab_id: 'w1:t1' }
const BOARD_SPACE = { workspace_id: 'wP', label: 'pipeline', active_tab_id: 'wP:t1' }

const STAGED: StagedWorker = {
  terminalId: 't1', paneId: 'wP:p2', homeWorkspaceId: 'w1', homeTabId: 'w1:t1',
  homeTabLabel: 'feat-x', placeholderPaneId: 'w1:p2', title: 'feat-x', host: HOST,
}
const EARLIER_BOARDS_STAGE: StagedWorker = { ...STAGED, host: { ...HOST, boardPaneId: 'wP:p0' } }
const DOCS_STAGED: StagedWorker = {
  terminalId: 't2', paneId: 'wP:p4', homeWorkspaceId: 'w1', homeTabId: 'w1:t1', homeTabLabel: 'feat-y',
  placeholderPaneId: 'w1:p6', title: 'Docs', host: HOST,
}

const withRecord = (over: Partial<BoardRecord> = {}) =>
  updateBoards(dir, SESSION, (boards) => { boards[SLUG] = { ...BOARD, ...over } })
const record = async () => (await readBoards(dir, SESSION))[SLUG]

const placeholder = (pane_id: string, terminal_id: string) =>
  ({ pane_id, tab_id: 'w1:t1', workspace_id: 'w1', terminal_id, agent: null, agent_status: 'unknown' as const })

/** STAGED's worker under the board, its placeholder at home. */
function onStage(): Snapshot {
  const snap = snapshot([agent({ terminal_id: 't1', pane_id: 'wP:p2', tab_id: 'wP:t1', workspace_id: 'wP' })], { workspaces: [GENERAL, BOARD_SPACE] })
  snap.panes.push(placeholder('w1:p2', 'tph'))
  return snap
}

/** A second worker, terminal t2, at home in w1. */
function docsAtHome(): Snapshot {
  return snapshot([agent({ terminal_id: 't2', pane_id: 'w1:p5', terminal_title_stripped: 'Docs' })], {
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'feat-y' }],
    workspaces: [GENERAL, BOARD_SPACE],
  })
}

/** STAGED's worker under the board and the Docs worker at home. */
function bothWorkers(): Snapshot {
  const snap = onStage()
  const docs = docsAtHome()
  snap.agents.push(...docs.agents)
  snap.panes.push(...docs.panes)
  snap.tabs = docs.tabs
  return snap
}

const pane = (pane_id: string, workspace_id: string, tab_id = `${workspace_id}:t1`) =>
  agent({ terminal_id: `term-${pane_id}`, pane_id, workspace_id, tab_id })

test('boardHost is the board pane where the snapshot shows it', () => {
  const snap = snapshot([agent({ terminal_id: 'tb', pane_id: 'wP:p1', tab_id: 'wP:t1', workspace_id: 'wP', agent: null })])
  expect(boardHost(snap, 'wP:p1')).toEqual(HOST)
  expect(boardHost(snap, undefined)).toBeNull()
  expect(boardHost(snap, 'wP:p9')).toBeNull()
})

test("workerFor is the live pane of the card's task", () => {
  const run = perTaskRun([heldTask({ task_id: 't1', workspace_id: 'w7', pane_id: 'w7:p1' })])
  expect(workerFor(run, snapshot([pane('w7:p1', 'w7')]), HOST, 't1')).toMatchObject({ pane_id: 'w7:p1', terminal_id: 'term-w7:p1' })
})

test('a run card, an unbound task, a gone pane or no run has no worker to stage', () => {
  const run = perTaskRun([heldTask({ task_id: 't1', pane_id: null }), heldTask({ task_id: 't2', workspace_id: 'w7', pane_id: 'w7:p2' })])
  const snap = snapshot([pane('w7:p9', 'w7')])
  expect(workerFor(run, snap, HOST, `run:${run.run_id}`)).toBe(NO_WORKER)
  expect(workerFor(run, snap, HOST, 't1')).toBe(NO_WORKER)
  expect(workerFor(run, snap, HOST, 't2')).toBe(NO_WORKER)
  expect(workerFor(null, snap, HOST, 't2')).toBe(NO_WORKER)
})

test("the orchestrator's pane is never a worker to stage", () => {
  const run = perTaskRun([heldTask({ task_id: 't1', workspace_id: 'w1', pane_id: 'w1:p1' })])
  expect(run.orchestrator_pane).toBe('w1:p1')
  expect(workerFor(run, snapshot([pane('w1:p1', 'w1')]), HOST, 't1')).toBe(NO_WORKER)
})

test('a worker outside its workspace is on another stage, unless it is under this board', () => {
  const run = perTaskRun([
    heldTask({ task_id: 't1', workspace_id: 'w7', pane_id: 'w9:p1' }),
    heldTask({ task_id: 't2', workspace_id: null, pane_id: 'w7:p2' }),
    heldTask({ task_id: 't3', workspace_id: 'w7', pane_id: 'wP:p3' }),
  ])
  const snap = snapshot([pane('w9:p1', 'w9'), pane('w7:p2', 'w7'), pane('wP:p3', 'wP')])
  expect(workerFor(run, snap, HOST, 't1')).toBe(ELSEWHERE)
  expect(workerFor(run, snap, HOST, 't2')).toBe(ELSEWHERE)
  expect(workerFor(run, snap, HOST, 't3')).toMatchObject({ pane_id: 'wP:p3' })
})
```

(`moved`, `opened`, `fakeHerdr`, `STAGED`, `DOCS_STAGED`, `withRecord`, `record`, `onStage`,
`bothWorkers` are used by Tasks 2–4; the repo's tsconfig has no `noUnusedLocals`.)

- [ ] **Step 2: Run it and see it fail.** `bun test test/board-stage.test.ts` → fails: cannot resolve
  `../src/board/stage`.

- [ ] **Step 3: Implement.** Create `src/board/stage.ts`:

```ts
import type { Host } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
import type { Run } from '../lib/types'

export const NO_WORKER = 'no worker to stage'
export const ELSEWHERE = 'that worker is on another stage'

export function boardHost(snap: Snapshot, boardPaneId: string | undefined): Host | null {
  const pane = boardPaneId === undefined ? undefined : snap.panes.find((p) => p.pane_id === boardPaneId)
  return pane ? { workspaceId: pane.workspace_id, tabId: pane.tab_id, boardPaneId: pane.pane_id } : null
}

/** The pane to stage for a card, or the status-line text saying why there is none. */
export function workerFor(run: Run | null, snap: Snapshot, host: Host, cardId: string): PaneInfo | string {
  const task = run?.tasks.find((t) => t.task_id === cardId)
  const pane = task?.pane_id ? snap.panes.find((p) => p.pane_id === task.pane_id) : undefined
  if (!run || !task || !pane || pane.pane_id === run.orchestrator_pane) return NO_WORKER
  // A pipeline worker lives in its worktree's workspace; anywhere else, another board staged it and holds its home spot.
  if (pane.workspace_id !== task.workspace_id && pane.tab_id !== host.tabId) return ELSEWHERE
  return pane
}
```

- [ ] **Step 4: Run it and see it pass.** `bun test test/board-stage.test.ts` → 5 pass.
  `bunx tsc --noEmit` → no output.

- [ ] **Step 5: Commit.** `git add src/board/stage.ts test/board-stage.test.ts && git commit -m "feat(board): choose the pane to stage for a card"`

---

### Task 2: `syncStage` — reconcile on refresh

Spec "Refresh", A5, A11, A12, A18.

- [ ] **Step 1: Write the failing tests.** In `test/board-stage.test.ts`, change the
  `../src/board/stage` import line to:

```ts
import { boardHost, ELSEWHERE, NO_WORKER, syncStage, workerFor } from '../src/board/stage'
```

and append:

```ts
test('syncStage leaves everything alone when the record names another board pane, or there is none', async () => {
  const { herdr, calls } = fakeHerdr({})
  expect(await syncStage(herdr, onStage(), HOST, dir, SESSION, SLUG)).toBeNull()
  await withRecord({ pane_id: 'wP:p9', staged: STAGED })
  expect(await syncStage(herdr, onStage(), HOST, dir, SESSION, SLUG)).toBeNull()
  expect(calls).toEqual([])
  expect((await record())?.staged).toEqual(STAGED)
})

test("syncStage sends home a stage an earlier board left in this board's record", async () => {
  await withRecord({ staged: EARLIER_BOARDS_STAGE })
  const { herdr, methods } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage() }),
    'pane.move': () => moved('w1:p3'),
    'pane.close': () => ({ type: 'ok' }),
  })
  expect(await syncStage(herdr, onStage(), HOST, dir, SESSION, SLUG)).toBeNull()
  expect(methods()).toEqual(['session.snapshot', 'pane.move', 'pane.close'])
  expect((await record())?.staged).toBeNull()
})

test('syncStage keeps a stage still under the board without a call or a change', async () => {
  await withRecord({ staged: STAGED })
  const { herdr, calls } = fakeHerdr({})
  expect(await syncStage(herdr, onStage(), HOST, dir, SESSION, SLUG)).toEqual(STAGED)
  expect(calls).toEqual([])
  expect((await record())?.staged).toEqual(STAGED)
})

test('syncStage drops a stage whose worker is gone and closes its placeholder', async () => {
  await withRecord({ staged: STAGED })
  const snap = snapshot([], { workspaces: [GENERAL, BOARD_SPACE] })
  snap.panes.push(placeholder('w1:p2', 'tph'))
  const { herdr, calls } = fakeHerdr({ 'pane.close': () => ({ type: 'ok' }) })
  expect(await syncStage(herdr, snap, HOST, dir, SESSION, SLUG)).toBeNull()
  expect(calls).toEqual([{ method: 'pane.close', params: { pane_id: 'w1:p2' } }])
  expect((await record())?.staged).toBeNull()
})

test('syncStage does not write back a stage the supervisor cleared while it reconciled', async () => {
  await withRecord({ staged: STAGED })
  const snap = snapshot([
    agent({ terminal_id: 't1', pane_id: 'wP:p5', tab_id: 'wP:t1', workspace_id: 'wP' }),
    agent({ terminal_id: 't9', pane_id: 'wP:p6', tab_id: 'wP:t1', workspace_id: 'wP' }),
  ], { workspaces: [GENERAL, BOARD_SPACE] })
  const { herdr, methods } = fakeHerdr({
    'pane.move': async () => {
      await updateBoards(dir, SESSION, (boards) => { boards[SLUG]!.staged = null })
      return moved('wP:p7')
    },
  })
  expect(await syncStage(herdr, snap, HOST, dir, SESSION, SLUG)).toEqual({ ...STAGED, paneId: 'wP:p5' })
  expect(methods()).toEqual(['pane.move'])
  expect((await record())?.staged).toBeNull()
})
```

(The last test: the kit keeps the worker under its new pane id and evicts the stray `t9`; the evict's
move is where the fake clears the record, standing in for teardown's `closeStagedWorker`.)

- [ ] **Step 2: Run and see them fail.** `bun test test/board-stage.test.ts` → fails: export
  `syncStage` not found.

- [ ] **Step 3: Implement.** In `src/board/stage.ts`, replace the first two import lines:

```ts
import type { Host } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
```

with:

```ts
import type { Herdr } from '../kit/herdr'
import { reconcile, type Host } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
import { readBoards, recordStaged, type StagedWorker, unstageBoard } from '../lib/boards'
```

and append:

```ts
/**
 * `snap` must be the one the caller read before this reads the record: teardown clears the record
 * and then closes the worker, so an older snapshot can never show the worker gone while the record
 * still holds it.
 */
export async function syncStage(
  herdr: Herdr, snap: Snapshot, host: Host, stateDir: string, session: string, slug: string,
): Promise<StagedWorker | null> {
  const record = (await readBoards(stateDir, session))[slug]
  // a replaced board must not touch the stage its successor may hold
  if (!record || record.pane_id !== host.boardPaneId) return null
  const recorded = record.staged ?? null
  if (recorded && recorded.host.boardPaneId !== host.boardPaneId) {
    await unstageBoard(herdr, stateDir, session, slug)
    return null
  }
  const kept = await reconcile(herdr, snap, host, recorded)
  const next = kept ? { ...kept, host } : null
  if (JSON.stringify(next) !== JSON.stringify(recorded)) await recordStaged(stateDir, session, slug, next, recorded)
  return next
}
```

- [ ] **Step 4: Run and see them pass.** `bun test test/board-stage.test.ts` → 10 pass.
  `bunx tsc --noEmit` → no output.

- [ ] **Step 5: Commit.** `git add src/board/stage.ts test/board-stage.test.ts && git commit -m "feat(board): reconcile the board's recorded stage"`

---

### Task 3: `stageCard` — stage a worker and record it

Spec "`enter`" (`stageCard` steps 1–6), A8, A12.

- [ ] **Step 1: Write the failing tests.** Change the `../src/board/stage` import line to:

```ts
import { boardHost, ELSEWHERE, NO_WORKER, stageCard, syncStage, workerFor } from '../src/board/stage'
```

and append:

```ts
const STAGE_MOVE = (paneId: string) => ({
  method: 'pane.move',
  params: { pane_id: paneId, destination: { type: 'tab', tab_id: 'wP:t1', target_pane_id: 'wP:p1', split: 'down', ratio: 0.25 }, focus: false },
})

test('stageCard puts the worker under the board at 25/75 and records it with the host', async () => {
  await withRecord()
  const { herdr, calls } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: docsAtHome() }),
    'plugin.pane.open': () => opened('w1:p6'),
    'pane.move': () => moved('wP:p4'),
  })
  expect(await stageCard(herdr, HOST, IDENTITY, dir, SESSION, SLUG, 't2')).toEqual(DOCS_STAGED)
  expect(calls.slice(1)).toEqual([
    {
      method: 'plugin.pane.open',
      params: { plugin_id: 'stein.example', entrypoint: 'placeholder', placement: 'split', target_pane_id: 'w1:p5', direction: 'right', focus: false, env: { KIT_TITLE: 'Docs', KIT_STAGE: 'example' } },
    },
    STAGE_MOVE('w1:p5'),
  ])
  expect((await record())?.staged).toEqual(DOCS_STAGED)
})

const restager = (views: Snapshot[]) => fakeHerdr({
  'session.snapshot': () => ({ snapshot: views.shift() ?? docsAtHome() }),
  'pane.move': (p) => moved(p.pane_id === 'wP:p2' ? 'w1:p3' : 'wP:p4'),
  'pane.close': () => ({ type: 'ok' }),
  'plugin.pane.open': () => opened('w1:p6'),
})

test('stageCard sends the staged worker home before staging the next', async () => {
  await withRecord({ staged: STAGED })
  const { herdr, calls, methods } = restager([bothWorkers(), docsAtHome()])
  expect(await stageCard(herdr, HOST, IDENTITY, dir, SESSION, SLUG, 't2')).toEqual(DOCS_STAGED)
  expect(methods()).toEqual(['session.snapshot', 'pane.move', 'pane.close', 'session.snapshot', 'plugin.pane.open', 'pane.move'])
  expect(calls[1]?.params.pane_id).toBe('wP:p2')
  expect(calls[5]).toEqual(STAGE_MOVE('w1:p5'))
  expect((await record())?.staged).toEqual(DOCS_STAGED)
})

test('stageCard first sends home a stage an earlier board left in the record', async () => {
  await withRecord({ staged: EARLIER_BOARDS_STAGE })
  const { herdr, calls, methods } = restager([bothWorkers(), docsAtHome()])
  expect(await stageCard(herdr, HOST, IDENTITY, dir, SESSION, SLUG, 't2')).toEqual(DOCS_STAGED)
  expect(methods()).toEqual(['session.snapshot', 'pane.move', 'pane.close', 'session.snapshot', 'plugin.pane.open', 'pane.move'])
  expect(calls[1]?.params.pane_id).toBe('wP:p2')
  expect((await record())?.staged).toEqual(DOCS_STAGED)
})

test('stageCard refuses before anything moves when this board has no record or has been replaced', async () => {
  const { herdr, calls } = fakeHerdr({})
  await expect(stageCard(herdr, HOST, IDENTITY, dir, SESSION, SLUG, 't2')).rejects.toThrow('this board is not recorded yet')
  await withRecord({ pane_id: 'wP:p9' })
  await expect(stageCard(herdr, HOST, IDENTITY, dir, SESSION, SLUG, 't2')).rejects.toThrow('this board has been replaced')
  expect(calls).toEqual([])
})

test('stageCard undoes a stage whose board was replaced while the worker moved', async () => {
  await withRecord()
  const onDocsStage = snapshot([agent({ terminal_id: 't2', pane_id: 'wP:p4', tab_id: 'wP:t1', workspace_id: 'wP' })], { workspaces: [GENERAL, BOARD_SPACE] })
  onDocsStage.panes.push(placeholder('w1:p6', 'tph2'))
  const views = [docsAtHome(), onDocsStage]
  const { herdr, calls, methods } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: views.shift() }),
    'plugin.pane.open': () => opened('w1:p6'),
    'pane.move': async (p) => {
      if (p.pane_id !== 'w1:p5') return moved('w1:p7')
      await updateBoards(dir, SESSION, (boards) => { boards[SLUG] = { ...BOARD, pane_id: 'wP:p9' } })
      return moved('wP:p4')
    },
    'pane.close': () => ({ type: 'ok' }),
  })
  await expect(stageCard(herdr, HOST, IDENTITY, dir, SESSION, SLUG, 't2')).rejects.toThrow('this board has been replaced')
  expect(methods()).toEqual(['session.snapshot', 'plugin.pane.open', 'pane.move', 'session.snapshot', 'pane.move', 'pane.close'])
  expect(calls[4]).toEqual({
    method: 'pane.move',
    params: { pane_id: 'wP:p4', destination: { type: 'tab', tab_id: 'w1:t1', target_pane_id: 'w1:p6', split: 'right' }, focus: false },
  })
  expect(calls[5]).toEqual({ method: 'pane.close', params: { pane_id: 'w1:p6' } })
  expect((await record())?.staged).toBeUndefined()
})
```

- [ ] **Step 2: Run and see them fail.** `bun test test/board-stage.test.ts` → fails: export
  `stageCard` not found.

- [ ] **Step 3: Implement.** In `src/board/stage.ts`, replace the import lines:

```ts
import type { Herdr } from '../kit/herdr'
import { reconcile, type Host } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
import { readBoards, recordStaged, type StagedWorker, unstageBoard } from '../lib/boards'
```

with:

```ts
import { readSnapshot, type Herdr } from '../kit/herdr'
import { reconcile, stageAgent, StageError, unstage, type Host, type Identity } from '../kit/stage'
import type { PaneInfo, Snapshot } from '../kit/types'
import { readBoards, recordStaged, type StagedWorker, unstageBoard, updateBoards } from '../lib/boards'
```

replace:

```ts
export const ELSEWHERE = 'that worker is on another stage'
```

with:

```ts
export const ELSEWHERE = 'that worker is on another stage'
const NOT_RECORDED = 'this board is not recorded yet'
const REPLACED = 'this board has been replaced'
```

and append:

```ts
/** Throws StageError with a status-line message. */
export async function stageCard(
  herdr: Herdr, host: Host, identity: Identity, stateDir: string, session: string, slug: string, terminalId: string,
): Promise<StagedWorker> {
  const record = (await readBoards(stateDir, session))[slug]
  if (!record) throw new StageError(NOT_RECORDED)
  if (record.pane_id !== host.boardPaneId) throw new StageError(REPLACED)
  let current = record.staged ?? null
  if (current && current.host.boardPaneId !== host.boardPaneId) {
    await unstageBoard(herdr, stateDir, session, slug)
    current = null
  }
  const staged = await stageAgent(herdr, await readSnapshot(herdr), host, identity, current, terminalId)
  const next: StagedWorker = { ...staged, host }
  // recordStaged only checks that a record exists, and a replacement record would take a stale board's stage
  const recorded = await updateBoards(stateDir, session, (boards) => {
    const board = boards[slug]
    if (!board || board.pane_id !== host.boardPaneId) return false
    board.staged = next
    return true
  })
  if (!recorded) {
    // a stage no record names is invisible to every close path, and a later reconcile would lose its placeholder
    await unstage(herdr, await readSnapshot(herdr), host, next)
    throw new StageError(REPLACED)
  }
  return next
}
```

- [ ] **Step 4: Run and see them pass.** `bun test test/board-stage.test.ts` → 15 pass.
  `bunx tsc --noEmit` → no output.

- [ ] **Step 5: Commit.** `git add src/board/stage.ts test/board-stage.test.ts && git commit -m "feat(board): stage a card's worker under the board and record it"`

---

### Task 4: `unstageOwn` — undo this board's stage on quit

Spec "Quit", A12.

- [ ] **Step 1: Write the failing tests.** Change the `../src/board/stage` import line to:

```ts
import { boardHost, ELSEWHERE, NO_WORKER, stageCard, syncStage, unstageOwn, workerFor } from '../src/board/stage'
```

and append:

```ts
test('unstageOwn leaves alone a stage another board made, a replaced record, and a board with no pane', async () => {
  const { herdr, calls } = fakeHerdr({})
  await unstageOwn(herdr, dir, SESSION, SLUG, 'wP:p1')
  await withRecord({ staged: EARLIER_BOARDS_STAGE })
  await unstageOwn(herdr, dir, SESSION, SLUG, 'wP:p1')
  await withRecord({ pane_id: 'wP:p9', staged: STAGED })
  await unstageOwn(herdr, dir, SESSION, SLUG, 'wP:p1')
  await withRecord({ staged: STAGED })
  await unstageOwn(herdr, dir, SESSION, SLUG, undefined)
  expect(calls).toEqual([])
  expect((await record())?.staged).toEqual(STAGED)
})

test("unstageOwn sends this board's worker home and forgets the stage", async () => {
  await withRecord({ staged: STAGED })
  const { herdr, methods } = fakeHerdr({
    'session.snapshot': () => ({ snapshot: onStage() }),
    'pane.move': () => moved('w1:p3'),
    'pane.close': () => ({ type: 'ok' }),
  })
  await unstageOwn(herdr, dir, SESSION, SLUG, 'wP:p1')
  expect(methods()).toEqual(['session.snapshot', 'pane.move', 'pane.close'])
  expect((await record())?.staged).toBeNull()
})
```

- [ ] **Step 2: Run and see them fail.** `bun test test/board-stage.test.ts` → fails: export
  `unstageOwn` not found.

- [ ] **Step 3: Implement.** Append to `src/board/stage.ts`:

```ts
/** A board replaced by a newer one quits after it, and must not send the newer board's worker home. */
export async function unstageOwn(herdr: Herdr, stateDir: string, session: string, slug: string, boardPaneId: string | undefined): Promise<void> {
  const record = (await readBoards(stateDir, session))[slug]
  if (!boardPaneId || !record || record.pane_id !== boardPaneId || record.staged?.host.boardPaneId !== boardPaneId) return
  await unstageBoard(herdr, stateDir, session, slug)
}
```

- [ ] **Step 4: Run and see them pass.** `bun test test/board-stage.test.ts` → 17 pass.
  `bunx tsc --noEmit` → no output.

- [ ] **Step 5: Commit.** `git add src/board/stage.ts test/board-stage.test.ts && git commit -m "feat(board): undo only this board's stage when it quits"`

---

### Task 5: Keys line

Spec A14.

- [ ] **Step 1: Write the failing test.** In `test/board-view.test.ts`, replace:

```ts
  expect(KEYS).toBe('←↓↑→/hjkl move  space peek  o orchestrator  d details  x clear')
```

with:

```ts
  expect(KEYS).toBe('hjkl move  enter stage  tab focus  z zoom  space peek  o orch  d details  x clear')
```

- [ ] **Step 2: Run and see it fail.** `bun test test/board-view.test.ts` → the `KEYS` test fails.

- [ ] **Step 3: Implement.** In `src/board/view.ts`, replace:

```ts
export const KEYS = '←↓↑→/hjkl move  space peek  o orchestrator  d details  x clear'
```

with:

```ts
// the status line cuts the keys from the right, so the stage keys come right after move
export const KEYS = 'hjkl move  enter stage  tab focus  z zoom  space peek  o orch  d details  x clear'
```

- [ ] **Step 4: Run and see it pass.** `bun test test/board-view.test.ts` → all pass.

- [ ] **Step 5: Commit.** `git add src/board/view.ts test/board-view.test.ts && git commit -m "feat(board): list enter, tab and z on the keys line"`

---

### Task 6: Manifest `placeholder` pane

Spec A15.

- [ ] **Step 1: Write the failing test.** Append to `test/prompts.test.ts` (it already imports
  `existsSync`, `join`, `expect`, `test` and defines `ROOT`):

```ts
test('the manifest declares the placeholder pane the board stages workers with', async () => {
  const manifest = await Bun.file(join(ROOT, 'herdr-plugin.toml')).text()
  expect(manifest).toContain('[[panes]]\nid = "placeholder"\ntitle = "On stage"\nplacement = "split"\ncommand = ["bun", "run", "src/kit/placeholder.ts"]\n')
  expect(existsSync(join(ROOT, 'src/kit/placeholder.ts'))).toBe(true)
})
```

- [ ] **Step 2: Run and see it fail.** `bun test test/prompts.test.ts` → the new test fails.

- [ ] **Step 3: Implement.** In `herdr-plugin.toml`, after the `peek` pane block:

```toml
[[panes]]
id = "peek"
title = "Peek"
placement = "popup"
width = "70%"
height = "60%"
command = ["bun", "run", "src/kit/peek.ts"]
```

insert (with one blank line before and after):

```toml
[[panes]]
id = "placeholder"
title = "On stage"
placement = "split"
command = ["bun", "run", "src/kit/placeholder.ts"]
```

- [ ] **Step 4: Run and see it pass.** `bun test test/prompts.test.ts` → all pass.

- [ ] **Step 5: Commit.** `git add herdr-plugin.toml test/prompts.test.ts && git commit -m "feat(board): declare the placeholder pane a staged worker leaves at home"`

---

### Task 7: Wire the stage into the board UI

Spec "Refresh", "`enter`", "`tab` and `z`", "Quit"; A2, A3, A4, A7, A9, A10, A19. `ui.ts` has no unit
test (it starts the process loop); this task is verified by `tsc`, the full suite, and Task 9.

- [ ] **Step 1: Imports.** In `src/board/ui.ts`, replace:

```ts
import { readBoards } from '../lib/boards'
```

with:

```ts
import { readBoards, type StagedWorker } from '../lib/boards'
```

and replace:

```ts
import { buildBoard } from './model'
```

with:

```ts
import { buildBoard } from './model'
import { boardHost, stageCard, syncStage, unstageOwn, workerFor } from './stage'
```

- [ ] **Step 2: State.** Replace:

```ts
  let message: string | null = null
  let tick = 0
```

with:

```ts
  let message: string | null = null
  let tick = 0
  let staged: StagedWorker | null = null
  let quitting = false
```

- [ ] **Step 3: Reconcile last in `refresh`.** Replace the whole `refresh` function:

```ts
  async function refresh(): Promise<void> {
    const current = await readSnapshot(herdr)
    snap = current
    ensureSubscription(current)
    run = await runForSlug(stateDir, session, slug)
    if (!run) {
      board = EMPTY
      return
    }
    const found = run
```

up to and including its closing lines:

```ts
      cleared: clearedFor(await readBoards(stateDir, session), slug, found.run_id),
    })
  }
```

with:

```ts
  async function refresh(): Promise<void> {
    const current = await readSnapshot(herdr)
    snap = current
    ensureSubscription(current)
    run = await runForSlug(stateDir, session, slug)
    board = run ? await buildFor(run, current) : EMPTY
    const host = boardHost(current, process.env.HERDR_PANE_ID)
    // last, so a reconcile that throws leaves the board rebuilt and only the status line shows it
    if (host) staged = await syncStage(herdr, current, host, stateDir, session, slug)
  }

  async function buildFor(found: Run, current: Snapshot): Promise<Record<Column, CardView[]>> {
    const holds = await loadHolds(stateDir, session)
    const dispatches = await readDispatchLocks(stateDir, [found.repo_key])
    const livePanes = new Set(current.panes.map((p) => p.pane_id))
    const ctx = new Map<string, number>()
    for (const p of current.panes) {
      const value = Number.parseFloat(p.tokens?.ctx ?? '')
      if (Number.isFinite(value)) ctx.set(p.pane_id, Math.round(value))
    }
    // a finished or aborted run has released its orchestrator, so its absence is not news
    orchestratorLive = !runIsDriven(found) || (found.orchestrator_pane !== null && livePanes.has(found.orchestrator_pane))
    return buildBoard({
      run: found, holds, livePanes, ctx,
      orchestratorsMove: (task) => waitsOnYou(found, task, Date.now(), holds, dispatches),
      cleared: clearedFor(await readBoards(stateDir, session), slug, found.run_id),
    })
  }
```

The body of `buildFor` is the old body of `refresh` after `const found = run`, unchanged except that
it returns the board instead of assigning it. Compare it line by line with what you replaced: if a
sibling changed those lines, keep their version inside `buildFor`.

- [ ] **Step 4: Stage, focus, zoom.** After the `openDetails` function (before `function quit`),
  insert:

```ts
  async function stageWorker(card: CardView): Promise<void> {
    const host = snap ? boardHost(snap, process.env.HERDR_PANE_ID) : null
    if (!snap || !host) {
      message = 'this board does not know its pane'
      return
    }
    const worker = workerFor(run, snap, host, card.id)
    if (typeof worker === 'string') {
      message = worker
      return
    }
    staged = await stageCard(herdr, host, PIPELINE, stateDir, session, slug, worker.terminal_id)
    // the move renamed the worker's pane, and a tab or z queued behind this stage must find it
    snap = await readSnapshot(herdr)
    requestRefresh()
  }

  const stagedPane = () => (staged ? snap?.panes.find((p) => p.terminal_id === staged!.terminalId) : undefined)

  async function focusStage(): Promise<void> {
    const pane = stagedPane()
    if (pane) await herdr.call('pane.focus', { pane_id: pane.pane_id })
  }

  async function zoomStage(): Promise<void> {
    const pane = stagedPane()
    if (pane) await herdr.call('pane.zoom', { pane_id: pane.pane_id, mode: 'toggle' })
  }
```

- [ ] **Step 5: Quit undoes the stage.** Replace:

```ts
  function quit(): never {
    out(deleteAllImages() + '\x1b[2J\x1b[?25h')
    process.exit(0)
  }
```

with:

```ts
  // on serial, so it waits for a stage already in flight instead of leaving a worker staged with no record
  function quit(): void {
    if (quitting) return
    quitting = true
    void serial(() => unstageOwn(herdr, stateDir, session, slug, process.env.HERDR_PANE_ID).catch(() => {}))
      .finally(() => {
        try {
          out(deleteAllImages() + '\x1b[2J\x1b[?25h')
        } finally {
          process.exit(0)
        }
      })
  }
```

- [ ] **Step 6: Keys.** In `onKey`, replace:

```ts
  function onKey(key: string): void {
    const card = selected()
    message = null
    if (key === '\x03' || key === 'q') quit()
```

with:

```ts
  function onKey(key: string): void {
    if (quitting) return
    const card = selected()
    message = null
    if (key === '\x03' || key === 'q') return quit()
```

and replace:

```ts
    else if (key === 'd' && card) void serial(() => openDetails(card)).then(draw)
```

with:

```ts
    else if (key === 'd' && card) void serial(() => openDetails(card)).then(draw)
    // herdr 0.9.1 forwards Enter as \n; a raw terminal sends \r
    else if ((key === '\r' || key === '\n') && card) void serial(() => stageWorker(card)).then(draw)
    else if (key === '\t') void serial(focusStage).then(draw)
    else if (key === 'z') void serial(zoomStage).then(draw)
```

- [ ] **Step 7: A closed stdout quits through `quit` too.** Replace:

```ts
  process.stdout.on('error', () => process.exit(0))
```

with:

```ts
  process.stdout.on('error', quit)
```

- [ ] **Step 8: Verify.** `bunx tsc --noEmit` → no output. `bun test` → all pass, 0 fail.
  `grep -n "quit()" src/board/ui.ts` → only `return quit()` in `onKey`; `stdin`'s `end`/`error`,
  `SIGHUP` and `stdout`'s `error` pass `quit` itself.

- [ ] **Step 9: Commit.** `git add src/board/ui.ts && git commit -m "feat(board): enter stages the selected worker, tab focuses it, z zooms it"`

---

### Task 8: README

Spec A16. Re-read `README.md` around the board section (`**The board.**`) first.

- [ ] **Step 1:** In the board key table, replace:

```md
| `x` | clear a Done card |
| `q` or ctrl-c | quit |

The board is read-only: it moves no pane and writes nothing to the ledger or the store. Clearing a
Done card is remembered in the board's own record only.
```

with:

```md
| `x` | clear a Done card |
| `enter` | stage the task's worker under the board |
| `tab` | focus the staged worker |
| `z` | zoom the staged worker in or out |
| `q` or ctrl-c | quit, sending a staged worker home |

The board writes nothing to the ledger. `enter` moves the task's worker pane under the board, which
keeps the top quarter of the tab, and leaves an **On stage** placeholder in the worker's own tab.
Staging another card, quitting the board, or the supervisor closing or replacing it sends the worker
back to its placeholder. The board refuses a worker another board, such as pasture's, has staged
(`that worker is on another stage`), and never stages the orchestrator. Closing the board's tab by
hand closes the staged worker with it, and its task fails. The stage and the cleared Done cards are
remembered in the board's own record only.
```

- [ ] **Step 2: Commit.** `git add README.md && git commit -m "docs: describe staging a worker from the board"`

---

### Task 9: Live check in a scratch herdr session (worker only, not the subagent)

Spec "Live check". **Never point any of this at the live `default` or `herdr-plugin` session.**
herdr's plugin registry is global and serves the installed `stein.pipeline` 2.2.3, so this drives
this branch's functions directly; the placeholder comes from the linked `stein.pasture` plugin,
whose `placeholder` pane runs the same `src/kit/placeholder.ts`.

The spec asked for the binding to be checked "by running this branch's rebind". The rebind is
`tick.ts` code this task does not change and that is unit-tested; what the live session can show is
its input — the moved pane's new id with the same terminal id (`src/supervisor/tick.ts:337-370`).
Record that, and record the substitution in the PR.

- [ ] **Step 1: Start the scratch session**

```bash
tmux new-session -d -s hpl4 -x 220 -y 60 'herdr --session hpl4-scratch'
herdr session list
```

Re-run `herdr session list` until `hpl4-scratch` reads `running`. Then:

```bash
export S=$(herdr session list | awk '$1=="hpl4-scratch"{print $4}')
export HPL4_STATE=$(mktemp -d)
echo "$S"
```

Expected: `S` ends in `/sessions/hpl4-scratch/herdr.sock`.

- [ ] **Step 2: Guard — the CLI really talks to the scratch session**

```bash
herdr workspace list > $HPL4_STATE/live-ws.txt
HERDR_SOCKET_PATH=$S herdr workspace list > $HPL4_STATE/scratch-ws.txt
diff -q $HPL4_STATE/live-ws.txt $HPL4_STATE/scratch-ws.txt
```

Expected: the files differ. **If they are identical, stop.**

- [ ] **Step 3: Write the helper script (outside the repo).** Create `$HPL4_STATE/live.ts`:

```ts
const repo = '/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/feat-board-staging'
const { createClient, readSnapshot } = await import(`${repo}/src/kit/herdr.ts`)
const { closeStagedWorker, readBoards, updateBoards } = await import(`${repo}/src/lib/boards.ts`)
const { boardHost, stageCard, syncStage, unstageOwn } = await import(`${repo}/src/board/stage.ts`)

const IDENTITY = { pluginId: 'stein.pasture', placeholderEntrypoint: 'placeholder', peekEntrypoint: 'peek', stageName: 'pipeline' }
const stateDir = process.env.HPL4_STATE!
const session = 'scratch'
const slug = 'scratch-abc123'
const kit = createClient()
const [cmd, ...args] = process.argv.slice(2)
const hostOf = async (boardPaneId: string) => {
  const snap = await readSnapshot(kit)
  return { snap, host: boardHost(snap, boardPaneId)! }
}
const stagedPane = async () => {
  const staged = (await readBoards(stateDir, session))[slug]?.staged
  return staged ? (await readSnapshot(kit)).panes.find((p: { terminal_id: string }) => p.terminal_id === staged.terminalId) : undefined
}

if (cmd === 'panes') {
  const snap = await readSnapshot(kit)
  for (const p of snap.panes) console.log(`${p.pane_id}\ttab=${p.tab_id}\tws=${p.workspace_id}\tterm=${p.terminal_id}\tagent=${p.agent ?? '-'}`)
  for (const t of snap.tabs) console.log(`tab ${t.tab_id}\tws=${t.workspace_id}\t${t.label}`)
  for (const l of snap.layouts) console.log(`layout ${l.tab_id}\tzoomed=${l.zoomed}\tfocused=${l.focused_pane_id}`)
  console.log(`focused pane ${snap.focused_pane_id}`)
} else if (cmd === 'record') {
  await updateBoards(stateDir, session, (boards) => { boards[slug] = { ...boards[slug], pane_id: args[0]!, shell_pid: 0, opened_at_ms: Date.now() } })
  console.log('recorded', args[0])
} else if (cmd === 'stage') {
  const { snap, host } = await hostOf(args[0]!)
  const worker = snap.panes.find((p: { pane_id: string }) => p.pane_id === args[1])!
  console.log(JSON.stringify(await stageCard(kit, host, IDENTITY, stateDir, session, slug, worker.terminal_id), null, 2))
} else if (cmd === 'sync') {
  const { snap, host } = await hostOf(args[0]!)
  console.log(JSON.stringify(await syncStage(kit, snap, host, stateDir, session, slug), null, 2))
} else if (cmd === 'focus') {
  const pane = await stagedPane()
  if (pane) await kit.call('pane.focus', { pane_id: pane.pane_id })
  console.log('focused', pane?.pane_id)
} else if (cmd === 'zoom') {
  const pane = await stagedPane()
  if (pane) await kit.call('pane.zoom', { pane_id: pane.pane_id, mode: 'toggle' })
  console.log('zoomed', pane?.pane_id)
} else if (cmd === 'quit') {
  await unstageOwn(kit, stateDir, session, slug, args[0])
  console.log('quit')
} else if (cmd === 'close') {
  console.log('closed', await closeStagedWorker(kit, stateDir, session, slug, args[0]!))
} else if (cmd === 'show') {
  console.log(JSON.stringify((await readBoards(stateDir, session))[slug], null, 2))
}
```

All later `bun` calls run as `HERDR_SOCKET_PATH=$S bun $HPL4_STATE/live.ts <cmd>`. Define it once in
the shell that runs the steps (a function, because aliases do not expand in a non-interactive shell):

```bash
L() { HERDR_SOCKET_PATH=$S bun $HPL4_STATE/live.ts "$@"; }
```

In steps 9 and 10, `W1NOW`/`W2NOW` are the worker's current pane id and `W1STAGED` its pane id under
the board, read from the preceding `L panes`.

- [ ] **Step 4: Two homes and a board**

```bash
HERDR_SOCKET_PATH=$S herdr workspace create --label hpl4-home1 --no-focus
HERDR_SOCKET_PATH=$S herdr workspace create --label hpl4-home2 --no-focus
HERDR_SOCKET_PATH=$S herdr workspace create --label hpl4-board --no-focus
L panes
```

Note `W1` (hpl4-home1's one pane), `W2` (hpl4-home2's), `BOARD` (hpl4-board's), and the workspace ids `WH1` (hpl4-home1) and `WB` (hpl4-board); export each (`export W1=w2:p1` …). Then `L record $BOARD`.

- [ ] **Step 5: Stage W1 (spec live step 1)**

```bash
L stage $BOARD $W1
L panes
L show
tmux capture-pane -p -t hpl4 | head -60
```

Expected: W1's terminal is in `BOARD`'s tab under a new pane id (same `term=`: the rebind's input);
a pane with `agent=-` sits in hpl4-home1's tab and reads "is on the pipeline stage"; `staged` in the
record names W1's terminal and `host.boardPaneId` = `BOARD`. Switch the scratch session to the board
workspace (`HERDR_SOCKET_PATH=$S herdr workspace focus $WB`) and capture again: the board
pane holds about the top quarter, W1 the rest.

- [ ] **Step 6: Focus and zoom**

```bash
L focus; L panes | grep 'focused pane'
L zoom; L panes | grep layout
L zoom; L panes | grep layout
```

Expected: the focused pane is W1's new id; the board tab's layout reads `zoomed=true`, then
`zoomed=false`.

- [ ] **Step 7: Stage W2 — W1 goes home first**

```bash
L stage $BOARD $W2
L panes
```

Expected: W1's terminal is back in hpl4-home1's tab and its placeholder is gone; W2 is under the board;
a placeholder sits in hpl4-home2. `L sync $BOARD` prints the same stage and moves nothing.

- [ ] **Step 8: Reopen the board — the worker goes home (spec live step 3)**

```bash
HERDR_SOCKET_PATH=$S herdr pane split $BOARD --direction right --no-focus
L panes
```

Note the new pane `BOARD2` (in the board tab, the new board). Then:

```bash
L record $BOARD2
L sync $BOARD
L sync $BOARD2
L panes
L show
```

Expected: `sync $BOARD` prints `null` and moves nothing (a replaced board acts on nothing);
`sync $BOARD2` prints `null`, W2 is back in hpl4-home2's tab, its placeholder is gone, and `staged` is
`null`. `L quit $BOARD` afterwards changes nothing.

- [ ] **Step 9: Teardown while staged (spec live step 4)**

```bash
L stage $BOARD2 $W1NOW
L panes
L close $W1STAGED
HERDR_SOCKET_PATH=$S herdr workspace close $WH1
L panes
```

Expected: `closed true`; no pane with W1's terminal is left anywhere, and nothing of hpl4-home1 is
left (its placeholder went with the workspace).

- [ ] **Step 10: Quit sends the worker home**

```bash
L stage $BOARD2 $W2NOW
L quit $BOARD2
L panes
L show
```

Expected: W2 back in hpl4-home2, placeholder gone, `staged` `null`.

- [ ] **Step 11: Tear the scratch session down**

```bash
herdr session stop hpl4-scratch
tmux kill-session -t hpl4
rm -rf $HPL4_STATE
```

- [ ] **Step 12: The board's own keys.** `enter`/`tab`/`z` through `ui.ts` need the `stein.pipeline`
  manifest with `placeholder` registered, which is global. Raise it as the last action of the turn:

```bash
hpipe decide --task t4 \
  --question "The board's enter/tab/z keys can only be checked live with this branch's manifest registered, and herdr's plugin registry is global: a 'herdr plugin link' of this worktree would also swap the plugin under the live herdr-plugin session driving this run. The branch functions they call passed the scratch-session harness (steps 5-10). Link briefly, or check the keys after release?" \
  --recommend "Check the keys after release: the keys only wire the harness-verified functions to stdin, the \\n/\\r split is unit-tested, and a link swaps the supervisor's plugin mid-run (.claude/agents/plugin-dev.md 'The self-hosting hazard'). Note the post-release check in the PR body."
```

Record every observation from steps 5–10, and any difference from "Expected", for the PR body. A
difference is a finding, not a test to bend.
