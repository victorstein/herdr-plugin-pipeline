import type { BdFailure } from './bd'
import { beadsExportPath, beadsHome, beadsSpawnEnv } from './beads-project'
import type { TriageByTrack } from './next'
import { runBounded } from './spawn'
import { bvBin } from './tools'

export const BV_TIMEOUT_MS = 30_000

/** `--db <file>` keeps bv on hpipe's export and off Dolt; the two flags keep it off the network and the repo. */
export function bvSpawnEnv(stateDir: string, slug: string): Record<string, string | undefined> {
  return { ...beadsSpawnEnv(stateDir, slug), BV_NO_UPDATE_CHECK: '1', BV_NO_GITIGNORE: '1' }
}

export async function bvTriage(
  stateDir: string, slug: string, options: { bin?: string; timeoutMs?: number } = {},
): Promise<TriageByTrack | BdFailure> {
  const timeoutMs = options.timeoutMs ?? BV_TIMEOUT_MS
  const out = await runBounded(
    [options.bin ?? bvBin(), '--robot-triage-by-track', '--db', beadsExportPath(stateDir, slug)],
    { cwd: beadsHome(stateDir, slug), env: bvSpawnEnv(stateDir, slug), timeoutMs },
  )
  if (out.timedOut) return { reason: 'timeout', error: `bv was killed after ${timeoutMs / 1000}s` }
  if (out.code !== 0) return { reason: 'exit', error: out.stderr.trim() || `bv exited ${out.code}` }
  let parsed: { triage?: TriageByTrack } | null
  try {
    parsed = JSON.parse(out.stdout) as { triage?: TriageByTrack } | null
  } catch {
    parsed = null
  }
  return parsed?.triage ?? { reason: 'output', error: 'bv printed no triage JSON' }
}
