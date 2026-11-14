import { CELL_QUERY, FrameWriter, takeCellReply } from '../kit/frame'
import { createClient, readSnapshot, subscribe, type Subscription } from '../kit/herdr'
import { deleteAllImages } from '../kit/kitty'
import { COLUMNS, moveCursor, type Column } from '../kit/nav'
import { openPeek } from '../kit/peek'
import { render, type CardView } from '../kit/render'
import type { Identity } from '../kit/stage'
import { createThrottle } from '../kit/throttle'
import type { Snapshot } from '../kit/types'
import type { BoardUiOptions } from '../board'
import { readBoards, stagedPane as findStagedPane, type StagedWorker } from '../lib/boards'
import { readDispatchLocks } from '../lib/dispatch-lock'
import { runIsDriven } from '../lib/ledger'
import { waitsOnYou } from '../lib/status'
import type { Run } from '../lib/types'
import { clearedFor, loadHolds, recordCleared, runForSlug } from './data'
import { NAV, splitKeys } from './keys'
import { buildBoard } from './model'
import { boardHost, stageCard, syncStage, unstageOwn, workerFor } from './stage'
import './scenes'
import { header, KEYS, summary, TITLES } from './view'

export const PIPELINE: Identity = { pluginId: 'stein.pipeline', placeholderEntrypoint: 'placeholder', peekEntrypoint: 'peek', stageName: 'pipeline' }

const EMPTY: Record<Column, CardView[]> = { needs: [], working: [], done: [], idle: [] }
const LIFECYCLE = [
  'pane.created', 'pane.closed', 'pane.moved', 'pane.exited', 'pane.updated', 'pane.agent_detected',
  'tab.closed', 'workspace.closed', 'workspace.focused',
]

export function runBoardUi({ stateDir, session, slug }: BoardUiOptions): Promise<number> {
  const herdr = createClient()
  const writer = new FrameWriter()
  const out = (s: string) => process.stdout.write(s)
  let snap: Snapshot | null = null
  let run: Run | null = null
  let board = EMPTY
  let orchestratorLive = true
  let cursor: string | null = null
  let message: string | null = null
  let tick = 0
  let staged: StagedWorker | null = null
  let quitting = false

  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
  let chain: Promise<void> = Promise.resolve()
  const serial = (job: () => Promise<void>) => (chain = chain.then(job).catch((e) => { message = errorText(e) }))

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

  let refreshQueued = false
  function queueRefresh(): void {
    if (refreshQueued) return
    refreshQueued = true
    void serial(async () => {
      refreshQueued = false
      await refresh()
      message = null
    }).then(draw)
  }
  // herdr emits events in bursts, and each refresh reads the ledger and a snapshot
  const requestRefresh = createThrottle(queueRefresh, 400)

  let unsubscribe: (() => void) | null = null
  let subscribedPanes = ''
  // agent_status_changed subscriptions need a pane id each, and pane ids change on every move
  function ensureSubscription(current: Snapshot): void {
    const panes = current.agents.filter((a) => a.agent).map((a) => a.pane_id).sort()
    const key = panes.join(',')
    if (unsubscribe && key === subscribedPanes) return
    unsubscribe?.()
    subscribedPanes = key
    const subs: Subscription[] = [...LIFECYCLE.map((type) => ({ type })), ...panes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }))]
    unsubscribe = subscribe(subs, requestRefresh, () => {
      unsubscribe = null
      setTimeout(requestRefresh, 1000)
    })
  }

  function visible(): boolean {
    const self = snap?.panes.find((p) => p.pane_id === process.env.HERDR_PANE_ID)
    if (!process.env.HERDR_PANE_ID || !snap || !self) return true
    const workspace = snap.workspaces.find((w) => w.workspace_id === self.workspace_id)
    return snap.focused_workspace_id === self.workspace_id && workspace?.active_tab_id === self.tab_id
  }

  const cards = () => COLUMNS.flatMap((c) => board[c])
  const selected = () => cards().find((c) => c.id === cursor) ?? null

  function draw(): void {
    if (!selected()) cursor = moveCursor(board, null, 'down')
    const frame = render(
      { board, cursor, header: header(run, orchestratorLive), summary: summary(board), keys: KEYS, titles: TITLES, message, now: Date.now(), tick, cell: writer.cell },
      process.stdout.columns ?? 120, process.stdout.rows ?? 40,
    )
    const screen = writer.write(frame)
    if (screen) out(screen)
  }

  async function peekWorker(card: CardView): Promise<void> {
    const task = run?.tasks.find((t) => t.task_id === card.id)
    const pane = task?.pane_id ? snap?.panes.find((p) => p.pane_id === task.pane_id) : undefined
    if (!task || !pane) {
      message = 'no worker to peek at'
      return
    }
    await openPeek(herdr, PIPELINE, { terminalId: pane.terminal_id, title: card.title, where: `${run!.title} · ${task.phase}` })
  }

  async function peekOrchestrator(): Promise<void> {
    const pane = run?.orchestrator_pane ? snap?.panes.find((p) => p.pane_id === run!.orchestrator_pane) : undefined
    if (!run || !pane) {
      message = 'orchestrator is not running'
      return
    }
    await openPeek(herdr, PIPELINE, { terminalId: pane.terminal_id, title: 'orchestrator', where: run.title })
  }

  async function openDetails(card: CardView): Promise<void> {
    if (!run) return
    if (card.id.startsWith('run:')) {
      message = 'no details for the run'
      return
    }
    await herdr.call('plugin.pane.open', {
      plugin_id: PIPELINE.pluginId, entrypoint: 'details', placement: 'popup', width: '80%', height: '70%', focus: true,
      env: { HPIPE_DETAIL_RUN: run.run_id, HPIPE_DETAIL_TASK: card.id },
    })
  }

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

  const stagedPaneNow = () => (staged && snap ? findStagedPane(snap, staged) : undefined)

  async function focusStage(): Promise<void> {
    const pane = stagedPaneNow()
    if (pane) await herdr.call('pane.focus', { pane_id: pane.pane_id })
  }

  async function zoomStage(): Promise<void> {
    const pane = stagedPaneNow()
    if (pane) await herdr.call('pane.zoom', { pane_id: pane.pane_id, mode: 'toggle' })
  }

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

  function onKey(key: string): void {
    if (quitting) return
    const card = selected()
    message = null
    if (key === '\x03' || key === 'q') return quit()
    const direction = NAV[key]
    if (direction) cursor = moveCursor(board, cursor, direction)
    else if (key === ' ' && card) void serial(() => peekWorker(card)).then(draw)
    else if (key === 'o') void serial(peekOrchestrator).then(draw)
    else if (key === 'd' && card) void serial(() => openDetails(card)).then(draw)
    // herdr 0.9.1 forwards Enter as \n; a raw terminal sends \r
    else if ((key === '\r' || key === '\n') && card) void serial(() => stageWorker(card)).then(draw)
    else if (key === '\t') void serial(focusStage).then(draw)
    else if (key === 'z') void serial(zoomStage).then(draw)
    else if (key === 'x' && card?.column === 'done' && run) {
      const runId = run.run_id
      void serial(async () => {
        if (await recordCleared(stateDir, session, slug, runId, card.id)) requestRefresh()
        else message = 'this board is not recorded yet'
      }).then(draw)
    }
    draw()
  }

  // a closed pty must end the process, or a headless board keeps running
  process.stdin.on('end', quit)
  process.stdin.on('error', quit)
  process.stdout.on('error', quit)
  process.on('SIGHUP', quit)
  // a dead board leaves the user without one, so errors are shown in the status line instead
  process.on('uncaughtException', (e) => { message = errorText(e); try { draw() } catch {} })
  process.on('unhandledRejection', (e) => { message = errorText(e); try { draw() } catch {} })

  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on('data', (data) => {
    const { rest, cell } = takeCellReply(data.toString())
    if (cell) writer.setCell(cell)
    if (rest) for (const key of splitKeys(rest)) onKey(key)
    else draw()
  })
  process.stdout.on('resize', () => {
    writer.invalidate()
    out(CELL_QUERY)
    draw()
  })
  out('\x1b[?25l' + CELL_QUERY)
  requestRefresh()
  // the ledger changes without any herdr event
  setInterval(requestRefresh, 2000)
  setInterval(() => {
    if (!visible()) return
    tick++
    draw()
  }, 250)
  return new Promise<number>(() => {})
}
