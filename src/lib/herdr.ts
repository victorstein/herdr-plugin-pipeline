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
  label?: string
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

  private async call<T>(args: string[]): Promise<CallResult<T>> {
    // Bun.spawn throws synchronously on a missing binary. Callers rely on these
    // methods never throwing, so a bad HERDR_BIN_PATH must degrade to a failed
    // CallResult rather than crash the supervisor loop.
    let stdout: string
    let stderr: string
    try {
      const proc = Bun.spawn([this.bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
      ;[stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ])
      await proc.exited
    } catch (error) {
      return { ok: false, code: 'spawn_failed', message: String(error) }
    }

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

  async paneRead(target: string, lines: number): Promise<string> {
    const res = await this.call<{ text: string }>(
      ['pane', 'read', target, '--source', 'visible', '--lines', String(lines)],
    )
    return res.result?.text ?? ''
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
