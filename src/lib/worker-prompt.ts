import { join } from 'node:path'
import { renderPrompt } from './render'
import type { Run, Task } from './types'

export async function renderWorkerPrompt(
  pluginRoot: string, run: Run, task: Task,
): Promise<string> {
  const dependsOnCore = task.depends_on.some(
    (id) => run.tasks.find((t) => t.task_id === id)?.surface === 'core',
  )
  return renderPrompt(pluginRoot, 'task', {
    branch: task.branch,
    issue: String(task.issue),
    surface: task.surface,
    agent_file: join('.claude', 'agents', `${task.surface}-dev.md`),
    task_text: task.text,
    dist_note: dependsOnCore
      ? '> `@repo/core` changed on `main` since this branch was cut. Run ' +
        '`pnpm install && pnpm turbo build --filter=@repo/core` before your first edit and again ' +
        'before opening the PR — the apps consume the built `dist`, not the source.'
      : '',
  })
}
