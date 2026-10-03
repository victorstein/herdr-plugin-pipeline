import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBoardAction, type OpenBoardActionDeps } from '../src/actions/board'
import { type BoardPaneDeps, runBoardPane } from '../src/board'
import { beadsDir, beadsExportPath, beadsHome, beadsSlug, writeBeadsProject } from '../src/lib/beads-project'
import { LockTimeoutError } from '../src/lib/store'
import { BV_INSTALL_HINT } from '../src/lib/tools'
import { boardLabel, isRenamedBoardLabel, readBoards, updateBoards } from '../src/lib/boards'
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
  openedPaneId?: string, onOpen: () => Promise<void> = async () => {}, closeFails: string[] = [],
) {
  const calls: string[] = []
  const herdr: BoardDeps['herdr'] = {
    paneList: async () => [SUPERVISOR_PANE, ...panes],
    paneShellPid: async (paneId) => shellPids[paneId],
    paneClose: async (paneId) => {
      calls.push(`close ${paneId}`)
      return closeFails.includes(paneId) ? { ok: false, code: 'pane_busy' } : { ok: true }
    },
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
  await openBoard(SLUG, deps(herdr), undefined)
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: { pane_id: 'w9:p7', shell_pid: null, opened_at_ms: 100_000 } })
})

test('a board that recorded itself before herdr answered the open keeps its own record', async () => {
  const recordedByBoard = { pane_id: 'w9:p7', shell_pid: 555, opened_at_ms: 100_050 }
  const { herdr } = fakeHerdr([], {}, 'w9:p7', () =>
    updateBoards(dir, 'personal', (boards) => { boards[SLUG] = recordedByBoard }))
  await openBoard(SLUG, deps(herdr), undefined)
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: recordedByBoard })
})

test('a failed open forgets its placeholder', async () => {
  const herdr: BoardDeps['herdr'] = {
    ...fakeHerdr([]).herdr,
    pluginPaneOpen: async () => ({ ok: false, code: 'plugin_not_found', message: 'x' }),
  }
  await openBoard(SLUG, deps(herdr), undefined)
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

test('a board is labelled with its repo and hash, and only that reads as a renamed board', () => {
  expect(boardLabel('meter-abc123')).toBe('Board: meter abc123')
  expect(isRenamedBoardLabel('Board: meter abc123')).toBe(true)
  for (const label of ['Board', 'Pipeline supervisor', 'Boards', '', undefined, null]) {
    expect(isRenamedBoardLabel(label)).toBe(false)
  }
})

test('openBoard opens nothing when the record changed since the caller read it', async () => {
  const stale = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 }
  const newer = { pane_id: null, shell_pid: null, opened_at_ms: 99_000 }
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = newer })
  const { herdr, calls } = fakeHerdr([])
  expect(await openBoard(SLUG, deps(herdr), stale)).toBe(false)
  expect(await openBoard(SLUG, deps(herdr), undefined)).toBe(false)
  expect(calls).toEqual([])
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: newer })
})

test('a tick that read a board the action has since replaced does not open a second one', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const replaced = { pane_id: null, shell_pid: null, opened_at_ms: 99_000 }
  const herdr: BoardDeps['herdr'] = {
    ...fakeHerdr([]).herdr,
    paneList: async () => {
      await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = replaced })
      return [SUPERVISOR_PANE]
    },
  }
  const opened: string[] = []
  herdr.pluginPaneOpen = async (pluginId) => { opened.push(pluginId); return { ok: true } }
  await syncBoards([runIn('execute')], deps(herdr))
  expect(opened).toEqual([])
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: replaced })
})

test('a renamed board no record names is a ghost and is closed; a just-opened plain Board is not', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([
    BOARD_PANE,
    { pane_id: 'w9:p6', label: boardLabel(SLUG) },
    { pane_id: 'w9:p8', label: 'Board' },
  ], { 'w9:p4': 321 })
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual(['close w9:p6'])
})

test('ghost boards are closed even when no repo wants a board', async () => {
  const { herdr, calls } = fakeHerdr([{ pane_id: 'w9:p6', label: boardLabel(SLUG) }])
  await syncBoards([], deps(herdr))
  expect(calls).toEqual(['close w9:p6'])
})

test('an unwanted board whose close fails keeps its record, to be closed next tick', async () => {
  const board = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 }
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = board })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], { 'w9:p4': 321 }, undefined, undefined, ['w9:p4'])
  await syncBoards([runIn('done')], deps(herdr))
  expect(calls).toEqual(['close w9:p4'])
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: board })
})

test('a dead board whose close fails is not replaced this tick', async () => {
  const board = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 }
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = board })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], { 'w9:p4': 999 }, undefined, undefined, ['w9:p4'])
  await syncBoards([runIn('execute')], deps(herdr))
  expect(calls).toEqual(['close w9:p4'])
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: board })
})

function paneDeps(over: Partial<BoardPaneDeps> = {}) {
  const spawned: { argv: string[]; cwd: string; env: Record<string, string | undefined> }[] = []
  const renamed: string[] = []
  const errors: string[] = []
  const paneDeps: BoardPaneDeps = {
    env: { HERDR_PLUGIN_STATE_DIR: dir, HPIPE_BEADS_SLUG: SLUG, HERDR_PANE_ID: 'w9:p4', HERDR_SESSION: 'personal', BV_BIN: 'fake-bv' },
    parentPid: 4242,
    now: () => 100_000,
    renamePane: async (paneId, label) => { renamed.push(`${paneId} ${label}`) },
    updateBoards,
    which: (bin) => (bin === 'fake-bv' ? '/bin/fake-bv' : null),
    runBv: async (argv, { cwd, env }) => { spawned.push({ argv, cwd, env }); return 0 },
    error: (message) => { errors.push(message) },
    ...over,
  }
  return { paneDeps, spawned, renamed, errors }
}

test('the board pane records its pane and shell, renames itself, and runs bv on the export', async () => {
  const { paneDeps: d, spawned, renamed } = paneDeps()
  expect(await runBoardPane(d)).toBe(0)
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: { pane_id: 'w9:p4', shell_pid: 4242, opened_at_ms: 100_000 } })
  expect(renamed).toEqual([`w9:p4 ${boardLabel(SLUG)}`])
  expect(spawned).toHaveLength(1)
  expect(spawned[0]?.argv).toEqual(['fake-bv', '--db', beadsExportPath(dir, SLUG)])
  expect(spawned[0]?.cwd).toBe(beadsHome(dir, SLUG))
  expect(spawned[0]?.env).toMatchObject({ BEADS_DIR: beadsDir(dir, SLUG), BV_NO_UPDATE_CHECK: '1', BV_NO_GITIGNORE: '1' })
})

test('the board pane keeps the opened_at_ms the supervisor recorded', async () => {
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: null, opened_at_ms: 7 } })
  await runBoardPane(paneDeps().paneDeps)
  expect((await readBoards(dir, 'personal'))[SLUG]?.opened_at_ms).toBe(7)
})

test('a board pane that cannot record itself stays unrenamed and still runs bv', async () => {
  const { paneDeps: d, spawned, renamed, errors } = paneDeps({
    updateBoards: async () => { throw new LockTimeoutError('/x/boards.personal.json.lock') },
  })
  expect(await runBoardPane(d)).toBe(0)
  expect(renamed).toEqual([])
  expect(spawned).toHaveLength(1)
  expect(errors.join('\n')).toContain('could not record itself')
})

test('a board pane without HERDR_PANE_ID says so and still runs bv', async () => {
  const base = paneDeps()
  const { paneDeps: d, spawned, errors } = paneDeps({ env: { ...base.paneDeps.env, HERDR_PANE_ID: undefined } })
  expect(await runBoardPane(d)).toBe(0)
  expect(spawned).toHaveLength(1)
  expect(errors.join('\n')).toContain('HERDR_PANE_ID')
  expect(await readBoards(dir, 'personal')).toEqual({})
})

test('a board pane with no bv installed exits 1 with the install hint', async () => {
  const { paneDeps: d, spawned, errors } = paneDeps({ which: () => null })
  expect(await runBoardPane(d)).toBe(1)
  expect(spawned).toEqual([])
  expect(errors.join('\n')).toContain(BV_INSTALL_HINT)
})

test('a board pane missing its slug exits 1 without running bv', async () => {
  const { paneDeps: d, spawned } = paneDeps({ env: { HERDR_PLUGIN_STATE_DIR: dir } })
  expect(await runBoardPane(d)).toBe(1)
  expect(spawned).toEqual([])
})

function actionDeps(herdr: BoardDeps['herdr'], over: Partial<OpenBoardActionDeps> = {}) {
  const logs: string[] = []
  const errors: string[] = []
  const actionDeps: OpenBoardActionDeps = {
    stateDir: dir, session: 'personal', pluginId: 'stein.pipeline', repoKey: REPO,
    workspaceId: async () => 'w9', now: () => 100_000, herdr,
    log: (message) => { logs.push(message) }, error: (message) => { errors.push(message) },
    ...over,
  }
  return { actionDeps, logs, errors }
}

const withStore = () => writeBeadsProject(dir, SLUG, { repo_root: REPO, prefix: 'meter', created_at: 1 })

test('"Open board" closes the recorded board and opens a fresh one in its place', async () => {
  await withStore()
  await updateBoards(dir, 'personal', (boards) => { boards[SLUG] = { pane_id: 'w9:p4', shell_pid: 321, opened_at_ms: 1 } })
  const { herdr, calls } = fakeHerdr([BOARD_PANE], {}, 'w9:p7')
  const { actionDeps: d, logs } = actionDeps(herdr)
  expect(await openBoardAction(d)).toBe(0)
  expect(calls).toEqual(['close w9:p4', OPEN()])
  expect(await readBoards(dir, 'personal')).toEqual({ [SLUG]: { pane_id: 'w9:p7', shell_pid: null, opened_at_ms: 100_000 } })
  expect(logs).toEqual([`[pipeline] board opened for ${SLUG}`])
})

test('"Open board" refuses outside a repo, without a store, or without a workspace', async () => {
  const { herdr, calls } = fakeHerdr([])
  expect(await openBoardAction(actionDeps(herdr, { repoKey: null }).actionDeps)).toBe(1)
  const noStore = actionDeps(herdr)
  expect(await openBoardAction(noStore.actionDeps)).toBe(1)
  expect(noStore.errors.join('\n')).toContain('Set up Beads for this repo')
  await withStore()
  expect(await openBoardAction(actionDeps(herdr, { workspaceId: async () => null }).actionDeps)).toBe(1)
  expect(calls).toEqual([])
})
