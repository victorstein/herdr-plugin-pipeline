import type { BeadBrief, BeadSync, Discovery } from '../../src/lib/types'

/**
 * The fields every v3 task carries beyond the ones a fixture is about. A function,
 * not a constant: the reconciler and `discover` mutate them in place, and a shared
 * object would leak one test's writes into the next.
 */
export function beadTaskFields(): {
  brief: BeadBrief; bead_closed_at_ms: number | null; bead_sync: BeadSync; discoveries: Discovery[]
} {
  return {
    brief: {
      title: 'Relabel the tile', description: 'The settings tile says Foo; it should say Bar.',
      acceptance: 'The tile reads Bar.', labels: [], captured_at_ms: 0,
    },
    bead_closed_at_ms: null,
    bead_sync: { failures: 0, streak: 0, last_error: null, last_ok_at_ms: null },
    discoveries: [],
  }
}
