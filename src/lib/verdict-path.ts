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
