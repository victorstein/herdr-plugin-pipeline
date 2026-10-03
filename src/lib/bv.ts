import type { BdFailure } from './bd'
import { beadsExportPath, beadsHome, beadsSpawnEnv } from './beads-project'
import type { TriageOutput } from './next'
import { runBounded } from './spawn'
import { bvBin } from './tools'

export const BV_TIMEOUT_MS = 30_000

/** `--db <file>` keeps bv on hpipe's export and off Dolt; the two flags keep it off the network and the repo. */
export function bvSpawnEnv(stateDir: string, slug: string): Record<string, string | undefined> {
  return { ...beadsSpawnEnv(stateDir, slug), BV_NO_UPDATE_CHECK: '1', BV_NO_GITIGNORE: '1' }
}

const STDOUT_EXCERPT_CHARS = 200

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/** bv reports a failed load as a JSON envelope on stdout (`writeRobotLoadFailure`), not on stderr. */
function loadFailure(stdout: string): string {
  const reported = parseJson<{ error?: unknown }>(stdout)?.error
  return typeof reported === 'string' ? reported : stdout.trim().slice(0, STDOUT_EXCERPT_CHARS)
}

export async function bvTriage(
  stateDir: string, slug: string, options: { bin?: string; timeoutMs?: number } = {},
): Promise<TriageOutput | BdFailure> {
  const timeoutMs = options.timeoutMs ?? BV_TIMEOUT_MS
  const out = await runBounded(
    [options.bin ?? bvBin(), '--robot-triage-by-track', '--db', beadsExportPath(stateDir, slug)],
    { cwd: beadsHome(stateDir, slug), env: bvSpawnEnv(stateDir, slug), timeoutMs },
  )
  if (out.timedOut) return { reason: 'timeout', error: `bv was killed after ${timeoutMs / 1000}s` }
  if (out.code !== 0) return { reason: 'exit', error: out.stderr.trim() || loadFailure(out.stdout) || `bv exited ${out.code}` }
  const parsed = parseJson<Partial<TriageOutput>>(out.stdout)
  const triage = parsed?.triage
  if (triage === undefined || triage === null) return { reason: 'output', error: 'bv printed no triage JSON' }
  return { triage, source_authority: parsed?.source_authority ?? null }
}
