#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectCycle, gateStatus } from './lib/gating'
import { Herdr } from './lib/herdr'
import {
  activeRunForRepo, listRuns, newRun, runForWorkspace, saveRun, slugify, writeOrchestrator,
} from './lib/ledger'
import { enterRunPhase, enterTaskPhase } from './lib/machine'
import { supervisorState } from './lib/pidfile'
import { drain } from './lib/queue'
import { renderPrompt } from './lib/render'
import { sessionKey } from './lib/session'
import { formatStatus } from './lib/status'
import { renderWorkerPrompt } from './lib/worker-prompt'
import type { RunPhase, Task, TaskPhase } from './lib/types'

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
    `${new Date().toISOString().slice(0, 10)}-${slugify(input.title)}-design.md`,
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

  const agentFile = join(run.repo_root, '.claude', 'agents', `${input.surface}-dev.md`)
  if (!existsSync(agentFile)) {
    return fail(`no agent definition at ${agentFile} — check --surface`)
  }

  const task: Task = {
    task_id: `t${run.tasks.length + 1}`,
    branch: input.branch, issue: input.issue, surface: input.surface,
    depends_on: input.dependsOn, files: input.files,
    keep_worktree: input.keepWorktree, text: input.text,
    workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'queued', pass: 1, phase_entered_at: Date.now(),
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  }

  // detectCycle skips ids it does not recognise, so a typo would otherwise pass
  // validation here and then wait in `queued` forever with no diagnostic. The
  // new task's own id counts as known — depending on yourself is a cycle, not
  // a typo, and must fall through to the cycle check below to be reported as one.
  const known = new Set([...run.tasks.map((t) => t.task_id), task.task_id])
  const unknown = input.dependsOn.filter((id) => !known.has(id))
  if (unknown.length > 0) return fail(`--depends-on names no such task: ${unknown.join(', ')}`)

  const cycle = detectCycle([...run.tasks, task])
  if (cycle) return fail(`--depends-on forms a cycle: ${cycle.join(' → ')}`)

  run.tasks.push(task)
  if (run.phase === 'dispatch') enterRunPhase(run, 'execute', 'first task registered')
  await saveRun(ctx.stateDir, run)

  const gate = gateStatus(task, run.tasks)
  if (gate.state !== 'ready') {
    return ok(`task_id: ${task.task_id}\nqueued: waiting on ${gate.on.join(', ')}`)
  }

  // The CLI is handing the prompt over now, so the task is dispatched. Leaving it
  // `queued` would make the next tick deliver the same prompt a second time.
  enterTaskPhase(run, task, 'execute', 'dispatched at registration')
  await saveRun(ctx.stateDir, run)

  const prompt = await renderWorkerPrompt(ctx.pluginRoot, run, task)
  return ok(`task_id: ${task.task_id}\n\n${prompt}`)
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

export async function cmdStatus(ctx: Ctx): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const state = await supervisorState(ctx.stateDir, ctx.session)
  const livePanes = new Set((await new Herdr().paneList()).map((p) => p.pane_id))
  return ok(formatStatus(
    runs,
    { state: state.state, pid: 'info' in state ? state.info.pid : undefined },
    ctx.session,
    livePanes,
  ))
}

export async function cmdDrain(ctx: Ctx): Promise<CmdResult> {
  const events = await drain(join(ctx.stateDir, 'queue', ctx.session))
  return ok(events.length === 0 ? 'queue empty' : JSON.stringify(events, null, 2))
}

export async function cmdAbort(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  // Record where it was so resume can put it back. Worktrees and branches are untouched.
  run.history.push({ at: Date.now(), from: run.phase, to: 'done', why: `aborted from ${run.phase}` })
  run.escalated_from = run.phase
  run.phase = 'done'
  await saveRun(ctx.stateDir, run)
  return ok(`aborted ${run.run_id}; worktrees and branches left alone. Undo: hpipe resume ${run.run_id}`)
}

export async function cmdResume(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  const aborted = run.history.at(-1)?.why?.startsWith('aborted from')
  if (run.phase !== 'done' || !aborted || !run.escalated_from) {
    return fail(`${run.run_id} was not aborted — nothing to resume`)
  }

  const back = run.escalated_from
  run.history.push({ at: Date.now(), from: 'done', to: back, why: 'resumed' })
  run.phase = back
  run.escalated_from = null
  run.phase_entered_at = Date.now()
  await saveRun(ctx.stateDir, run)
  return ok(`resumed ${run.run_id} at ${back}`)
}

export async function cmdForget(ctx: Ctx, input: { workspaceId: string }): Promise<CmdResult> {
  const run = await runForWorkspace(ctx.stateDir, ctx.session, input.workspaceId)
  const task = run?.tasks.find((t) => t.workspace_id === input.workspaceId)
  if (!run || !task) return fail(`no task is bound to ${input.workspaceId}`)

  task.workspace_id = null
  task.pane_id = null
  await saveRun(ctx.stateDir, run)
  return ok(`unbound ${input.workspaceId} from ${task.task_id}`)
}

// ——— argv dispatcher ———

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

function listFlag(argv: string[], name: string): string[] {
  const raw = flag(argv, name)
  return raw ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : []
}

async function repoContext(): Promise<{ repoKey: string; repoRoot: string } | null> {
  const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' })
  const root = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (root.length === 0) return null
  return { repoKey: root, repoRoot: root }
}

async function dispatch(argv: string[]): Promise<number> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
    ?? join(process.env.HOME ?? '', '.local/state/herdr/plugins/stein.pipeline')
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, '..')
  const ctx: Ctx = { stateDir, pluginRoot, session: sessionKey() }
  const [command, ...rest] = argv

  const needsRepo = command === 'start' || command === 'task'
  const repo = needsRepo ? await repoContext() : null
  if (needsRepo && !repo) {
    console.error('hpipe: not inside a git repository')
    return 1
  }

  let out: CmdResult
  switch (command) {
    case 'start':
      out = await cmdStart(ctx, {
        title: rest.join(' ').trim(),
        repoKey: repo!.repoKey, repoRoot: repo!.repoRoot,
        socketPath: process.env.HERDR_SOCKET_PATH ?? '',
        paneId: process.env.HERDR_PANE_ID ?? '',
        workspaceId: process.env.HERDR_WORKSPACE_ID ?? '',
      })
      break

    case 'task':
      out = await cmdTask(ctx, {
        branch: flag(rest, 'branch') ?? '',
        issue: Number(flag(rest, 'issue') ?? '0'),
        surface: flag(rest, 'surface') ?? '',
        text: flag(rest, 'text') ?? '',
        dependsOn: listFlag(rest, 'depends-on'),
        files: listFlag(rest, 'files'),
        keepWorktree: rest.includes('--keep-worktree'),
      })
      break

    case 'rewind':
      out = await cmdRewind(ctx, {
        runId: rest[0] ?? '', phase: rest[1] ?? '', taskId: flag(rest, 'task'),
      })
      break

    case 'status': out = await cmdStatus(ctx); break
    case 'drain': out = await cmdDrain(ctx); break
    case 'abort': out = await cmdAbort(ctx, { runId: rest[0] ?? '' }); break
    case 'resume': out = await cmdResume(ctx, { runId: rest[0] ?? '' }); break
    case 'forget': out = await cmdForget(ctx, { workspaceId: rest[0] ?? '' }); break

    default:
      console.error('usage: hpipe <start|task|status|drain|rewind|resume|abort|forget> …')
      return 1
  }

  console.log(out.text)
  return out.ok ? 0 : 1
}

if (import.meta.main) process.exit(await dispatch(process.argv.slice(2)))
