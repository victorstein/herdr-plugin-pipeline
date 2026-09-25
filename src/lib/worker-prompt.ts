import { join } from 'node:path'
import { briefNote, repoBootstrap } from './bootstrap'
import { taskRow } from './phases'
import { renderPrompt } from './render'
import type { Run, Task } from './types'

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
    task_id: task.task_id,
    run_id: run.run_id,
    branch: task.branch,
    issue: String(task.issue),
    surface: task.surface,
    agent_file: join('.claude', 'agents', `${task.surface}-dev.md`),
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
