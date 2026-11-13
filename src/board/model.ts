import type { Column } from '../kit/nav'
import { MOCHA } from '../kit/palette'
import type { CardView, Span } from '../kit/render'
import { heldForTheHuman, owedAt, owedInRun } from '../lib/before-merge'
import { escalatedUnanswered } from '../lib/decisions'
import type { PaneHold } from '../lib/delivery-health'
import { fileHolders, TERMINAL_BAD } from '../lib/gating'
import { runIsDriven } from '../lib/ledger'
import { modeOf, taskRow, tierOf } from '../lib/phases'
import type { Run, Task } from '../lib/types'
import { sceneFor } from './scenes'

export interface BoardInput {
  run: Run
  holds: Record<string, PaneHold>
  livePanes: ReadonlySet<string>
  ctx: ReadonlyMap<string, number>
  /** Only consulted for tasks whose row's actor is the orchestrator; it runs status.ts's waitsOnYou. */
  orchestratorsMove: (task: Task) => boolean
  cleared: ReadonlySet<string>
}

const red = (text: string): Span => ({ text, color: MOCHA.red, bold: true })
const quiet = (text: string): Span => ({ text, color: MOCHA.overlay0 })
const CI: Partial<Record<string, Span>> = {
  pending: { text: 'ci ●', color: MOCHA.yellow },
  fail: { text: 'ci ✗', color: MOCHA.red },
  pass: { text: 'ci ✓', color: MOCHA.green },
}
const COLUMN_SCENE: Record<Exclude<Column, 'working'>, string> = { needs: 'blocked', done: 'done', idle: 'idle' }

/** What the human owes on this task: the hpipe:awaiting-human label's rules, plus failures and the holds only a human clears. */
export function humanOwes(run: Run, task: Task, holds: Record<string, PaneHold>): string | null {
  if (heldForTheHuman(run, task)) return owedAt(run, task)[0]?.check.check ?? 'a check before merge'
  if (task.phase === 'escalated') return 'escalated'
  const open = escalatedUnanswered(task)
  if (open) return `answer decision ${open.id}`
  if (TERMINAL_BAD.has(task.phase)) return task.phase
  const hold = task.pane_id === null ? undefined : holds[task.pane_id]
  if (hold?.code === 'stuck_input') return 'input box has text'
  if (hold?.code === 'usage_limit' && (hold.until ?? null) === null) return 'usage limit'
  return null
}

export function runOwes(run: Run, livePanes: ReadonlySet<string>): string | null {
  if (run.phase === 'escalated') return 'run escalated'
  const owed = modeOf(run) === 'single-pr' ? owedInRun(run)[0] : undefined
  if (owed) return owed.check.check
  if (runIsDriven(run) && (run.orchestrator_pane === null || !livePanes.has(run.orchestrator_pane))) return 'orchestrator is not running'
  return null
}

function placed(input: BoardInput, task: Task): { column: Column; badge: Span } {
  const { run, holds, livePanes } = input
  const owes = humanOwes(run, task, holds)
  if (owes) return { column: 'needs', badge: red(owes) }
  const progress = CI[task.ci ?? ''] ?? (task.pr !== null ? quiet(`PR #${task.pr}`) : null)
  if (task.phase === 'done') return { column: 'done', badge: progress ?? quiet(tierOf(task)) }
  const hold = task.pane_id === null ? undefined : holds[task.pane_id]
  if (hold?.code === 'usage_limit') return { column: 'idle', badge: quiet(hold.reset ?? 'usage limit') }
  const unmet = run.tasks.find((t) => task.depends_on.includes(t.task_id) && t.phase !== 'done')
  if (task.phase === 'queued') return { column: 'idle', badge: quiet(unmet ? `deps: ${unmet.bead}` : tierOf(task)) }
  if (task.phase === 'blocked-on-files') return { column: 'idle', badge: quiet(`files: ${fileHolders(run, task)[0]?.bead ?? 'held'}`) }
  const actor = taskRow(task.phase).actor
  if (actor === 'worker' && (task.pane_id === null || !livePanes.has(task.pane_id))) return { column: 'idle', badge: quiet('no agent') }
  const move = actor === 'orchestrator' && input.orchestratorsMove(task) ? quiet("orchestrator's move") : null
  return { column: 'working', badge: progress ?? move ?? quiet(tierOf(task)) }
}

export function buildBoard(input: BoardInput): Record<Column, CardView[]> {
  const board: Record<Column, CardView[]> = { needs: [], working: [], done: [], idle: [] }
  for (const task of input.run.tasks) {
    if (task.phase === 'done' && input.cleared.has(task.task_id)) continue
    const { column, badge } = placed(input, task)
    board[column].push({
      id: task.task_id,
      column,
      title: `${task.bead} ${task.brief.title}`,
      subtitle: task.phase,
      badge,
      since: task.phase_entered_at,
      ctx: task.pane_id === null ? null : input.ctx.get(task.pane_id) ?? null,
      scene: column === 'working' ? sceneFor(task) : COLUMN_SCENE[column],
      accessory: 'hardhat',
      enteredAt: column === 'done' || column === 'needs' ? task.phase_entered_at : null,
    })
  }
  for (const list of Object.values(board)) list.sort((a, b) => (b.since ?? 0) - (a.since ?? 0))
  const owes = runOwes(input.run, input.livePanes)
  if (owes) {
    board.needs.unshift({
      id: `run:${input.run.run_id}`, column: 'needs', title: input.run.title, subtitle: `run · ${input.run.phase}`,
      badge: red(owes), since: input.run.phase_entered_at, ctx: null, scene: 'blocked', accessory: 'hardhat', enteredAt: null,
    })
  }
  return board
}
