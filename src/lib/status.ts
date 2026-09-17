import { openDecisionFor } from './decisions'
import { filesOverlap, isInFlight } from './gating'
import { counterFor } from './machine'
import { taskRow } from './phases'
import type { Run, SessionKey } from './types'

export interface StatusSupervisor {
  state: 'live' | 'stale' | 'none' | 'other-session'
  pid?: number
}

function ageMinutes(sinceMs: number): number {
  return Math.max(0, Math.floor((Date.now() - sinceMs) / 60000))
}

/** Task-level warnings that only make sense once a run is on the current schema. */
function taskWarnings(run: Run): string[] {
  const lines: string[] = []

  for (const task of run.tasks) {
    if (task.phase === 'escalated') {
      lines.push(
        `  ⚠ ${task.task_id} escalated from ${task.escalated_from ?? 'unknown'} ` +
        `${ageMinutes(task.phase_entered_at)}m ago — needs a human; ` +
        `\`hpipe rewind ${run.run_id} ${task.escalated_from ?? '<phase>'} --task ${task.task_id}\` resumes it`,
      )
    }

    const open = openDecisionFor(task)
    if (open) {
      lines.push(
        `  ⚠ ${task.task_id} blocked on an open decision (${ageMinutes(open.asked_at)}m): ${open.question}`,
      )
    }

    if (task.pending_answer !== null) {
      const decision = task.decisions.find((d) => d.id === task.pending_answer)
      if (decision) {
        lines.push(
          `  ⚠ ${task.task_id} decision ${decision.id} answered but undelivered ` +
          `(${task.delivery_attempts} delivery attempts) — a fresh \`hpipe answer\` re-arms delivery`,
        )
      }
    }

    if (task.phase === 'blocked-on-files') {
      const holders = run.tasks.filter(
        (t) => t.task_id !== task.task_id && isInFlight(t) && filesOverlap(task.files, t.files),
      )
      for (const holder of holders) {
        // `hpipe release` refuses an in-flight holder, so offering it against a
        // healthy one sends the human at a command that will bounce. It is the
        // escape only when the holder has stopped moving and nothing will tear
        // it down.
        const stuck = taskRow(holder.phase).terminal || holder.phase === 'escalated'
        lines.push(
          `  ⚠ ${task.task_id} blocked on files held by ${holder.task_id} (${holder.phase}) — ` +
          (stuck
            ? `\`hpipe release --task ${holder.task_id}\` is the only way out`
            : 'waiting for it to finish'),
        )
      }
    }
  }

  return lines
}

function intakeWarning(run: Run): string[] {
  if (run.phase !== 'execute' || run.intake_closed || run.tasks.length === 0) return []
  const allTerminal = run.tasks.every(
    (t) => taskRow(t.phase).terminal === true || t.phase === 'escalated',
  )
  if (!allTerminal) return []
  return [
    '  ⚠ every task is settled but intake was never closed — ' +
    'run `hpipe dispatch --done` to let this run advance',
  ]
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
    const passes = counterFor(run, run.phase)
    lines.push(
      `${run.run_id}  [${run.phase}]${passes > 0 ? ` pass ${passes}` : ''}  ${run.title}`,
    )
    if (run.orchestrator_pane) lines.push(`  orchestrator: ${run.orchestrator_pane}`)
    if (run.orchestrator_pane && livePanes.size > 0 && !livePanes.has(run.orchestrator_pane)) {
      lines.push(`  ⚠ orchestrator pane ${run.orchestrator_pane} is gone — run the plugin's`)
      lines.push(`    "claim" action from the pane that should drive this run`)
    }

    if (run.schema_version !== 2) {
      lines.push(
        `  ⚠ run ${run.run_id} was started by an earlier plugin version and cannot be ` +
        `advanced — hpipe abort ${run.run_id} to release the repo.`,
      )
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

    if (run.schema_version === 2) {
      lines.push(...intakeWarning(run))
      lines.push(...taskWarnings(run))
    }
  }

  return lines.join('\n')
}
