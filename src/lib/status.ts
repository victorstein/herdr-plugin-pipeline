import type { Run, SessionKey } from './types'

export interface StatusSupervisor {
  state: 'live' | 'stale' | 'none' | 'other-session'
  pid?: number
}

export function formatStatus(
  runs: Run[], supervisor: StatusSupervisor, session: SessionKey,
  livePanes: ReadonlySet<string> = new Set(),
): string {
  const lines: string[] = []
  lines.push(`session: ${session}`)
  lines.push(
    `supervisor: ${supervisor.state}${supervisor.pid ? ` (pid ${supervisor.pid})` : ''}`,
  )
  if (supervisor.state !== 'live') {
    lines.push('  → nothing will advance until a supervisor is running:')
    lines.push('    herdr plugin action invoke stein.pipeline.supervisor')
  }

  if (runs.length === 0) {
    lines.push('no active runs')
    return lines.join('\n')
  }

  for (const run of runs) {
    lines.push('')
    lines.push(`${run.run_id}  [${run.phase}] pass ${run.pass}  ${run.title}`)
    if (run.orchestrator_pane) lines.push(`  orchestrator: ${run.orchestrator_pane}`)
    if (run.orchestrator_pane && livePanes.size > 0 && !livePanes.has(run.orchestrator_pane)) {
      lines.push(`  ⚠ orchestrator pane ${run.orchestrator_pane} is gone — run the plugin's`)
      lines.push(`    "claim" action from the pane that should drive this run`)
    }
    for (const task of run.tasks) {
      const bits = [
        `  ${task.task_id}`,
        task.branch,
        `#${task.issue}`,
        `[${task.phase}]`,
        task.agent_status,
      ]
      if (task.pr !== null) bits.push(`PR #${task.pr}`)
      if (task.ci !== null) bits.push(`ci:${task.ci}`)
      lines.push(bits.join(' '))
    }
  }

  return lines.join('\n')
}
