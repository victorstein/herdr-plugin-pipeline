import { expect, test } from 'bun:test'
import { header, KEYS, summary, TITLES } from '../src/board/view'
import { MOCHA } from '../src/kit/palette'
import type { CardView } from '../src/kit/render'
import { heldTask, perTaskRun, singlePrRun } from './helpers/before-merge'

const perTask = () => {
  const run = perTaskRun([
    heldTask({ task_id: 't1', bead: 'hp-7', phase: 'merge' }),
    heldTask({ task_id: 't2', bead: 'hp-8', phase: 'land-queue' }),
  ])
  run.title = 'rsvp export'
  return run
}

test('the header names the run, its phase and mode, then the batch PR and the landing slot', () => {
  expect(header(perTask(), true).map((s) => s.text)).toEqual([
    'rsvp export', 'execute', 'per-task', 'landing hp-7 +1', 'orchestrator ✓',
  ])
})

test('a gone orchestrator is the second span, so a narrow header keeps it', () => {
  expect(header(perTask(), false)[1]).toEqual({ text: 'orchestrator gone', color: MOCHA.red, bold: true })
})

test('a single-PR run shows its batch PR and CI', () => {
  const run = singlePrRun([heldTask({ phase: 'implement' })], 'execute')
  run.batch = { ...run.batch!, pr: 12, ci: 'pending' }
  const texts = header(run, true).map((s) => s.text)
  expect(texts).toContain('single-PR')
  expect(texts).toContain('PR #12 ci ●')
})

test('a run no longer driven claims no orchestrator either way', () => {
  const run = perTask()
  run.phase = 'done'
  for (const live of [true, false]) {
    const texts = header(run, live).map((s) => s.text)
    expect(texts).not.toContain('orchestrator ✓')
    expect(texts).not.toContain('orchestrator gone')
  }
})

test('no run says so', () => {
  expect(header(null, true).map((s) => s.text)).toEqual(['no run in this repo'])
})

test('the summary counts cards per column; titles rename Idle; keys list only plan-3 keys', () => {
  const card = (id: string, column: CardView['column']) => ({ id, column }) as CardView
  const board = {
    needs: [card('run:r1', 'needs'), card('t1', 'needs')],
    working: [card('t2', 'working'), card('t3', 'working')],
    done: [card('t4', 'done')],
    idle: [card('t5', 'idle')],
  }
  expect(summary(board)).toBe('5 tasks · 1 need you · 2 working · 1 done')
  expect(TITLES).toEqual({ idle: '○ Idle/queued' })
  expect(KEYS).toBe('←↓↑→/hjkl move  space peek  o orchestrator  d details  x clear')
})
