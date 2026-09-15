import { statSync } from 'node:fs'
import type { Verdict } from './types'

export interface VerdictResult {
  verdict: Verdict
  blockers: number
  majors: number
}

export async function isFresh(path: string, phaseEnteredAt: number): Promise<boolean> {
  try {
    // `mtimeMs` carries sub-millisecond precision while `phase_entered_at` comes from
    // `Date.now()`, which truncates. Without flooring, a file written a fraction of a
    // millisecond BEFORE phase entry compares as greater and reads as fresh — a false
    // positive on exactly the stale artifact edge-triggering exists to reject.
    return Math.floor(statSync(path).mtimeMs) > phaseEnteredAt
  } catch {
    return false
  }
}

/**
 * Stability re-read. Guards against reading a file mid-write(2); it does NOT
 * prove the artifact is finished. The trailer-is-last-line rule in
 * parseVerdict is the real completeness signal for a review.
 */
export async function isSettled(path: string, settleMs: number): Promise<boolean> {
  try {
    const before = statSync(path)
    await Bun.sleep(settleMs)
    const after = statSync(path)
    return before.size === after.size && before.mtimeMs === after.mtimeMs
  } catch {
    return false
  }
}

// Anchored at column 0 on purpose. The review prompts DOCUMENT the trailer as
// an indented block, so trimming before matching made a quoted example
// byte-identical to a real verdict — a reviewer narrating the contract then
// produced a confident false CLEAR. A real trailer is never indented.
const VERDICT_LINE = /^VERDICT:[ \t]*(CLEAR|BLOCKER)[ \t]*$/
const COUNT_LINE = /^(BLOCKERS|MAJORS):[ \t]*(\d+)[ \t]*$/

export async function parseVerdict(path: string): Promise<VerdictResult | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  const lines = (await file.text())
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0)

  let verdictIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (VERDICT_LINE.test(lines[i] ?? '')) { verdictIndex = i; break }
  }
  if (verdictIndex === -1) return null

  // Only count lines may follow the trailer; anything else means the file is still being written.
  const counts = { blockers: 0, majors: 0 }
  for (const line of lines.slice(verdictIndex + 1)) {
    const matched = COUNT_LINE.exec(line)
    if (!matched) return null
    if (matched[1] === 'BLOCKERS') counts.blockers = Number(matched[2])
    else counts.majors = Number(matched[2])
  }

  const verdict = VERDICT_LINE.exec(lines[verdictIndex] ?? '')?.[1] as Verdict

  // CLEAR alongside blocker findings is self-contradictory — the contract pairs
  // counts with BLOCKER. (CLEAR with MAJORS is legal: majors are fixed inline.)
  if (verdict === 'CLEAR' && counts.blockers > 0) return null

  return { verdict, ...counts }
}
