export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export interface AgentInfo {
  pane_id: string
  tab_id: string
  workspace_id: string
  terminal_id: string
  agent: string | null
  agent_status: AgentStatus
  terminal_title_stripped?: string
  cwd?: string
}

export interface PaneInfo {
  pane_id: string
  tab_id: string
  workspace_id: string
  terminal_id: string
  agent?: string | null
  agent_status: AgentStatus
  cwd?: string
  foreground_cwd?: string
  label?: string | null
  tokens?: Record<string, string>
}

export interface TabInfo {
  tab_id: string
  workspace_id: string
  label: string
}

export interface WorkspaceInfo {
  workspace_id: string
  label: string
  active_tab_id: string
  worktree?: { is_linked_worktree: boolean } | null
}

export interface LayoutInfo {
  tab_id: string
  workspace_id: string
  zoomed: boolean
  focused_pane_id: string
}

export interface Snapshot {
  agents: AgentInfo[]
  panes: PaneInfo[]
  tabs: TabInfo[]
  workspaces: WorkspaceInfo[]
  layouts: LayoutInfo[]
  focused_workspace_id: string | null
  focused_pane_id: string | null
}
