import type { AgentInfo, Snapshot } from '../../src/kit/types'
import { COLUMNS, type Column } from '../../src/kit/nav'
import type { CardView } from '../../src/kit/render'

export function agent(over: Partial<AgentInfo> & { terminal_id: string }): AgentInfo {
  return {
    pane_id: 'w1:p1',
    tab_id: 'w1:t1',
    workspace_id: 'w1',
    agent: 'claude',
    agent_status: 'idle',
    terminal_title_stripped: 'task',
    ...over,
  }
}

export function snapshot(agents: AgentInfo[], extra: Partial<Snapshot> = {}): Snapshot {
  return {
    agents,
    panes: agents.map((a) => ({
      pane_id: a.pane_id,
      tab_id: a.tab_id,
      workspace_id: a.workspace_id,
      terminal_id: a.terminal_id,
      agent: a.agent,
      agent_status: a.agent_status,
    })),
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
    workspaces: [{ workspace_id: 'w1', label: 'General', active_tab_id: 'w1:t1' }],
    layouts: [],
    focused_workspace_id: 'w1',
    focused_pane_id: null,
    ...extra,
  }
}

export function ids(over: Partial<Record<Column, string[]>>): Record<Column, { id: string }[]> {
  return Object.fromEntries(COLUMNS.map((c) => [c, (over[c] ?? []).map((id) => ({ id }))])) as Record<Column, { id: string }[]>
}

export function cardView(over: Partial<CardView> & { id: string }): CardView {
  return {
    column: 'idle',
    title: 'task',
    subtitle: 'General · main',
    badge: { text: 'claude', color: '#6c7086' },
    since: null,
    ctx: null,
    scene: 'idle',
    accessory: 'none',
    enteredAt: null,
    ...over,
  }
}

export function views(cards: CardView[]): Record<Column, CardView[]> {
  return Object.fromEntries(COLUMNS.map((c) => [c, cards.filter((v) => v.column === c)])) as Record<Column, CardView[]>
}
