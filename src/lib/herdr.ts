import { runBounded } from './spawn'
import type { AgentStatus } from './types'

export interface CallResult<T> {
  ok: boolean
  code?: string
  message?: string
  result?: T
}

export interface PaneInfo {
  pane_id: string
  workspace_id?: string
  agent_status?: AgentStatus
  /** The agent herdr detected in the pane; `null` once none is running there. */
  agent?: string | null
  label?: string
  terminal_id?: string
}

/**
 * A pane that is still listed but has no agent in it. An orchestrator whose
 * Claude was `/exit`ed leaves exactly this: `agent: null`, `agent_status:
 * unknown`. Measured on a live run.
 */
export function paneHasNoAgent(pane: PaneInfo): boolean {
  return (pane.agent === null || pane.agent === undefined) &&
    (pane.agent_status === undefined || pane.agent_status === 'unknown')
}

/**
 * Whether a pane holds a live agent, by one pane list. A pane missing from the
 * list has none. An empty list reads as every pane having one: `paneList` returns
 * it for a failed call too, and reading that as "no agent anywhere" would lift the
 * orchestrator's mid-turn gate on a herdr hiccup.
 */
export function liveAgentIn(listed: readonly PaneInfo[]): (paneId: string) => boolean {
  if (listed.length === 0) return () => true
  const withAgent = new Set(listed.filter((pane) => !paneHasNoAgent(pane)).map((pane) => pane.pane_id))
  return (paneId) => withAgent.has(paneId)
}

export interface WorkspaceInfo {
  workspace_id: string
  label: string
  worktree?: { repo_key: string; repo_root: string; is_linked_worktree: boolean } | null
}

/** A checkout `herdr worktree list` names. With no workspace id, it confirms a checkout, never its workspace. */
export interface WorktreeEntry {
  path: string
  /** The short branch name; null for a detached or bare checkout. */
  branch: string | null
  is_linked_worktree: boolean
  is_prunable: boolean
}

/** A list that may not have been read. Unlike `paneList`, a failed call is never an empty list. */
export type Listing<T> = { ok: true; items: T[] } | { ok: false; reason: string }

export interface CreatedWorktree { workspaceId: string; paneId: string; path: string }

export interface AgentStartRequest {
  name: string
  kind: string
  paneId: string
  /** herdr's own wait for the agent to be ready, in milliseconds. */
  timeoutMs: number
  args: string[]
}

interface Envelope<T> {
  result?: T
  error?: { code: string; message: string }
}

function parseEnvelope<T>(text: string): Envelope<T> | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as Envelope<T> : null
  } catch {
    return null
  }
}

// herdr 0.9.0 writes a failure's envelope to stderr, exits 1 and leaves stdout
// empty; reading stdout alone turned every error code into `unparseable`.
// Measured on a live run.
function envelopeResult<T>(stdout: string, stderr: string): CallResult<T> {
  const parsed = parseEnvelope<T>(stdout) ?? parseEnvelope<T>(stderr)
  if (parsed === null) {
    return { ok: false, code: 'unparseable', message: (stdout || stderr).slice(0, 200) }
  }
  // herdr reports some failures in the body while exiting 0.
  if (parsed.error) return { ok: false, code: parsed.error.code, message: parsed.error.message }
  return { ok: true, result: parsed.result }
}

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const stringAt = (value: unknown, key: string): string | undefined =>
  isObject(value) && typeof value[key] === 'string' && value[key] !== '' ? value[key] as string : undefined

function failedListing(res: CallResult<unknown>): { ok: false; reason: string } {
  return { ok: false, reason: `${res.code ?? 'error'}${res.message ? ` — ${res.message}` : ''}` }
}

const UNREAD_SHAPE = 'herdr answered in a shape this plugin does not read'

/**
 * Every entry or none: a dispatch that acts on a list with one entry it could not
 * read would act on a guess, and it creates worktrees and starts agents.
 */
function listingOf<T>(res: CallResult<unknown>, key: string, entry: (raw: unknown) => T | null): Listing<T> {
  if (!res.ok) return failedListing(res)
  const raw = isObject(res.result) ? res.result[key] : undefined
  if (!Array.isArray(raw)) return { ok: false, reason: UNREAD_SHAPE }
  const items: T[] = []
  for (const item of raw) {
    const read = entry(item)
    if (read === null) return { ok: false, reason: UNREAD_SHAPE }
    items.push(read)
  }
  return { ok: true, items }
}

function worktreeEntry(raw: unknown): WorktreeEntry | null {
  if (!isObject(raw)) return null
  const { path, branch, is_linked_worktree: linked, is_prunable: prunable } = raw
  if (typeof path !== 'string' || path === '') return null
  if (typeof linked !== 'boolean' || typeof prunable !== 'boolean') return null
  if (branch !== null && branch !== undefined && typeof branch !== 'string') return null
  const short = typeof branch === 'string' && branch !== '' ? branch.replace(/^refs\/heads\//, '') : null
  return { path, branch: short, is_linked_worktree: linked, is_prunable: prunable }
}

function workspaceEntry(raw: unknown): WorkspaceInfo | null {
  if (stringAt(raw, 'workspace_id') === undefined) return null
  const worktree = (raw as Json).worktree
  if (worktree !== null && worktree !== undefined && !isObject(worktree)) return null
  return raw as unknown as WorkspaceInfo
}

const paneEntry = (raw: unknown): PaneInfo | null =>
  stringAt(raw, 'pane_id') === undefined ? null : raw as unknown as PaneInfo

/**
 * The fields the plugin names are `.result.worktree.path` and
 * `.result.root_pane.pane_id`; the workspace is read from `.result.workspace`,
 * the shape `workspace create` answers with, or from the root pane. Two that
 * disagree, or none, is unreadable: the pane guard compares against these.
 */
function createdWorktree(result: unknown): CreatedWorktree | string {
  const path = stringAt(isObject(result) ? result.worktree : undefined, 'path')
  const rootPane = isObject(result) ? result.root_pane : undefined
  const paneId = stringAt(rootPane, 'pane_id')
  const fromWorkspace = stringAt(isObject(result) ? result.workspace : undefined, 'workspace_id')
  const fromPane = stringAt(rootPane, 'workspace_id')
  if (path === undefined) return 'no .result.worktree.path'
  if (paneId === undefined) return 'no .result.root_pane.pane_id'
  if (fromWorkspace !== undefined && fromPane !== undefined && fromWorkspace !== fromPane) {
    return `the workspace ${fromWorkspace} and a root pane in ${fromPane}`
  }
  const workspaceId = fromWorkspace ?? fromPane
  if (workspaceId === undefined) return 'no workspace id'
  return { workspaceId, paneId, path }
}

export interface PaneOpenOptions {
  cwd?: string
  env?: Record<string, string>
}

/** herdr 0.9.1 returns the new pane, id included; measured in the beads spikes. */
export interface PluginPaneOpened {
  plugin_pane?: { pane?: { pane_id?: string } }
}

export class Herdr {
  constructor(private readonly bin: string = process.env.HERDR_BIN_PATH ?? 'herdr') {}

  private async spawn(
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number } | { error: unknown }> {
    // Bun.spawn throws synchronously on a missing binary. Callers rely on these
    // methods never throwing, so a bad HERDR_BIN_PATH must degrade to a failed
    // CallResult rather than crash the supervisor loop.
    try {
      const proc = Bun.spawn([this.bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ])
      return { stdout, stderr, exitCode: await proc.exited }
    } catch (error) {
      return { error }
    }
  }

  private async call<T>(args: string[]): Promise<CallResult<T>> {
    const output = await this.spawn(args)
    if ('error' in output) return { ok: false, code: 'spawn_failed', message: String(output.error) }
    return envelopeResult<T>(output.stdout, output.stderr)
  }

  async paneList(workspaceId?: string): Promise<PaneInfo[]> {
    const args = ['pane', 'list']
    if (workspaceId) args.push('--workspace', workspaceId)
    const res = await this.call<{ panes: PaneInfo[] }>(args)
    return res.result?.panes ?? []
  }

  async workspaceList(): Promise<WorkspaceInfo[]> {
    const res = await this.call<{ workspaces: WorkspaceInfo[] }>(['workspace', 'list'])
    return res.result?.workspaces ?? []
  }

  async workspaceListing(): Promise<Listing<WorkspaceInfo>> {
    return listingOf(await this.call(['workspace', 'list']), 'workspaces', workspaceEntry)
  }

  async paneListing(workspaceId: string): Promise<Listing<PaneInfo>> {
    return listingOf(await this.call(['pane', 'list', '--workspace', workspaceId]), 'panes', paneEntry)
  }

  /** Without `--cwd` herdr answers `not_git_worktree`: it reads the repo from the focused workspace. */
  async worktreeList(repoRoot: string): Promise<Listing<WorktreeEntry>> {
    return listingOf(await this.call(['worktree', 'list', '--cwd', repoRoot]), 'worktrees', worktreeEntry)
  }

  /**
   * `--no-focus` because a dispatch runs in the background: a create that took
   * focus would move the human's keystrokes into the new worker's pane mid-sentence.
   */
  async worktreeCreate(repoRoot: string, branch: string, base: string): Promise<CallResult<CreatedWorktree>> {
    const res = await this.call([
      'worktree', 'create', '--cwd', repoRoot, '--branch', branch, '--base', base, '--no-focus',
    ])
    if (!res.ok) return { ok: false, code: res.code, message: res.message }
    const created = createdWorktree(res.result)
    return typeof created === 'string'
      ? { ok: false, code: 'unreadable_response', message: `herdr's create response named ${created}` }
      : { ok: true, result: created }
  }

  /**
   * Bounded beyond herdr's own `--timeout`, since a hung CLI would otherwise hold
   * the repo's dispatch lock for good. `onSpawn` hears the child's pid, which is
   * also its process group, so an interrupted dispatch can stop it.
   */
  async agentStart(
    request: AgentStartRequest, boundMs: number, onSpawn?: (pid: number) => void,
  ): Promise<CallResult<unknown>> {
    const argv = [
      this.bin, 'agent', 'start', request.name, '--kind', request.kind, '--pane', request.paneId,
      '--timeout', String(request.timeoutMs), '--', ...request.args,
    ]
    const ran = await runBounded(argv, { timeoutMs: boundMs, onSpawn })
    if (ran.timedOut) {
      return { ok: false, code: 'timeout', message: `herdr agent start did not return within ${boundMs / 1000}s` }
    }
    const res = envelopeResult<unknown>(ran.stdout, ran.stderr)
    if (res.code === 'unparseable' && ran.code === -1) return { ok: false, code: 'spawn_failed', message: ran.stderr }
    return res
  }

  /** The pane an agent of this name runs in; null when herdr names none, for any reason. */
  async agentPane(name: string): Promise<string | null> {
    const res = await this.call<{ agent?: unknown }>(['agent', 'get', name])
    return res.ok ? stringAt(res.result?.agent, 'pane_id') ?? null : null
  }

  async agentStatus(target: string): Promise<AgentStatus> {
    const res = await this.call<{ agent: { agent_status: AgentStatus } }>(['agent', 'get', target])
    return res.result?.agent.agent_status ?? 'unknown'
  }

  async agentPrompt(target: string, text: string): Promise<CallResult<unknown>> {
    return this.call(['agent', 'prompt', target, text])
  }

  /**
   * Succeeds only once herdr has seen the agent take the prompt up. Without
   * `--wait` a success reports the submission, not its effect — and the brief
   * lost on the berean-os run sat unsubmitted in the input box with nothing
   * anywhere saying so.
   */
  async agentPromptConfirmed(
    target: string, text: string, timeoutMs: number,
  ): Promise<CallResult<unknown>> {
    return this.call([
      'agent', 'prompt', target, text,
      '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(timeoutMs),
    ])
  }

  /** Logical key names — `ctrl+u`, not `C-u`, which herdr 0.9.0 rejects as `invalid_key`. */
  async agentSendKeys(target: string, keys: string[]): Promise<CallResult<unknown>> {
    return this.call(['agent', 'send-keys', target, ...keys])
  }

  /**
   * `pane read` prints the screen itself, not a JSON envelope; only a failure is an
   * envelope, with exit 1. Parsed as an envelope, every read came back empty, so
   * the input-box checks never saw a box. Measured against herdr 0.9.0.
   */
  async paneRead(
    target: string, lines: number, source: 'visible' | 'recent' = 'visible',
  ): Promise<string> {
    return this.readScreen(target, lines, 'text', source)
  }

  /** With its SGR styling: the only way to tell Claude's dim prompt suggestion from typed text. */
  async paneReadStyled(target: string, lines: number): Promise<string> {
    return this.readScreen(target, lines, 'ansi', 'visible')
  }

  private async readScreen(
    target: string, lines: number, format: 'text' | 'ansi', source: 'visible' | 'recent',
  ): Promise<string> {
    const output = await this.spawn(
      ['pane', 'read', target, '--source', source, '--lines', String(lines), '--format', format],
    )
    return 'error' in output || output.exitCode !== 0 ? '' : output.stdout
  }

  /**
   * `undefined` means the call FAILED and the pid is unknown; `null` means herdr
   * answered but reported no shell pid. Callers that act destructively on the
   * result must treat unknown as "do not touch" — conflating the two once made
   * the ghost reaper close the live supervisor pane it was protecting.
   */
  async paneShellPid(paneId: string): Promise<number | null | undefined> {
    const res = await this.call<{ process_info: { shell_pid: number } }>(
      ['pane', 'process-info', '--pane', paneId],
    )
    if (!res.ok) return undefined
    return res.result?.process_info.shell_pid ?? null
  }

  async paneClose(paneId: string): Promise<CallResult<unknown>> {
    return this.call(['pane', 'close', paneId])
  }

  async workspaceCreate(label: string): Promise<CallResult<{ workspace: WorkspaceInfo }>> {
    return this.call(['workspace', 'create', '--label', label, '--no-focus'])
  }

  async workspaceReportTokens(
    workspaceId: string, source: string, tokens: Record<string, string>,
  ): Promise<CallResult<unknown>> {
    return this.call([
      'workspace', 'report-metadata', '--workspace', workspaceId,
      '--source', source, '--tokens', JSON.stringify(tokens),
    ])
  }

  async worktreeRemove(workspaceId: string): Promise<CallResult<unknown>> {
    return this.call(['worktree', 'remove', '--workspace', workspaceId, '--force'])
  }

  async pluginPaneOpen(
    pluginId: string, entrypoint: string, workspaceId: string, options: PaneOpenOptions = {},
  ): Promise<CallResult<PluginPaneOpened>> {
    return this.call([
      'plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', entrypoint,
      '--workspace', workspaceId, '--placement', 'tab', '--no-focus',
      ...(options.cwd === undefined ? [] : ['--cwd', options.cwd]),
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]),
    ])
  }

  async paneRename(paneId: string, label: string): Promise<CallResult<unknown>> {
    return this.call(['pane', 'rename', paneId, label])
  }

  /**
   * herdr labels a tab by its number unless it is renamed, so a plugin pane
   * opened as a tab showed up as `2`, and neither the human nor the orchestrator
   * found the board. Measured on a live run.
   */
  async renameTabOf(paneId: string, label: string): Promise<CallResult<unknown>> {
    const pane = await this.call<{ pane?: { tab_id?: string } }>(['pane', 'get', paneId])
    if (!pane.ok) return pane
    const tabId = pane.result?.pane?.tab_id
    if (tabId === undefined) return { ok: false, code: 'no_tab', message: `pane ${paneId} reported no tab` }
    return this.call(['tab', 'rename', tabId, label])
  }
}
