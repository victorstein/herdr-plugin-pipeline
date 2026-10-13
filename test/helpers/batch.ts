import type { Batch } from '../../src/lib/types'

/** A single-PR run's batch as `hpipe start --single-pr` records it, before any PR exists. */
export function batchFixture(over: Partial<Batch> = {}): Batch {
  return {
    branch: 'batch/x', into: 'main', base_commit: '1fb8a43c0000000000000000000000000000beef',
    checkout: '/state/checkouts/r1', pr: null, head_sha_at_entry: null, ci: null,
    merged_at_ms: null, merge_commit: null, ...over,
  }
}
