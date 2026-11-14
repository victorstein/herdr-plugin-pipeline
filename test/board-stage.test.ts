import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boardHost, ELSEWHERE, NO_WORKER, stageCard, syncStage, workerFor } from '../src/board/stage'
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
  const file = join(dir, `boards.${SESSION}.json`)
  const inode = statSync(file).ino
  const { herdr, calls } = fakeHerdr({})
  expect(await syncStage(herdr, onStage(), HOST, dir, SESSION, SLUG)).toEqual(STAGED)
  expect(calls).toEqual([])
  // every write renames a new file over the old one, so an unchanged inode means no write
  expect(statSync(file).ino).toBe(inode)
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
