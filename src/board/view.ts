import { COLUMNS, type Column } from '../kit/nav'
import { MOCHA } from '../kit/palette'
import type { CardView, Span } from '../kit/render'
import { landingQueue, landingSlotHolder } from '../lib/gating'
import { runIsDriven } from '../lib/ledger'
import { modeName, modeOf } from '../lib/phases'
import type { Run } from '../lib/types'

// the status line cuts the keys from the right, so the stage keys come right after move
export const KEYS = 'hjkl move  enter stage  tab focus  z zoom  space peek  o orch  d details  x clear'
export const TITLES: Partial<Record<Column, string>> = { idle: '○ Idle/queued' }
const CI_GLYPH: Partial<Record<string, string>> = { pending: '●', fail: '✗', pass: '✓' }

// the kit drops later spans first when the header runs out of room, so a dead orchestrator goes early
export function header(run: Run | null, orchestratorLive: boolean): Span[] {
  if (!run) return [{ text: 'no run in this repo', color: MOCHA.overlay1 }]
  const spans: Span[] = [{ text: run.title, color: MOCHA.lavender, bold: true }]
  const driven = runIsDriven(run)
  if (driven && !orchestratorLive) spans.push({ text: 'orchestrator gone', color: MOCHA.red, bold: true })
  spans.push({ text: run.phase, color: MOCHA.blue }, { text: modeName(modeOf(run)), color: MOCHA.overlay1 })
  if (run.batch?.pr) spans.push({ text: `PR #${run.batch.pr}${run.batch.ci && CI_GLYPH[run.batch.ci] ? ` ci ${CI_GLYPH[run.batch.ci]}` : ''}`, color: MOCHA.overlay1 })
  const holder = landingSlotHolder(run.tasks)
  if (holder) {
    const waiting = landingQueue(run.tasks).length
    spans.push({ text: `landing ${holder.bead}${waiting ? ` +${waiting}` : ''}`, color: MOCHA.peach })
  }
  if (driven && orchestratorLive) spans.push({ text: 'orchestrator ✓', color: MOCHA.green })
  return spans
}

export function summary(board: Record<Column, CardView[]>): string {
  const tasks = COLUMNS.flatMap((c) => board[c]).filter((c) => !c.id.startsWith('run:')).length
  const needs = board.needs.filter((c) => !c.id.startsWith('run:')).length
  return `${tasks} tasks · ${needs} need you · ${board.working.length} working · ${board.done.length} done`
}
