import { join } from 'node:path'
import { briefNote, repoBootstrap } from './bootstrap'
import { renderPrompt } from './render'
import type { Run, Task } from './types'

/**
 * The brief plus the `research` row's own prompt. A task enters `research` at
 * gate-open, before `agent start` has given it a pane, so that row's prompt has
 * no later delivery path — it ships with the brief or never arrives at all.
 */
export async function renderWorkerPrompt(
  pluginRoot: string, run: Run, task: Task,
): Promise<string> {
  const dependsOnCore = task.depends_on.some(
    (id) => run.tasks.find((t) => t.task_id === id)?.surface === 'core',
  )
  const vars = {
    task_id: task.task_id,
    run_id: run.run_id,
    branch: task.branch,
    issue: String(task.issue),
    surface: task.surface,
    agent_file: join('.claude', 'agents', `${task.surface}-dev.md`),
    notes: task.notes,
    research_path: task.artifacts.research ?? '',
    spec_path: task.artifacts.spec ?? '',
    plan_path: task.artifacts.plan ?? '',
    dist_note: dependsOnCore
      ? '> `@repo/core` changed on `main` since this branch was cut. Run ' +
        '`pnpm install && pnpm turbo build --filter=@repo/core` before your first edit and again ' +
        'before opening the PR — the apps consume the built `dist`, not the source.'
      : '',
    bootstrap_note: briefNote(repoBootstrap(run.repo_root)),
  }

  const brief = await renderPrompt(pluginRoot, 'worker-brief', vars)
  const research = await renderPrompt(pluginRoot, 'research', vars)
  return `${brief}\n\n${research}`
}
