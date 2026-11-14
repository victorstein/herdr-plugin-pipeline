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
