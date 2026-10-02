import { briefNote, repoBootstrap } from './bootstrap'
import { taskRow } from './phases'
import { renderPrompt } from './render'
import { tierPromptVars } from './tier-prompt'
import type { BeadBrief, Run, Task } from './types'

export function renderBrief(brief: BeadBrief): string {
  const acceptance = brief.acceptance.trim() === '' ? '(none recorded)' : brief.acceptance.trim()
  return [`**${brief.title}**`, '', brief.description.trim(), '', '**Acceptance**', '', acceptance].join('\n')
}

/** Spread into every task render site, so no template can render without either token. */
export function beadPromptVars(task: Task): { bead: string; brief: string } {
  return { bead: task.bead, brief: renderBrief(task.brief) }
}

/**
 * The brief plus the `research` row's own prompt. A task enters `research` at
 * gate-open, before `agent start` has given it a pane, so that row's prompt has
 * no later delivery path — it ships with the brief or never arrives at all.
 *
 * Past `research` the brief goes to a fresh agent set up after a rewind, and its
 * research section — "write this note, then stop" — would contradict the phase
 * the task is actually in, so it is left out.
 */
export async function renderWorkerPrompt(
  pluginRoot: string, run: Run, task: Task,
): Promise<string> {
  const vars = {
    ...tierPromptVars(task),
    run_id: run.run_id,
    branch: task.branch,
    ...beadPromptVars(task),
    surface: task.surface,
    batch_context: batchContext(task.notes),
    research_path: task.artifacts.research ?? '',
    spec_path: task.artifacts.spec ?? '',
    plan_path: task.artifacts.plan ?? '',
    bootstrap_note: briefNote(repoBootstrap(run.repo_root)),
  }

  const brief = await renderPrompt(pluginRoot, 'worker-brief', vars)
  const briefedPhase = taskRow('queued').onClear
  if (task.phase !== 'queued' && task.phase !== briefedPhase) return collapseBlankRuns(brief)
  const research = await renderPrompt(pluginRoot, 'research', vars)
  return collapseBlankRuns(`${brief}\n\n${research}`)
}

function batchContext(notes: string): string {
  return notes.trim() === '' ? '' : `Batch context the public issue does not carry: ${notes}`
}

// An optional section renders to '' on a line of its own and would leave a
// double gap behind it; `render()` cannot drop the line, since it only knows tokens.
function collapseBlankRuns(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n')
}
