import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeStagedWorker, readBoards, recordStaged, type StagedWorker, unstageBoard, updateBoards } from '../src/lib/boards'
import type { Snapshot } from '../src/kit/types'
import { fakeHerdr, moved } from './kit/fake-herdr'
import { agent, snapshot } from './kit/fixtures'

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

test('closeStagedWorker finds a worker staged before the supervisor followed the move, by its home workspace', async () => {
  await withBoard(STAGED)
  const { herdr, calls } = fakeHerdr({ 'session.snapshot': () => ({ snapshot: onStage() }), 'pane.close': () => ({ type: 'ok' }) })
  expect(await closeStagedWorker(herdr, dir, 'personal', SLUG, 'w1:p1', 'w1')).toBe(true)
  expect(calls.slice(1)).toEqual([{ method: 'pane.close', params: { pane_id: 'wP:p2' } }])
  expect((await readBoards(dir, 'personal'))[SLUG]?.staged).toBeNull()
})
