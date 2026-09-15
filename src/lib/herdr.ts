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

export class Herdr {
  constructor(private readonly bin: string = process.env.HERDR_BIN_PATH ?? 'herdr') {}

  private async call<T>(args: string[]): Promise<CallResult<T>> {
    // Bun.spawn throws synchronously on a missing binary. Callers rely on these
    // methods never throwing, so a bad HERDR_BIN_PATH must degrade to a failed
    // CallResult rather than crash the supervisor loop.
    let text: string
    try {
      const proc = Bun.spawn([this.bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
      text = await new Response(proc.stdout).text()
      await proc.exited
    } catch (error) {
      return { ok: false, code: 'spawn_failed', message: String(error) }
    }

    let parsed: Envelope<T>
    try {
      parsed = JSON.parse(text) as Envelope<T>
    } catch {
      return { ok: false, code: 'unparseable', message: text.slice(0, 200) }
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
