import { expect, test } from 'bun:test'
import { RUN_ROWS, runRow } from '../src/lib/phases'

test('every run phase has exactly one row', () => {
  const seen = new Set(RUN_ROWS.map((r) => r.phase))
  expect(seen.size).toBe(RUN_ROWS.length)
})

test('runRow returns the row for a phase', () => {
  expect(runRow('branch-review').actor).toBe('orchestrator')
  expect(runRow('branch-review').counter).toBe('branch-review')
})

test('intake is an orchestrator row with no counter', () => {
  expect(runRow('intake').actor).toBe('orchestrator')
  expect(runRow('intake').counter).toBeUndefined()
})
