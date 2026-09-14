#!/usr/bin/env bun
import { join } from 'node:path'
import { detectCycle, gateStatus } from './lib/gating'
import {
  activeRunForRepo, listRuns, newRun, saveRun, writeOrchestrator,
} from './lib/ledger'
import { enterRunPhase } from './lib/machine'
import { renderPrompt } from './lib/render'
import type { Run, RunPhase, Task, TaskPhase } from './lib/types'

export interface Ctx { stateDir: string; pluginRoot: string; session: string }
export interface CmdResult { ok: boolean; text: string; json?: string }

const ok = (text: string, json?: string): CmdResult => ({ ok: true, text, json })
const fail = (text: string): CmdResult => ({ ok: false, text })

export async function cmdStart(ctx: Ctx, input: {
  title: string; repoKey: string; repoRoot: string
  socketPath: string; paneId: string; workspaceId: string
}): Promise<CmdResult> {
  const existing = await activeRunForRepo(ctx.stateDir, ctx.session, input.repoKey)
  if (existing) {
    return fail(`a run is already active for this repo: ${existing.run_id} (phase ${existing.phase}). ` +
      `Finish it, or run: hpipe abort ${existing.run_id}`)
  }

  const run = newRun({
    session: ctx.session, socketPath: input.socketPath,
    repoKey: input.repoKey, repoRoot: input.repoRoot, title: input.title,
  })
  run.orchestrator_pane = input.paneId
  run.artifacts.spec = join(
    'docs/superpowers/specs',
    `${new Date().toISOString().slice(0, 10)}-${run.run_id.split('-').slice(-2, -1)[0] ?? 'design'}-design.md`,
  )
  await saveRun(ctx.stateDir, run)
  await writeOrchestrator(ctx.stateDir, ctx.session, input.repoKey, {
    pane_id: input.paneId, workspace_id: input.workspaceId,
    socket_path: input.socketPath, claimed_at: Date.now(),
  })

  const text = await renderPrompt(ctx.pluginRoot, 'spec', {
    run_id: run.run_id, title: run.title, spec_path: join(run.repo_root, run.artifacts.spec),
  })
  return ok(text, JSON.stringify({ run_id: run.run_id }))
}

export async function cmdTask(ctx: Ctx, input: {
  branch: string; issue: number; surface: string; text: string
  dependsOn: string[]; files: string[]; keepWorktree: boolean
}): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const run = runs.find((r) => r.phase === 'dispatch' || r.phase === 'execute')
  if (!run) return fail('no run is in the dispatch or execute phase')

  const task: Task = {
    task_id: `t${run.tasks.length + 1}`,
    branch: input.branch, issue: input.issue, surface: input.surface,
    depends_on: input.dependsOn, files: input.files,
    keep_worktree: input.keepWorktree, text: input.text,
    workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'queued', pass: 1, phase_entered_at: Date.now(),
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  }

  const cycle = detectCycle([...run.tasks, task])
  if (cycle) return fail(`--depends-on forms a cycle: ${cycle.join(' → ')}`)

  run.tasks.push(task)
  if (run.phase === 'dispatch') enterRunPhase(run, 'execute', 'first task registered')
  await saveRun(ctx.stateDir, run)

  const gate = gateStatus(task, run.tasks)
  if (gate.state !== 'ready') {
    return ok(`task_id: ${task.task_id}\nqueued: waiting on ${gate.on.join(', ')}`)
  }

  const prompt = await renderWorkerPrompt(ctx, run, task)
  return ok(`task_id: ${task.task_id}\n\n${prompt}`)
}

export async function renderWorkerPrompt(ctx: Ctx, run: Run, task: Task): Promise<string> {
  const dependsOnCore = task.depends_on.some(
    (id) => run.tasks.find((t) => t.task_id === id)?.surface === 'core',
  )
  return renderPrompt(ctx.pluginRoot, 'task', {
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

export async function cmdRewind(ctx: Ctx, input: {
  runId: string; phase: string; taskId: string | null
}): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  if (input.taskId) {
    const task = run.tasks.find((t) => t.task_id === input.taskId)
    if (!task) return fail(`no such task: ${input.taskId}`)
    task.phase = input.phase as TaskPhase
    task.pass = 1
    task.phase_entered_at = Date.now()
    task.escalated_from = null
    run.history.push({ at: Date.now(), task_id: task.task_id, from: 'rewind', to: input.phase, why: 'manual rewind' })
  } else {
    run.phase = input.phase as RunPhase
    run.pass = 1
    run.phase_entered_at = Date.now()
    run.escalated_from = null
    run.history.push({ at: Date.now(), from: 'rewind', to: input.phase, why: 'manual rewind' })
  }

  await saveRun(ctx.stateDir, run)
  return ok(`rewound ${input.taskId ?? input.runId} to ${input.phase}; pass reset to 1`)
}
