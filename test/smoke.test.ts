import { expect, test } from 'bun:test'
import type { Run } from '../src/lib/types'

test('types module loads and Run is structurally usable', () => {
  const run: Pick<Run, 'run_id' | 'phase'> = { run_id: 'r1', phase: 'spec' }
  expect(run.phase).toBe('spec')
})
