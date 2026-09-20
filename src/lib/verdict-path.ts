import { join } from 'node:path'
import type { Run, Task } from './types'

export const REVIEWS_DIR = 'docs/superpowers/reviews'

/** The ONE place a verdict filename is spelled. Always repo-relative. */
export function verdictFilename(prefix: string, phase: string, ordinal: number): string {
  return join(REVIEWS_DIR, `${prefix}-${phase}-${ordinal}.md`)
}

/** The ONE place the prefix is chosen, so a reserver and a reader cannot spell it differently. */
export function verdictPrefix(run: Run, task: Task | null): string {
  return task ? `issue-${task.issue}` : run.run_id
}

/** The ONE base a repo-relative verdict path resolves against. */
export function verdictBase(run: Run, task: Task | null): string {
  return task?.checkout_path ?? run.repo_root
}

/**
 * Structural, so one implementation serves both records — the same reason
 * `HasPasses` exists in `machine.ts:5`.
 */
interface VerdictRecord {
  artifacts: { verdicts: Record<string, string> }
  verdict_seq?: Record<string, number | undefined>
}

function verdictKey(phase: string, seq: number): string {
  return `${phase}-${seq}`
}

/**
 * THE read: one dictionary lookup. A reader that chooses between candidates is a
 * reader that can disagree with the reserver, which is the divergence #26's third
 * review caught — the prompt naming one file while the supervisor watched another.
 */
export function verdictFor(record: VerdictRecord, phase: string): string | null {
  const seq = record.verdict_seq?.[phase] ?? 0
  if (seq === 0) return null
  return record.artifacts.verdicts[verdictKey(phase, seq - 1)] ?? null
}
