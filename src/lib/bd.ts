import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beadsExportPath, beadsHome, beadsSpawnEnv } from './beads-project'
import { processStartedAtMs } from './pidfile'
import { type Bounded, runBounded } from './spawn'
import { readJson, removeJsonIf, writeJsonExclusive } from './store'
import { bdBin } from './tools'

/** bd 1.3.1 refuses a close by anyone but the assignee, so the claim and the close must share one actor. */
export const BD_ACTOR = 'hpipe'
export const CLI_LOCK_WAIT_MS = 10_000
export const BD_TIMEOUT_MS = 30_000
const LOCK_POLL_MS = 50
// `ps` reports whole seconds, as for the supervisor's pid file.
const START_TIME_SLOP_MS = 1_000

export type BdFailureReason = 'exit' | 'timeout' | 'busy' | 'output' | 'unavailable'

export interface BdFailure {
  reason: BdFailureReason
  error: string
}

export interface Done {
  ok: true
}

export interface CreatedBead {
  id: string
}

export interface BeadComment {
  text: string
  author?: string
}

export interface BeadEdge {
  depends_on_id: string
  type: string
}

/** One line of `bd export`: a bead with its labels, dependencies and comments. */
export interface ExportedBead {
  id: string
  title: string
  description?: string
  acceptance_criteria?: string
  status: string
  assignee?: string
  labels?: string[]
  dependencies?: BeadEdge[]
  comments?: BeadComment[]
}

export interface LinkedBead {
  id: string
  title: string
  status: string
  dependency_type: string
}

/** One entry of `bd show --json --include-comments --include-dependents`. */
export interface BeadDetail {
  id: string
  title: string
  description?: string
  acceptance_criteria?: string
  status: string
  assignee?: string
  labels?: string[]
  dependencies?: LinkedBead[]
  dependents?: LinkedBead[]
  comments?: BeadComment[]
}

export interface BeadCreateInput {
  title: string
  body: string
  acceptance?: string
  labels: string[]
  depsDiscoveredFrom?: string
}

export interface BeadUpdate {
  status?: string
  assignee?: string
  addLabels?: string[]
  removeLabels?: string[]
}

export interface BdOptions {
  stateDir: string
  slug: string
  /** 0 is a try-lock: the supervisor's. The CLI waits `CLI_LOCK_WAIT_MS`. */
  lockWaitMs: number
  /** False for the reconciler, which exports once at the end of its pass. */
  exportAfterWrites?: boolean
  timeoutMs?: number
  bin?: string
}

interface LockHolder {
  pid: number
  started_at_ms: number
  token: string
}

const DONE: Done = { ok: true }

export function isBdFailure(value: unknown): value is BdFailure {
  return typeof value === 'object' && value !== null && 'reason' in value && 'error' in value
}

let ownStartTime: Promise<number> | null = null
const ownStartedAtMs = (): Promise<number> =>
  (ownStartTime ??= processStartedAtMs(process.pid).then((at) => at ?? Date.now()))

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

function jsonError(text: string): string | null {
  const parsed = parseJson<{ error?: unknown; data?: { error?: unknown } }>(text)
  if (typeof parsed?.error === 'string') return parsed.error
  if (typeof parsed?.data?.error === 'string') return parsed.data.error
  return null
}

/**
 * bd 1.3.1 warns on stderr even when it succeeds outside git: a three-line
 * `beads.role` block (every line names `beads.role`) and, on init, the
 * repository-ID line. Its refusals are plain text on stderr after them.
 */
const isBenignWarning = (line: string): boolean =>
  line.includes('beads.role') || line.startsWith('Warning: could not compute repository ID')

function failureText(out: Bounded): string {
  const stderr = out.stderr.split('\n')
    .filter((line) => line.trim() !== '' && !isBenignWarning(line))
    .join('\n').trim()
  return jsonError(out.stdout) ?? jsonError(stderr) ?? (stderr || out.stdout.trim() || `bd exited ${out.code}`)
}

const isHolder = (token: string) => (current: unknown): boolean =>
  (current as Partial<LockHolder> | null)?.token === token

/**
 * The only code that spawns `bd`. Each call takes `hpipe.lock` for itself (and its
 * export) and never for a batch, so a waiter waits at most one call. The lock
 * exists so hpipe processes queue instead of tripping bd's own fail-fast Dolt
 * lock; bd's kernel lock still stops a second writer while an orphaned child lives.
 */
export class Bd {
  readonly #options: BdOptions
  readonly #home: string
  readonly #exportPath: string
  readonly #lockPath: string
  readonly #dirtyPath: string
  readonly #exportAfterWrites: boolean

  constructor(options: BdOptions) {
    this.#options = options
    this.#home = beadsHome(options.stateDir, options.slug)
    this.#exportPath = beadsExportPath(options.stateDir, options.slug)
    this.#lockPath = join(this.#home, 'hpipe.lock')
    this.#dirtyPath = join(this.#home, 'export.dirty')
    this.#exportAfterWrites = options.exportAfterWrites ?? true
  }

  async initStore(prefix: string): Promise<Done | BdFailure> {
    return this.#hold(async () => {
      for (const args of [
        ['init', '--prefix', prefix, '--skip-agents', '--skip-hooks', '--non-interactive'],
        ['config', 'set', 'issue_id_mode', 'counter'],
      ]) {
        const out = await this.#call(args)
        if (isBdFailure(out)) return out
      }
      return this.#export()
    })
  }

  async create(input: BeadCreateInput): Promise<CreatedBead | BdFailure> {
    return this.#withTempFile(input.body, (bodyFile) => this.#write([
      'create', '--title', input.title, '--body-file', bodyFile,
      ...(input.acceptance === undefined ? [] : ['--acceptance', input.acceptance]),
      ...input.labels.flatMap((label) => ['-l', label]),
      ...(input.depsDiscoveredFrom === undefined ? [] : ['--deps', `discovered-from:${input.depsDiscoveredFrom}`]),
    ], (stdout) => {
      const created = parseJson<{ id?: unknown }>(stdout)
      return typeof created?.id === 'string' ? { id: created.id } : null
    }))
  }

  async show(id: string): Promise<BeadDetail | BdFailure> {
    return this.#hold(async () => {
      const out = await this.#call(['show', id, '--include-comments', '--include-dependents'])
      if (isBdFailure(out)) return out
      const shown = parseJson<BeadDetail[]>(out)
      const bead = Array.isArray(shown) ? shown[0] : undefined
      return bead === undefined ? { reason: 'output', error: `bd show ${id} printed no bead` } : bead
    })
  }

  async claim(id: string): Promise<Done | BdFailure> {
    return this.#write(['update', id, '--claim'], () => DONE)
  }

  async update(id: string, change: BeadUpdate): Promise<Done | BdFailure> {
    const args = [
      ...(change.status === undefined ? [] : ['-s', change.status]),
      ...(change.assignee === undefined ? [] : ['--assignee', change.assignee]),
      ...(change.addLabels ?? []).flatMap((label) => ['--add-label', label]),
      ...(change.removeLabels ?? []).flatMap((label) => ['--remove-label', label]),
    ]
    if (args.length === 0) return DONE
    return this.#write(['update', id, ...args], () => DONE)
  }

  async reopen(id: string): Promise<Done | BdFailure> {
    return this.#write(['reopen', id], () => DONE)
  }

  async comment(id: string, text: string): Promise<Done | BdFailure> {
    return this.#withTempFile(text, (file) => this.#write(['comment', id, '--file', file], () => DONE))
  }

  async depAdd(from: string, to: string): Promise<Done | BdFailure> {
    return this.#write(['dep', 'add', from, to, '--type', 'blocks'], () => DONE)
  }

  async close(id: string, reason: string, options: { force: boolean }): Promise<Done | BdFailure> {
    return this.#withTempFile(reason, (reasonFile) => this.#write(
      ['close', id, '--reason-file', reasonFile, ...(options.force ? ['--force'] : [])], () => DONE,
    ))
  }

  async exportNow(): Promise<Done | BdFailure> {
    return this.#hold(() => this.#export())
  }

  async refreshExport(): Promise<Done | BdFailure> {
    return this.#hold(async () => (existsSync(this.#dirtyPath) ? this.#export() : DONE))
  }

  /** No spawn and no lock: the export is written atomically by bd. */
  readExport(): ExportedBead[] {
    let text: string
    try {
      text = readFileSync(this.#exportPath, 'utf8')
    } catch {
      return []
    }
    const beads: ExportedBead[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      const record = parseJson<ExportedBead & { _type?: string }>(line)
      if (record === null || typeof record.id !== 'string') continue
      if (record._type !== undefined && record._type !== 'issue') continue
      beads.push(record)
    }
    return beads
  }

  async #hold<T>(work: () => Promise<T | BdFailure>): Promise<T | BdFailure> {
    const token = await this.#acquire()
    if (token === null) return { reason: 'busy', error: 'Beads is busy, retry' }
    try {
      if (this.#exportAfterWrites && existsSync(this.#dirtyPath)) await this.#export()
      return await work()
    } finally {
      removeJsonIf(this.#lockPath, isHolder(token))
    }
  }

  async #write<T>(args: string[], parse: (stdout: string) => T | null): Promise<T | BdFailure> {
    return this.#hold(async () => {
      const out = await this.#call(args)
      if (isBdFailure(out)) return out
      if (this.#exportAfterWrites) await this.#export()
      else this.#markDirty()
      return parse(out) ?? { reason: 'output', error: `bd ${args[0]} printed no usable JSON: ${out.trim().slice(0, 200)}` }
    })
  }

  async #call(args: string[]): Promise<string | BdFailure> {
    const timeoutMs = this.#options.timeoutMs ?? BD_TIMEOUT_MS
    const out = await runBounded([this.#options.bin ?? bdBin(), '--json', '--actor', BD_ACTOR, ...args], {
      cwd: this.#home, env: beadsSpawnEnv(this.#options.stateDir, this.#options.slug), timeoutMs,
    })
    if (out.timedOut) return { reason: 'timeout', error: `bd ${args[0]} was killed after ${timeoutMs / 1000}s` }
    if (out.code !== 0) return { reason: 'exit', error: failureText(out) }
    return out.stdout
  }

  async #export(): Promise<Done | BdFailure> {
    const out = await this.#call(['export', '-o', this.#exportPath])
    if (isBdFailure(out)) {
      this.#markDirty()
      return out
    }
    rmSync(this.#dirtyPath, { force: true })
    return DONE
  }

  #markDirty(): void {
    writeFileSync(this.#dirtyPath, `${Date.now()}\n`)
  }

  async #withTempFile<T>(text: string, use: (path: string) => Promise<T>): Promise<T> {
    mkdirSync(this.#home, { recursive: true })
    const path = join(this.#home, `.hpipe-${randomUUID()}.md`)
    writeFileSync(path, text)
    try {
      return await use(path)
    } finally {
      rmSync(path, { force: true })
    }
  }

  async #acquire(): Promise<string | null> {
    mkdirSync(this.#home, { recursive: true })
    const deadline = Date.now() + this.#options.lockWaitMs
    for (;;) {
      const token = randomUUID()
      const holder: LockHolder = { pid: process.pid, started_at_ms: await ownStartedAtMs(), token }
      if (await writeJsonExclusive(this.#lockPath, holder)) return token
      if (await this.#reclaimFromDeadHolder()) continue
      if (Date.now() >= deadline) return null
      await Bun.sleep(LOCK_POLL_MS)
    }
  }

  /** True when the lock may be retried at once: its holder was dead, or it was let go meanwhile. */
  async #reclaimFromDeadHolder(): Promise<boolean> {
    const holder = await readJson<LockHolder>(this.#lockPath)
    if (holder === null) {
      removeJsonIf(this.#lockPath, (current) => current === null)
      return true
    }
    const startedAt = await processStartedAtMs(holder.pid)
    const alive = startedAt !== null && Math.abs(startedAt - holder.started_at_ms) <= START_TIME_SLOP_MS
    if (alive) return false
    removeJsonIf(this.#lockPath, isHolder(holder.token))
    return true
  }
}
