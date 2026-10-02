import { runBounded } from './spawn'

export const BD_MIN_VERSION = '1.3.1'
export const BV_MIN_VERSION = '0.25.2'
export const BD_INSTALL_HINT = 'brew install beads'
export const BV_INSTALL_HINT = 'brew install dicklesworthstone/tap/bv'
const VERSION_CHECK_TIMEOUT_MS = 10_000

/** Not config keys: the CLI loads no config, and two processes reading different bins would let two bd versions write one store. */
export const bdBin = (): string => process.env.BD_BIN ?? 'bd'
export const bvBin = (): string => process.env.BV_BIN ?? 'bv'

export type ToolCheck =
  | { state: 'ok'; version: string }
  | { state: 'old'; version: string }
  | { state: 'missing'; detail: string }

export interface Tools {
  bd: ToolCheck
  bv: ToolCheck
}

export function parseVersion(text: string): string | null {
  return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null
}

export function atLeast(version: string, minimum: string): boolean {
  const have = version.split('.').map(Number)
  const need = minimum.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const difference = (have[i] ?? 0) - (need[i] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return true
}

export async function checkTool(argv: string[], minimum: string): Promise<ToolCheck> {
  const out = await runBounded(argv, { timeoutMs: VERSION_CHECK_TIMEOUT_MS })
  const version = out.code === 0 ? parseVersion(out.stdout) : null
  if (version === null) {
    const detail = (out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`).split('\n')[0] ?? ''
    return { state: 'missing', detail }
  }
  return atLeast(version, minimum) ? { state: 'ok', version } : { state: 'old', version }
}

export const checkBd = (): Promise<ToolCheck> => checkTool([bdBin(), 'version'], BD_MIN_VERSION)
export const checkBv = (): Promise<ToolCheck> => checkTool([bvBin(), '--version'], BV_MIN_VERSION)

export async function checkTools(): Promise<Tools> {
  const [bd, bv] = await Promise.all([checkBd(), checkBv()])
  return { bd, bv }
}

export function bdProblem(check: ToolCheck): string | null {
  switch (check.state) {
    case 'ok': return null
    case 'old': return `bd ${check.version} is older than ${BD_MIN_VERSION}, whose close guards this pipeline relies on — brew upgrade beads`
    case 'missing': return `bd did not run (${check.detail}) — ${BD_INSTALL_HINT}`
  }
}

export function bvProblem(check: ToolCheck): string | null {
  switch (check.state) {
    case 'ok': return null
    case 'old': return `bv ${check.version} is older than ${BV_MIN_VERSION} — brew upgrade bv`
    case 'missing': return `bv did not run (${check.detail}) — ${BV_INSTALL_HINT}`
  }
}

export function toolsLine(tools: Tools): string | null {
  const problems = [bdProblem(tools.bd), bvProblem(tools.bv)].filter((p): p is string => p !== null)
  return problems.length === 0 ? null : `tools: ${problems.join('; ')}`
}
