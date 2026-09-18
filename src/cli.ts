#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { answerDecision, openDecision, openDecisionFor } from './lib/decisions'
import { detectCycle, gateStatus } from './lib/gating'
import { Herdr } from './lib/herdr'
import {
  activeRunForRepo, listRuns, newRun, runForWorkspace, saveRun, writeOrchestrator,
} from './lib/ledger'
import { enterTaskPhase } from './lib/machine'
import { taskRow } from './lib/phases'
import { supervisorState } from './lib/pidfile'
import { drain } from './lib/queue'
import { renderPrompt } from './lib/render'
import { sessionKey } from './lib/session'
import { formatStatus } from './lib/status'
import { renderWorkerPrompt } from './lib/worker-prompt'
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
  await saveRun(ctx.stateDir, run)
  await writeOrchestrator(ctx.stateDir, ctx.session, input.repoKey, {
    pane_id: input.paneId, workspace_id: input.workspaceId,
    socket_path: input.socketPath, claimed_at: Date.now(),
  })

  const text = await renderPrompt(ctx.pluginRoot, 'intake', {
    run_id: run.run_id, title: run.title,
  })
  return ok(text, JSON.stringify({ run_id: run.run_id }))
}

export async function cmdTask(ctx: Ctx, input: {
  branch: string; issue: number; surface: string; notes: string
  dependsOn: string[]; files: string[]; keepWorktree: boolean
}): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const run = runs.find(
    (r) => r.phase === 'intake' || r.phase === 'dispatch' || r.phase === 'execute',
  )
  if (!run) return fail('no run is in the intake, dispatch or execute phase')

  // The argv parser defaults a missing --issue to 0 and a missing --branch to
  // "". Without these checks a mistyped command mints a ghost task into a live
  // run, and there is no command that removes one. Measured on a live run.
  if (!Number.isInteger(input.issue) || input.issue <= 0) {
    return fail(`--issue must be a positive issue number, got: ${input.issue || '(missing)'}`)
  }
  if (input.branch.trim().length === 0) return fail('--branch is required')

  const agentFile = join(run.repo_root, '.claude', 'agents', `${input.surface}-dev.md`)
  if (!existsSync(agentFile)) {
    return fail(`no agent definition at ${agentFile} — check --surface`)
  }

  // A path prefix cannot contain whitespace, and cannot look like a flag. Both are
  // argv accidents: one quoted space-separated list in a single --files, or a
  // --files with no value swallowing the next flag. Neither is detectable later —
  // filesOverlap simply never fires and the gate reports "no overlapping files in
  // flight" while two workers edit the same files. Measured on a live run.
  for (const entry of input.files) {
    if (/\s/.test(entry)) {
      return fail(
        `--files is comma-separated; this entry contains whitespace: "${entry}"\n` +
        `  → --files ${entry.trim().split(/\s+/).join(',')}`,
      )
    }
    if (entry.startsWith('--')) {
      return fail(
        `--files got a flag where a path prefix belongs: "${entry}" — ` +
        'the value after --files is missing',
      )
    }
  }

  const date = new Date().toISOString().slice(0, 10)
  const stem = `${date}-issue-${input.issue}`

  const task: Task = {
    task_id: `t${run.tasks.length + 1}`,
    branch: input.branch, issue: input.issue, surface: input.surface,
    depends_on: input.dependsOn, files: input.files,
    keep_worktree: input.keepWorktree,
    workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'queued', phase_entered_at: Date.now(),
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
    checkout_path: null, registered_at: Date.now(), adopted_at: null,
    artifacts: {
      research: join('docs/superpowers/research', `${stem}-research.md`),
      spec: join('docs/superpowers/specs', `${stem}-design.md`),
      plan: join('docs/superpowers/plans', `${stem}-plan.md`),
      verdicts: {},
    },
    merged_at_ms: null, issue_closed_at_entry: false, passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: input.notes,
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
  // execute completes only once intake is closed and every task is terminal, so a
  // task registered mid-run must reopen the gate or the run could complete underneath it.
  run.intake_closed = false
  await saveRun(ctx.stateDir, run)

  // The recorded set, printed back. A malformed --files is otherwise invisible:
  // the only other place task.files reaches a human is the blocked-on-files
  // warning in status.ts, which speaks only once overlap has already fired — so a
  // declaration that matches nothing is silent by construction.
  const filesLine = `files: ${task.files.length > 0 ? task.files.join(', ') : 'none'}`

  const gate = gateStatus(task, run.tasks)
  if (gate.state !== 'ready') {
    return ok(`task_id: ${task.task_id}\n${filesLine}\nqueued: waiting on ${gate.on.join(', ')}`)
  }

  // The CLI is handing the prompt over now, so the task is dispatched. Leaving it
  // `queued` would make the next tick deliver the same prompt a second time.
  enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'dispatched at registration')
  await saveRun(ctx.stateDir, run)

  const prompt = await renderWorkerPrompt(ctx.pluginRoot, run, task)
  return ok(`task_id: ${task.task_id}\n${filesLine}\n\n${prompt}`)
}

/**
 * Read-only. Without it the only way to see a worker brief is to register a
 * task, which mutates the run — so an orchestrator that loses its context has
 * no way back to the text it is supposed to hand over. Measured on a live run.
 */
export async function cmdBrief(ctx: Ctx, input: { taskId: string }): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session))
    .find((r) => r.tasks.some((t) => t.task_id === input.taskId))
  const task = run?.tasks.find((t) => t.task_id === input.taskId)
  if (!run || !task) return fail(`no such task: ${input.taskId}`)

  return ok(await renderWorkerPrompt(ctx.pluginRoot, run, task))
}

export async function cmdDispatchDone(ctx: Ctx, input: { runId?: string }): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const run = input.runId
    ? runs.find((r) => r.run_id === input.runId)
    : runs.find((r) => r.phase === 'intake' || r.phase === 'dispatch' || r.phase === 'execute')
  if (!run) {
    return fail(input.runId
      ? `no such run: ${input.runId}`
      : 'no run is in the intake, dispatch or execute phase')
  }

  run.intake_closed = true
  await saveRun(ctx.stateDir, run)
  return ok(`intake closed for ${run.run_id}`)
}

export async function cmdRewind(ctx: Ctx, input: {
  runId: string; phase: string; taskId: string | null
}): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  if (input.taskId) {
    const task = run.tasks.find((t) => t.task_id === input.taskId)
    if (!task) return fail(`no such task: ${input.taskId}`)

    if (task.pending_answer !== null) {
      run.history.push({
        at: Date.now(), task_id: task.task_id, from: task.phase, to: input.phase,
        why: `answer to ${task.pending_answer} discarded, undelivered`,
      })
      task.pending_answer = null
    }

    task.phase = input.phase as TaskPhase
    task.passes = {}
    task.delivery_attempts = 0
    task.phase_entered_at = Date.now()
    task.escalated_from = null
    run.history.push({ at: Date.now(), task_id: task.task_id, from: 'rewind', to: input.phase, why: 'manual rewind' })
  } else {
    run.phase = input.phase as RunPhase
    run.passes = {}
    run.phase_entered_at = Date.now()
    run.escalated_from = null
    // applyEvents binds a worktree only when workspace_id is null, so adopted_at is
    // write-once — without clearing it here, rewinding to `dispatch` could never
    // re-fire that row's edge and the rewind would be a one-way door.
    if (input.phase === 'dispatch') {
      for (const t of run.tasks) if (t.workspace_id !== null) t.adopted_at = null
    }
    run.history.push({ at: Date.now(), from: 'rewind', to: input.phase, why: 'manual rewind' })
  }

  await saveRun(ctx.stateDir, run)
  return ok(`rewound ${input.taskId ?? input.runId} to ${input.phase}; counters cleared`)
}

export async function cmdRelease(ctx: Ctx, input: { taskId: string }): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session))
    .find((r) => r.tasks.some((t) => t.task_id === input.taskId))
  const task = run?.tasks.find((t) => t.task_id === input.taskId)
  if (!run || !task) return fail(`no such task: ${input.taskId}`)

  // `escalated` is not `terminal` — it carries `escalated_from` so a human can
  // rewind it — but it has stopped moving and is a legitimate release target too.
  if (!taskRow(task.phase).terminal && task.phase !== 'escalated') {
    return fail(`task ${input.taskId} is still in flight (${task.phase})`)
  }

  task.files = []
  await saveRun(ctx.stateDir, run)
  return ok(`released ${input.taskId}; files reservation cleared`)
}

export async function cmdDecide(ctx: Ctx, input: {
  task: string; question: string; recommendation: string
}): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session))
    .find((r) => r.tasks.some((t) => t.task_id === input.task))
  const task = run?.tasks.find((t) => t.task_id === input.task)
  if (!run || !task) return fail(`no such task: ${input.task}`)

  if (input.recommendation.trim().length === 0) {
    return fail('--recommend is required: a bare question pushes the call up to the orchestrator')
  }

  // decision_from records where the worker actually was; a second call while
  // already blocked-on-decision would overwrite it with 'blocked-on-decision'
  // itself, stranding the task with no phase to rewind back to.
  if (task.phase === 'blocked-on-decision') {
    return fail(`task ${input.task} already has an open decision: ${openDecisionFor(task)?.id}`)
  }

  task.decision_from = task.phase
  const decision = openDecision(task, { question: input.question, recommendation: input.recommendation })
  enterTaskPhase(run, task, 'blocked-on-decision', 'worker surfaced a decision')
  await saveRun(ctx.stateDir, run)
  return ok(`opened decision ${decision.id} on ${input.task}; task blocked-on-decision`)
}

export async function cmdAnswer(ctx: Ctx, input: {
  task: string; decision: string; answer: string; by: 'orchestrator' | 'human'
}): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session))
    .find((r) => r.tasks.some((t) => t.task_id === input.task))
  const task = run?.tasks.find((t) => t.task_id === input.task)
  if (!run || !task) return fail(`no such task: ${input.task}`)

  if (input.by !== 'orchestrator' && input.by !== 'human') {
    return fail(`--by must be 'orchestrator' or 'human', got: ${input.by}`)
  }

  if (task.phase !== 'blocked-on-decision') {
    return fail(`task ${input.task} is not blocked on a decision (phase: ${task.phase})`)
  }

  let decision
  try {
    decision = answerDecision(task, input.decision, input.answer, input.by)
  } catch {
    return fail(`no such decision: ${input.decision}`)
  }

  // Delivery is a separate step (Task 20): writing the answer must not resume
  // the task, or a slow worker's late file touch would complete the phase unread.
  task.pending_answer = decision.id
  task.delivery_attempts = 0
  await saveRun(ctx.stateDir, run)
  return ok(`recorded answer to ${decision.id} on ${input.task}; pending delivery`)
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

// Exported for its tests: `dispatch` is module-private, so this is the only
// importable symbol on the argv layer where the --files bug lived. It proves the
// helper; `test/cli-argv.test.ts` drives the real binary and proves the wiring.
export function listFlag(argv: string[], name: string): string[] {
  const entries: string[] = []
  // Every occurrence contributes. `flag` is indexOf-based, so the previous
  // single-lookup form silently dropped a repeated --files and everything it
  // declared, with no diagnostic anywhere.
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== `--${name}`) continue
    const raw = argv[i + 1]
    if (raw === undefined) continue
    entries.push(...raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
  }
  return entries
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
        notes: flag(rest, 'notes') ?? '',
        dependsOn: listFlag(rest, 'depends-on'),
        files: listFlag(rest, 'files'),
        keepWorktree: rest.includes('--keep-worktree'),
      })
      break

    case 'brief':
      out = await cmdBrief(ctx, { taskId: flag(rest, 'task') ?? '' })
      break

    case 'dispatch':
      if (!rest.includes('--done')) {
        console.error('usage: hpipe dispatch --done [--run <run-id>]')
        return 1
      }
      out = await cmdDispatchDone(ctx, { runId: flag(rest, 'run') ?? undefined })
      break

    case 'rewind':
      out = await cmdRewind(ctx, {
        runId: rest[0] ?? '', phase: rest[1] ?? '', taskId: flag(rest, 'task'),
      })
      break

    case 'release':
      out = await cmdRelease(ctx, { taskId: flag(rest, 'task') ?? '' })
      break

    case 'decide':
      out = await cmdDecide(ctx, {
        task: flag(rest, 'task') ?? '',
        question: flag(rest, 'question') ?? '',
        recommendation: flag(rest, 'recommend') ?? '',
      })
      break

    case 'answer':
      out = await cmdAnswer(ctx, {
        task: flag(rest, 'task') ?? '',
        decision: flag(rest, 'decision') ?? '',
        answer: flag(rest, 'answer') ?? '',
        by: (flag(rest, 'by') ?? '') as 'orchestrator' | 'human',
      })
      break

    case 'status': out = await cmdStatus(ctx); break
    case 'drain': out = await cmdDrain(ctx); break
    case 'abort': out = await cmdAbort(ctx, { runId: rest[0] ?? '' }); break
    case 'resume': out = await cmdResume(ctx, { runId: rest[0] ?? '' }); break
    case 'forget': out = await cmdForget(ctx, { workspaceId: rest[0] ?? '' }); break

    default:
      console.error('usage: hpipe <start|task|dispatch|status|drain|rewind|release|decide|answer|resume|abort|forget> …')
      return 1
  }

  console.log(out.text)
  return out.ok ? 0 : 1
}

if (import.meta.main) process.exit(await dispatch(process.argv.slice(2)))
