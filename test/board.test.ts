import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beadsHome, beadsSlug } from '../src/lib/beads-project'
import { boardLabel, isBoardLabel, readBoards, updateBoards } from '../src/lib/boards'
import type { PaneInfo, PaneOpenOptions } from '../src/lib/herdr'
import { newRun } from '../src/lib/ledger'
import type { Run } from '../src/lib/types'
import { type BoardDeps, openBoard, syncBoards } from '../src/supervisor/boards'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'board-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const REPO = '/code/meter'
const SLUG = beadsSlug(REPO)

function runIn(phase: Run['phase']): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: REPO, repoRoot: REPO, title: 'a' })
  run.phase = phase
  return run
}

function fakeHerdr(
  panes: PaneInfo[], shellPids: Record<string, number | undefined> = {},
  openedPaneId?: string, onOpen: () => Promise<void> = async () => {},
) {
  const calls: string[] = []
  const herdr: BoardDeps['herdr'] = {
    paneList: async () => [SUPERVISOR_PANE, ...panes],
    paneShellPid: async (paneId) => shellPids[paneId],
    paneClose: async (paneId) => { calls.push(`close ${paneId}`); return { ok: true } },
    pluginPaneOpen: async (pluginId, entrypoint, workspaceId, options?: PaneOpenOptions) => {
      calls.push(`open ${pluginId} ${entrypoint} ${workspaceId} ${options?.cwd} ${JSON.stringify(options?.env)}`)
      await onOpen()
      return openedPaneId === undefined
        ? { ok: true }
        : { ok: true, result: { plugin_pane: { pane: { pane_id: openedPaneId } } } }
    },
  }
  return { herdr, calls }
}

function deps(herdr: BoardDeps['herdr'], over: Partial<BoardDeps> = {}): BoardDeps {
  return {
    stateDir: dir, session: 'personal', pluginId: 'stein.pipeline', workspaceId: 'w9',
    now: () => 100_000, hasStore: async () => true, herdr, ...over,
  }
}

const OPEN = (): string => `open stein.pipeline board w9 ${beadsHome(dir, SLUG)} {"HPIPE_BEADS_SLUG":"${SLUG}"}`
const SUPERVISOR_PANE: PaneInfo = { pane_id: 'w9:p1', label: 'Pipeline supervisor' }
const BOARD_PANE: PaneInfo = { pane_id: 'w9:p4', label: boardLabel(SLUG) }

test('a repo with a live run and no board gets one, recorded as booting before it is opened', async () => {
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([OPEN()])
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: { pane_id: null, shell_pid: null, opened_at_ms: 100_000 } })
})

test('the pane id herdr reports for a new board is recorded at once', async () => {
  const { herdr } = fakeHerdr([], {}, 'w9:p7')
  await openBoard(SLUG, deps(herdr))
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: { pane_id: 'w9:p7', shell_pid: null, opened_at_ms: 100_000 } })
})

test('a board that recorded itself before herdr answered the open keeps its own record', async () => {
  const recordedByBoard = { pane_id: 'w9:p7', shell_pid: 555, opened_at_ms: 100_050 }
  const { herdr } = fakeHerdr([], {}, 'w9:p7', () =>
    updateBoards(dir, 'personal', (boards) => { boards[SLUG] = recordedByBoard }))
  await openBoard(SLUG, deps(herdr))
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: recordedByBoard })
})

test('a failed open forgets its placeholder', async () => {
  const herdr: BoardDeps['herdr'] = {
    ...fakeHerdr([]).herdr,
    pluginPaneOpen: async () => ({ ok: false, code: 'plugin_not_found', message: 'x' }),
  }
  await openBoard(SLUG, deps(herdr))
  expect(await readBoards(dir, 'personal')).toEqual({})
})

test('a booting board is left alone inside its grace, and opened again past it', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: null, shell_pid: null, opened_at_ms: 90_000 } })
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([])
  await syncBoards([runIn('execute')], deps(herdr, { now: () => 130_001 }))
  expect(calls).toEqual([OPEN()])
})

test('a board whose pane is known but whose shell is not yet recorded is booting, not a ghost', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: null, opened_at_ms: 90_000 } })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([])
  await syncBoards([runIn('execute')], deps(herdr, { now: () => 130_001 }))
  expect(calls).toEqual(['close w9:p4', OPEN()])
})

test('a board whose shell is the one it recorded stays; one whose shell changed is a ghost and is replaced', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const same = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('execute')], deps(same.herdr))
  expect(same.calls).toEqual([])

  const restarted = fakeHerdr([BOARD_PANE], { 'w9:p4': 999 })
  await syncBoards([runIn('execute')], deps(restarted.herdr))
  expect(restarted.calls).toEqual(['close w9:p4', OPEN()])
})

test('a shell pid herdr cannot report is not taken for a ghost', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], {})
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([])
})

test('a recorded board whose pane is gone is opened again', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual([OPEN()])
})

test('a board whose repo has no live run left is closed and forgotten', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 })
  await syncBoards([runIn('done')], deps(herdr))
  expect(calls).toEqual(['close w9:p4'])
  expect(await readBoards(dir, 'personal')).toEqual({})
})

test('a pane list that comes back empty is a failed call, not every board gone', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const herdr: BoardDeps['herdr'] = { ...fakeHerdr([]).herdr, paneList: async () => [] }
  const opened: string[] = []
  herdr.pluginPaneOpen = async (pluginId) => { opened.push(pluginId); return { ok: true } }
  await syncBoards([runIn('execute')], deps(herdr))
  expect(opened).toEqual([])
  expect(Object.keys(await readBoards(dir, 'personal'))).toEqual([SLUG])
})

test('no Beads store, no board', async () => {
  const { herdr, calls } = fakeHerdr([])
  await syncBoards([runIn('execute')], deps(herdr, { hasStore: async () => false }))
  expect(calls).toEqual([])
})

test('a board is labelled with its repo and hash, and only board labels read as boards', () => {
  expect(boardLabel('meter-abc123')).toBe('Board: meter abc123')
  expect(isBoardLabel('Board')).toBe(true)
  expect(isBoardLabel('Board: meter abc123')).toBe(true)
  for (const label of ['Pipeline supervisor', 'Boards', '', undefined, null]) expect(isBoardLabel(label)).toBe(false)
})
