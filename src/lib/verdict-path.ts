import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Run, RunArtifacts, Task } from './types'

export const REVIEWS_DIR = 'docs/superpowers/reviews'

/** The ONE place a verdict filename is spelled. Always repo-relative. */
export function verdictFilename(prefix: string, phase: string, ordinal: number): string {
  return join(REVIEWS_DIR, `${prefix}-${phase}-${ordinal}.md`)
}

/** The ONE place the prefix is chosen, so a reserver and a reader cannot spell it differently. */
export function verdictPrefix(run: Run, task: Task | null): string {
  return task ? `issue-${task.issue}` : run.run_id
}

/**
 * The ONE base any repo-relative artifact path resolves against — verdicts, but
 * also the research/spec/plan slots, which is why it is not named for verdicts.
 * A task's artifacts live in its linked worktree; a run's in the main checkout.
 */
export function artifactBase(run: Run, task: Task | null): string {
  return task?.checkout_path ?? run.repo_root
}

/** Structural, so one implementation serves both records — as `HasPasses` does. */
interface VerdictRecord {
  artifacts: RunArtifacts
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

// The walk runs inside the supervisor tick, so it is bounded rather than trusting
// the reviews directory to be sane.
const PROBE_LIMIT = 64

/**
 * How a caller hears that the reviews directory is pathological. Defaults to a
 * no-op because `src/lib/` is the pure core and owns no log: the supervisor
 * prefixes the tick's, and a one-shot `hpipe rewind` says what it did through its
 * own result text instead.
 */
export type ReserveWarn = (message: string) => void

/**
 * Allocates the path for one commissioned review: chooses a filename once, records
 * it under the next key, and never revisits it.
 *
 * The key comes from `verdict_seq` and the filename from this walk, and they are
 * allowed to differ. That separation is load-bearing: a name freed on disk — the
 * `git mv` preservation this repo has applied four times — can change what a later
 * reservation picks and can never change what an already-issued key resolves to.
 *
 * NOT idempotent. A second call for one commission burns a key and a filename, so
 * the call sites are the discipline: the two prompt renders and `cmdRewind`.
 */
export function reserveVerdict(
  run: Run, task: Task | null, phase: string, warn: ReserveWarn = () => {},
): string {
  const record: VerdictRecord = task ?? run
  const prefix = verdictPrefix(run, task)
  const base = artifactBase(run, task)
  const seq = record.verdict_seq?.[phase] ?? 0
  const held = new Set(Object.values(record.artifacts.verdicts))

  let chosen = ''
  for (let ordinal = seq; ordinal < seq + PROBE_LIMIT; ordinal++) {
    const candidate = verdictFilename(prefix, phase, ordinal)
    if (held.has(candidate) || existsSync(join(base, candidate))) continue
    chosen = candidate
    break
  }

  if (chosen === '') {
    // The floor, not ordinal 0: the recorded key and the rendered prompt must agree
    // even when every candidate is taken, or the supervisor watches a file no agent
    // was told to write.
    chosen = verdictFilename(prefix, phase, seq)
    warn(
      `${prefix}: ${PROBE_LIMIT} verdict paths from ${phase}-${seq} are taken — ` +
      `falling back to ${chosen}, which may already hold a review`,
    )
  }

  record.artifacts.verdicts[verdictKey(phase, seq)] = chosen
  if (!record.verdict_seq) record.verdict_seq = {}
  record.verdict_seq[phase] = seq + 1
  return chosen
}
