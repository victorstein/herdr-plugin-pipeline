import { join } from 'node:path'
import { homedir } from 'node:os'

export interface Config {
  TICK_MS: number
  WAKE_ON: string[]
  MAX_PASSES: number
  STALL_MINUTES: number
  TASK_STALL_MINUTES: number
  FILE_SETTLE_MS: number
  ACTOR_SETTLE_MS: number
  CI_POLL_SECONDS: number
  PROMPT_RETRY_MAX: number
  BLOCKED_TAIL_LINES: number
  REPOS_ALLOW: string[]
  PIPELINE_WORKSPACE_LABEL: string
  GH_BIN: string
  HPIPE_LINK: boolean
  HPIPE_LINK_PATH: string
}

const DEFAULTS: Config = {
  TICK_MS: 1000,
  WAKE_ON: ['blocked', 'done', 'idle', 'unknown', 'exited', 'released'],
  MAX_PASSES: 2,
  STALL_MINUTES: 15,
  TASK_STALL_MINUTES: 45,
  FILE_SETTLE_MS: 750,
  ACTOR_SETTLE_MS: 750,
  CI_POLL_SECONDS: 30,
  PROMPT_RETRY_MAX: 5,
  BLOCKED_TAIL_LINES: 8,
  REPOS_ALLOW: [],
  PIPELINE_WORKSPACE_LABEL: 'pipeline',
  GH_BIN: 'gh',
  HPIPE_LINK: true,
  HPIPE_LINK_PATH: join(homedir(), '.local', 'bin', 'hpipe'),
}

const NUMERIC = [
  'TICK_MS', 'MAX_PASSES', 'STALL_MINUTES', 'TASK_STALL_MINUTES',
  'FILE_SETTLE_MS', 'ACTOR_SETTLE_MS', 'CI_POLL_SECONDS',
  'PROMPT_RETRY_MAX', 'BLOCKED_TAIL_LINES',
] as const

const LISTS = ['WAKE_ON', 'REPOS_ALLOW'] as const

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

export async function loadConfig(configDir: string): Promise<Config> {
  const file = Bun.file(join(configDir, 'config.env'))
  if (!(await file.exists())) return { ...DEFAULTS }

  const raw = parseEnvFile(await file.text())
  const cfg: Config = { ...DEFAULTS }

  for (const key of NUMERIC) {
    const value = raw[key]
    if (value === undefined) continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) cfg[key] = parsed
  }

  for (const key of LISTS) {
    const value = raw[key]
    if (value === undefined) continue
    cfg[key] = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  }

  if (raw.PIPELINE_WORKSPACE_LABEL) cfg.PIPELINE_WORKSPACE_LABEL = raw.PIPELINE_WORKSPACE_LABEL
  if (raw.GH_BIN) cfg.GH_BIN = raw.GH_BIN
  if (raw.HPIPE_LINK_PATH) cfg.HPIPE_LINK_PATH = raw.HPIPE_LINK_PATH
  if (raw.HPIPE_LINK !== undefined) cfg.HPIPE_LINK = raw.HPIPE_LINK !== '0'

  return cfg
}
