import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
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
