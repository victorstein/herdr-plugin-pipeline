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

export interface WorkspaceInfo {
  workspace_id: string
  label: string
  worktree?: { repo_key: string; repo_root: string; is_linked_worktree: boolean } | null
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
    const { stdout, stderr } = output

    // herdr 0.9.0 writes a failure's envelope to stderr, exits 1 and leaves
    // stdout empty; reading stdout alone turned every error code into
    // `unparseable`. Measured on a live run.
    const parsed = parseEnvelope<T>(stdout) ?? parseEnvelope<T>(stderr)
    if (parsed === null) {
      return { ok: false, code: 'unparseable', message: (stdout || stderr).slice(0, 200) }
    }

    // herdr reports some failures in the body while exiting 0.
    if (parsed.error) return { ok: false, code: parsed.error.code, message: parsed.error.message }
    return { ok: true, result: parsed.result }
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
    pluginId: string, entrypoint: string, workspaceId: string,
  ): Promise<CallResult<unknown>> {
    return this.call([
      'plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', entrypoint,
      '--workspace', workspaceId, '--placement', 'tab', '--no-focus',
    ])
  }
}
