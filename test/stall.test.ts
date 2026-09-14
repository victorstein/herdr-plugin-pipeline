import { expect, test } from 'bun:test'
import { stallCandidates } from '../src/supervisor/stall'
import { newRun } from '../src/lib/ledger'
import type { Run, RunPhase } from '../src/lib/types'

function runAt(phase: RunPhase, enteredAt: number): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = phase
  run.phase_entered_at = enteredAt
  run.orchestrator_pane = 'w1:p1'
  return run
}

const NOW = 1_000_000
const LONG_AGO = NOW - 30 * 60 * 1000

test('an artifact phase open past the threshold is a candidate', () => {
  expect(stallCandidates([runAt('spec', LONG_AGO)], NOW, 15, new Set())).toHaveLength(1)
})

test('execute is NEVER a stall candidate — it has no artifact by design', () => {
  expect(stallCandidates([runAt('execute', LONG_AGO)], NOW, 15, new Set())).toHaveLength(0)
})

test('dispatch is not a candidate either', () => {
  expect(stallCandidates([runAt('dispatch', LONG_AGO)], NOW, 15, new Set())).toHaveLength(0)
})

test('a phase within the threshold is not a candidate', () => {
  expect(stallCandidates([runAt('spec', NOW - 60_000)], NOW, 15, new Set())).toHaveLength(0)
})

test('a phase already probed is not probed again', () => {
  const run = runAt('spec', LONG_AGO)
  const probed = new Set([`${run.run_id}:spec:${run.phase_entered_at}`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(0)
})

test('re-entering the same phase makes it probeable again', () => {
  const run = runAt('spec', LONG_AGO)
  const probed = new Set([`${run.run_id}:spec:12345`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(1)
})
