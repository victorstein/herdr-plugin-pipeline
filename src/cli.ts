#!/usr/bin/env bun
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { bootstrapLine, repoBootstrap } from './lib/bootstrap'
import { abandonDecisions, answerDecision, openDecision, openDecisionFor } from './lib/decisions'
import { detectCycle, gateStatus } from './lib/gating'
import { Gh, type FiledIssue, type GhFailure } from './lib/gh'
import { Herdr, type CallResult } from './lib/herdr'
import {
  isUnlandedSave, listRuns, newRun, resolveRun, retryOnStaleRun, runById, runForRepo,
  runForWorkspace, runIsDriven, runPhaseState, saveRun, taskPhaseIsTerminal, unlandedSaveMessage,
  writeOrchestrator,
} from './lib/ledger'
import type { RunQuery, RunReach, RunResolution } from './lib/ledger'
import { enterTaskPhase } from './lib/machine'
import { RUN_ROWS, TASK_ROWS, runRow, taskRow } from './lib/phases'
import { supervisorState } from './lib/pidfile'
import { drain } from './lib/queue'
import { hpipeCommand, renderPrompt } from './lib/render'
import { repoContext } from './lib/repo'
import { sessionKey } from './lib/session'
import { formatStatus, formatTaskDetail, resumeCommand } from './lib/status'
import { bindWorkerPane } from './lib/unstarted'
import { reserveVerdict } from './lib/verdict-path'
import { renderWorkerPrompt } from './lib/worker-prompt'
import type { Run, RunPhase, Task, TaskPhase } from './lib/types'

export interface Ctx { stateDir: string; pluginRoot: string; session: string }
export interface CmdResult { ok: boolean; text: string; json?: string }

const ok = (text: string, json?: string): CmdResult => ({ ok: true, text, json })
const fail = (text: string): CmdResult => ({ ok: false, text })

/**
 * A command that loses a save to the supervisor re-runs from its first read, so
 * every guard is re-checked against what the supervisor just wrote. One that
 * cannot land says so and exits non-zero: printing success for a recovery
 * command the supervisor then discarded is how #51 stayed invisible.
 */
function retryingOnStale<A extends unknown[]>(
  command: (...args: A) => Promise<CmdResult>,
): (...args: A) => Promise<CmdResult> {
  return async (...args) => {
    try {
      return await retryOnStaleRun(() => command(...args))
    } catch (error) {
      if (isUnlandedSave(error)) return fail(unlandedSaveMessage(error))
      throw error
    }
  }
}

// No leading article: the call sites supply their own, so both "found no run in
// intake, dispatch or execute" and "more than one live run" read as sentences.
function phraseFor(phases: readonly RunPhase[] | null): string {
  if (phases === null || phases.length === 0) return 'live run'
  const names = [...phases]
  const last = names.pop() as RunPhase
  return names.length === 0 ? `run in ${last}` : `run in ${names.join(', ')} or ${last}`
}

const runLine = (run: Run): string => `  ${run.run_id} (${run.phase})`

// The phase on each line is the reason it was excluded, so a run that is merely
// past this command's phases is not described as finished — and an unreadable
// one says so, because `(dnoe)` alone reads like an ordinary phase name.
function excludedLine(run: Run, hpipe: string): string {
  const state = runPhaseState(run)
  if (state === 'unreadable') return `  ${run.run_id} (${run.phase}) — unrecognised phase, in no phase row`
  if (state === 'live' && !runIsDriven(run)) {
    return `${runLine(run)} — parked; \`${resumeCommand(hpipe, run)}\` resumes it`
  }
  return runLine(run)
}

/**
 * The sentence a failed resolution prints. #36's brief was wrong for hours
 * because nothing said a second `t1` existed — so a no-match names the runs it
 * excluded, and only offers a way into a finished one when the command has one.
 */
function resolveFailure(
  ctx: Ctx, query: RunQuery, escape: string | null,
  result: Exclude<RunResolution, { ok: true }>,
): CmdResult {
  const scope = [
    phraseFor(query.phases),
    query.taskId === null ? null : `holding ${query.taskId}`,
    query.repoKey === null ? null : `for ${query.repoKey}`,
    `in session ${ctx.session}`,
  ].filter((s): s is string => s !== null).join(' ')
  const hpipe = hpipeCommand(ctx.pluginRoot)

  switch (result.reason) {
    case 'no-such-run':
      return fail(`no such run: ${query.runId}`)
    case 'unreadable':
      return fail(`${result.run.run_id} is in ${result.run.phase}, which is in no phase row — ` +
        `rewind it to a real phase: ${hpipe} rewind ${result.run.run_id} <phase>`)
    case 'terminal':
      return fail(`run ${result.run.run_id} is finished (phase: ${result.run.phase}) — ` +
        'a finished run cannot be re-entered')
    case 'parked':
      return fail(`run ${result.run.run_id} is parked in ${result.run.phase}; the supervisor ` +
        `drives nothing on it until a human rewinds it — \`${resumeCommand(hpipe, result.run)}\` resumes it`)
    case 'wrong-phase':
      return fail(`run ${result.run.run_id} is in ${result.run.phase}; ` +
        `this needs a ${phraseFor(query.phases)}`)
    case 'ambiguous':
      return fail(`more than one ${scope}:\n` +
        result.candidates.map(runLine).join('\n') +
        '\n  → name one with --run <run-id>')
    case 'none': {
      if (result.excluded.length === 0) return fail(`found no ${scope}`)
      // Only worth saying when one of them actually is finished: `excluded` also
      // holds live runs that are simply past this command's phases.
      const anyTerminal = result.excluded.some((r) => runPhaseState(r) === 'terminal')
      const tail = !anyTerminal ? ''
        : escape === null ? '\n  a finished run cannot be re-entered'
        : `\n  → ${escape}`
      return fail(`found no ${scope}\n  excluded:\n` +
        result.excluded.map((r) => excludedLine(r, hpipe)).join('\n') + tail)
    }
  }
}

type Resolved<T> = { ok: true; value: T } | { ok: false; result: CmdResult }

/**
 * Resolve a run for one command, or the sentence to print instead. Every
 * command goes through here so `--run` is validated and a failure is worded the
 * same way whoever asked; `escape` is how this command reaches a finished run,
 * or null when it has no way in.
 */
async function resolveFor(
  ctx: Ctx, query: RunQuery, escape: string | null,
): Promise<Resolved<Run>> {
  if (query.runId !== null && query.runId.trim().length === 0) {
    return { ok: false, result: fail('--run needs a run id') }
  }
  const resolved = await resolveRun(ctx.stateDir, ctx.session, query)
  return resolved.ok
    ? { ok: true, value: resolved.run }
    : { ok: false, result: resolveFailure(ctx, query, escape, resolved) }
}

/**
 * The four commands addressed by task id share this: a task id is per-run
 * (`t${n}`), so the run has to be pinned before the id means anything.
 */
async function resolveTask(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
  reach: RunReach; escape: string | null
}): Promise<Resolved<{ run: Run; task: Task }>> {
  if (input.taskId.trim().length === 0) {
    return { ok: false, result: fail('--task is required') }
  }

  const query: RunQuery = {
    runId: input.runId, repoKey: input.repoKey,
    phases: null, taskId: input.taskId, reach: input.reach,
  }
  const found = await resolveFor(ctx, query, input.escape)
  if (!found.ok) return found

  const task = found.value.tasks.find((t) => t.task_id === input.taskId)
  if (!task) return { ok: false, result: fail(`no such task: ${input.taskId}`) }
  return { ok: true, value: { run: found.value, task } }
}

export async function cmdStart(ctx: Ctx, input: {
  title: string; repoKey: string; repoRoot: string
  socketPath: string; paneId: string; workspaceId: string
}): Promise<CmdResult> {
  const existing = await runForRepo(ctx.stateDir, ctx.session, input.repoKey)
  if (existing.kind !== 'free') {
    const blocker = existing.kind === 'ambiguous' ? existing.runs[0] as Run : existing.run
    return fail(`a run is already active for this repo: ${blocker.run_id} (phase ${blocker.phase}). ` +
      `Finish it, or run: ${hpipeCommand(ctx.pluginRoot)} abort ${blocker.run_id}`)
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

const REGISTRABLE: readonly RunPhase[] = ['intake', 'dispatch', 'execute']
const PHASES_BEFORE_A_PR: ReadonlySet<string> = new Set<TaskPhase>([
  'queued', 'research', 'spec', 'spec-review', 'plan', 'plan-review', 'blocked-on-files', 'implement',
])

type FileIssue = (repoRoot: string, title: string, bodyFile: string) => Promise<FiledIssue | GhFailure>

/** What one `hpipe task` call carries across the stale-run retries of its registration. */
interface RegistrationAttempt {
  fileIssueOnce: (repoRoot: string) => Promise<FiledIssue | GhFailure>
  landed: (taskId: string) => void
}

const fileIssueWithGh: FileIssue = (repoRoot, title, bodyFile) =>
  new Gh(undefined, repoRoot).issueCreate(title, bodyFile)

interface TaskInput {
  branch: string; issue: number; surface: string; notes: string
  dependsOn: string[]; files: string[]; keepWorktree: boolean
  repoKey: string | null; runId: string | null
  title?: string; bodyFile?: string
}

async function registerTask(
  ctx: Ctx, input: TaskInput, attempt: RegistrationAttempt,
): Promise<CmdResult> {
  const query: RunQuery = {
    runId: input.runId, repoKey: input.repoKey,
    phases: REGISTRABLE, taskId: null, reach: 'unfinished',
  }
  const found = await resolveFor(ctx, query, null)
  if (!found.ok) return found.result
  const run = found.value

  // Work with no issue behind it used to fall outside the pipeline and be
  // hand-rolled, which is where the mistakes were. Filing one here, rather than
  // letting a task run issue-less, keeps the issue body as the one brief and
  // `Closes #N` as the close phase's signal. Measured on a live run.
  const filing = input.title !== undefined

  // The argv parser defaults a missing --issue to 0 and a missing --branch to
  // "". Without these checks a mistyped command mints a ghost task into a live
  // run, and there is no command that removes one. Measured on a live run.
  if (filing && input.issue !== 0) {
    return fail('--issue registers an existing issue and --title files a new one — pass one, not both')
  }
  if (!filing && (!Number.isInteger(input.issue) || input.issue <= 0)) {
    return fail(
      `--issue must be a positive issue number, got: ${input.issue || '(missing)'}\n` +
      '  → no issue yet? --title <title> --body-file <path> files one and registers it',
    )
  }
  if (filing) {
    if (input.title!.trim().length === 0) return fail('--title cannot be empty')
    // --title is free text, so the argv layer lets a missing value swallow the
    // next flag — and the issue it files would be public under that flag's name.
    if (input.title!.startsWith('--')) {
      return fail(`--title got a flag where the title belongs: "${input.title}" — the value after --title is missing`)
    }
    if (input.bodyFile === undefined) return fail('--title needs --body-file: the issue body is the worker\'s brief')
    const bodyPath = resolve(input.bodyFile)
    if (!existsSync(bodyPath) || !statSync(bodyPath).isFile()) return fail(`--body-file is not a file: ${bodyPath}`)
  } else if (input.bodyFile !== undefined) {
    return fail('--body-file only goes with --title; an existing issue already has its body')
  }
  if (input.branch.trim().length === 0) return fail('--branch is required')
  if (input.branch.startsWith('-')) return fail(`--branch cannot start with "-", got: ${input.branch}`)

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

  const taskId = `t${run.tasks.length + 1}`

  // detectCycle skips ids it does not recognise, so a typo would otherwise pass
  // validation here and then wait in `queued` forever with no diagnostic. The
  // new task's own id counts as known — depending on yourself is a cycle, not
  // a typo, and must fall through to the cycle check below to be reported as one.
  const known = new Set([...run.tasks.map((t) => t.task_id), taskId])
  const unknown = input.dependsOn.filter((id) => !known.has(id))
  if (unknown.length > 0) return fail(`--depends-on names no such task: ${unknown.join(', ')}`)

  const cycle = detectCycle([...run.tasks, { task_id: taskId, depends_on: input.dependsOn }])
  if (cycle) return fail(`--depends-on forms a cycle: ${cycle.join(' → ')}`)

  // Last, after every check: an issue filed for a registration that then fails
  // is public, and nothing in the pipeline would ever close it.
  const filed = filing ? await attempt.fileIssueOnce(run.repo_root) : null
  if (filed !== null && 'error' in filed) {
    return fail(`gh issue create failed in ${run.repo_root}; nothing was filed or registered:\n  ${filed.error}`)
  }
  const issue = filed?.number ?? input.issue

  const date = new Date().toISOString().slice(0, 10)
  const stem = `${date}-issue-${issue}`

  const task: Task = {
    task_id: taskId,
    branch: input.branch, issue, surface: input.surface,
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

  run.tasks.push(task)
  // execute completes only once intake is closed and every task is terminal, so a
  // task registered mid-run must reopen the gate or the run could complete underneath it.
  run.intake_closed = false

  // The CLI is handing the prompt over now, so the task is dispatched. Leaving it
  // `queued` would make the next tick deliver the same prompt a second time. One
  // save for registration and dispatch together: a stale second save would make
  // the retry register the task twice.
  const gate = gateStatus(task, run.tasks)
  if (gate.state === 'ready') {
    enterTaskPhase(run, task, taskRow('queued').onClear as TaskPhase, 'dispatched at registration')
  }
  await saveRun(ctx.stateDir, run)
  attempt.landed(task.task_id)

  // The recorded set, printed back. A malformed --files is otherwise invisible:
  // the only other place task.files reaches a human is the blocked-on-files
  // warning in status.ts, which speaks only once overlap has already fired — so a
  // declaration that matches nothing is silent by construction.
  const filesLine = `files: ${task.files.length > 0 ? task.files.join(', ') : 'none'}`

  // The same line the supervisor's dispatch prompt prints, on the path that
  // actually dispatches: 17 of the last 20 tasks left `queued` here, not in the
  // supervisor's tick. Measured on the live ledger.
  const bootLine = bootstrapLine(repoBootstrap(run.repo_root))

  const header = [`task_id: ${task.task_id}`, ...(filed ? [`issue: #${issue} (filed)`] : []), filesLine, bootLine]
    .join('\n')

  if (gate.state !== 'ready') return ok(`${header}\nqueued: waiting on ${gate.on.join(', ')}`)

  const prompt = await renderWorkerPrompt(ctx.pluginRoot, run, task)
  return ok(`${header}\n\n${prompt}`)
}

export async function cmdTask(
  ctx: Ctx, input: TaskInput, fileIssue: FileIssue = fileIssueWithGh,
): Promise<CmdResult> {
  // The retry re-runs registerTask from a fresh read, so the gh call is memoized
  // out here: a second attempt reuses the issue the first one filed, never files another.
  const outcome: { filing: Promise<FiledIssue | GhFailure> | null; registeredAs: string | null } = {
    filing: null, registeredAs: null,
  }
  const attempt: RegistrationAttempt = {
    fileIssueOnce: (repoRoot) =>
      (outcome.filing ??= fileIssue(repoRoot, input.title!, resolve(input.bodyFile!))),
    landed: (taskId) => { outcome.registeredAs = taskId },
  }
  const filedIssue = async (): Promise<FiledIssue | null> => {
    const filed = outcome.filing === null ? null : await outcome.filing
    return filed === null || 'error' in filed ? null : filed
  }

  let reason: string
  try {
    const result = await retryOnStaleRun(() => registerTask(ctx, input, attempt))
    if (result.ok) return result
    reason = result.text
  } catch (error) {
    const filed = await filedIssue()
    if (filed === null) {
      if (isUnlandedSave(error)) return fail(unlandedSaveMessage(error))
      throw error
    }
    // Not unlandedSaveMessage: its "run it again" would file a second issue.
    reason = error instanceof Error ? error.message : String(error)
  }

  const filed = await filedIssue()
  if (filed === null) return fail(reason)
  if (outcome.registeredAs !== null) {
    return fail(
      `task ${outcome.registeredAs} is registered with issue #${filed.number} (${filed.url}), but: ${reason}\n` +
      `  → hpipe brief --task ${outcome.registeredAs} prints its brief; do not register it again`,
    )
  }
  return fail(
    `${reason}\nissue #${filed.number} was filed (${filed.url}) but no task was registered\n` +
    `  → register it with --issue ${filed.number} in place of --title and --body-file; ` +
    're-running with --title files a second issue',
  )
}

/**
 * Read-only. Without it the only way to see a worker brief is to register a
 * task, which mutates the run — so an orchestrator that loses its context has
 * no way back to the text it is supposed to hand over. Measured on a live run.
 */
export async function cmdBrief(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named', escape: '--run <run-id> renders it anyway',
  })
  if (!found.ok) return found.result

  return ok(await renderWorkerPrompt(ctx.pluginRoot, found.value.run, found.value.task))
}

/** Read-only, and reaches a finished run under --run, like `brief`. */
export async function cmdShow(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named', escape: '--run <run-id> shows it anyway',
  })
  if (!found.ok) return found.result
  return ok(formatTaskDetail(found.value.run, found.value.task))
}

export type SendBrief = (paneId: string, text: string) => Promise<CallResult<unknown>>

/**
 * The handoff `agent start "<brief>"` could not make: herdr refuses to encode a
 * brief's fences and backticks as a shell argument, which fails every task. The
 * brief goes over `agent prompt` instead, the same channel the supervisor uses
 * for every later phase. Measured on a live run.
 */
export async function cmdDispatchTask(ctx: Ctx, input: {
  taskId: string; paneId: string; repoKey: string | null; runId: string | null
}, send: SendBrief, recordPane: typeof recordWorkerPane = recordWorkerPane): Promise<CmdResult> {
  // Not `driven`, unlike decide: this command delivers the brief itself, and the
  // worker's artifacts are stat'ed on the first tick after the rewind. Refusing
  // would strand the opposite way, since registration already moved the task past
  // `queued` and nothing else ever re-sends a brief to its fresh pane.
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'unfinished', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (input.paneId.trim().length === 0) {
    return fail('--pane is required: the root pane `worktree create` returned')
  }

  // A queued task's files or dependencies are still held; starting its worker
  // now is exactly the parallel edit `--files` and `--depends-on` exist to stop.
  if (task.phase === 'queued') {
    const gate = gateStatus(task, run.tasks)
    const waitingOn = gate.state === 'ready' ? '' : `: waiting on ${gate.on.join(', ')}`
    return fail(`task ${task.task_id} is still queued${waitingOn} — you will be told when it is ready`)
  }
  if (taskPhaseIsTerminal(task.phase)) {
    return fail(`task ${task.task_id} is finished (phase: ${task.phase}) — there is no worker to brief`)
  }
  // Past the gate's first phase a worker already holds the brief. Re-sending it
  // would restart that worker's instructions mid-phase, and `--until working`
  // matches at once on a busy agent, so the confirmation would prove nothing.
  const briefedPhase = taskRow('queued').onClear as TaskPhase
  if (task.phase !== briefedPhase) {
    return fail(`task ${task.task_id} is already in ${task.phase}, past ${briefedPhase} — ` +
      `its worker has the brief; \`hpipe brief --task ${task.task_id}\` prints it to reread`)
  }

  // Checked before the send, because a brief sent to the wrong pane cannot be
  // recalled, and a pane recorded on the wrong task routes that pane's events —
  // exit, release, idle — to whichever of the two `findTask` meets first.
  if (input.paneId === run.orchestrator_pane) {
    return fail(`${input.paneId} is this run's orchestrator pane — pass the worker's root pane`)
  }
  const holder = run.tasks.find((t) => t.task_id !== task.task_id && t.pane_id === input.paneId)
  if (holder) {
    return fail(`${input.paneId} is already ${holder.task_id}'s worker pane — pass ${task.task_id}'s ` +
      'root pane, from `herdr pane list --workspace <its workspace>`')
  }

  const brief = await renderWorkerPrompt(ctx.pluginRoot, run, task)
  const sent = await send(input.paneId, brief)
  if (!sent.ok) {
    const reason = `brief for ${task.task_id} not confirmed in ${input.paneId}: ` +
      `${sent.code ?? 'error'}${sent.message ? ` — ${sent.message}` : ''}`
    // Only these two come back after herdr accepted the text; every other code
    // is a rejection before anything reached the pane.
    const mayHaveLanded = sent.code === 'agent_prompt_stalled' || sent.code === 'timeout'
    return fail(mayHaveLanded
      ? `${reason}\n  → herdr pane read ${input.paneId} before retrying: the brief was ` +
        'submitted and may already be in the pane, and a retry would send it twice'
      : `${reason}\n  → nothing was sent; fix the cause and run it again`)
  }

  const delivered = `brief for ${task.task_id} delivered to ${input.paneId}; the worker has picked it up`
  const unrecorded = await recordPane(ctx, {
    runId: run.run_id, taskId: task.task_id, paneId: input.paneId, briefedPhase,
  })
  if (unrecorded === null) return ok(delivered)
  // Still `ok`, and never "run it again": the brief has landed, and a re-run is
  // let through by the briefed-phase guard and would hand the worker a second one.
  return ok(`${delivered}\n  ⚠ but its pane was not recorded (${unrecorded}). Do not run ` +
    '`dispatch --task` again — that would brief the worker twice. The pane binds on its own ' +
    'once herdr reports the agent.')
}

/**
 * Written only after herdr confirmed the handoff, and re-read rather than reusing
 * the copy the send began with: the supervisor saves the run many times during
 * a confirmation wait. Recording the pane here, as well as on
 * `pane.agent_detected`, is what keeps a lost hook event from leaving a briefed
 * worker looking as though no agent was ever started for it. Returns why the
 * pane was not recorded, or null.
 */
export async function recordWorkerPane(ctx: Ctx, input: {
  runId: string; taskId: string; paneId: string; briefedPhase: TaskPhase
}, save: (stateDir: string, run: Run) => Promise<void> = saveRun): Promise<string | null> {
  try {
    return await retryOnStaleRun(async () => {
      const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
      const task = run?.tasks.find((t) => t.task_id === input.taskId)
      if (!run || !task) return `${input.taskId} is gone from the ledger`
      // A pane that exited during the confirmation wait has already failed the
      // task and been unbound; binding it again would make a rewind read as bound.
      if (task.phase !== input.briefedPhase) return null
      if (bindWorkerPane(run, task, input.paneId, Date.now())) await save(ctx.stateDir, run)
      return null
    })
  } catch (error) {
    if (isUnlandedSave(error)) return 'the ledger kept changing under the save'
    throw error
  }
}

async function closeIntake(ctx: Ctx, input: {
  runId: string | null; repoKey: string | null
}): Promise<CmdResult> {
  const query: RunQuery = {
    runId: input.runId, repoKey: input.repoKey,
    phases: REGISTRABLE, taskId: null, reach: 'unfinished',
  }
  const found = await resolveFor(ctx, query, null)
  if (!found.ok) return found.result

  const run = found.value
  run.intake_closed = true
  await saveRun(ctx.stateDir, run)
  return ok(`intake closed for ${run.run_id}`)
}
export const cmdDispatchDone = retryingOnStale(closeIntake)

async function rewind(ctx: Ctx, input: {
  runId: string; phase: string; taskId: string | null
}): Promise<CmdResult> {
  const run = await runById(ctx.stateDir, ctx.session, input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  // The phase is written onto the record unvalidated today, and every later row
  // lookup throws on one that is in no row — including the terminal test below.
  // `isTask` is shared with the branch below, which tests truthiness: flag() can
  // return '', and validating against TASK_ROWS then writing to run.phase is
  // exactly the mismatch this check exists to close.
  const isTask = Boolean(input.taskId)
  const rows = isTask ? TASK_ROWS : RUN_ROWS
  if (!rows.some((r) => r.phase === input.phase)) {
    return fail(`no such phase: ${input.phase || '(missing)'} — valid ` +
      `${isTask ? 'task' : 'run'} phases are ${rows.map((r) => r.phase).join(', ')}`)
  }

  // A rewind ONTO a review row commissions a new review but renders no prompt —
  // `advanceTask` returns null for a row whose verdict is not fresh, so the task
  // loop never reaches `promptForTaskPhase`. Without reserving here the next review
  // is handed the previous one's filename, which is this issue.
  let reserved: string | null = null

  if (isTask) {
    const task = run.tasks.find((t) => t.task_id === input.taskId)
    if (!task) return fail(`no such task: ${input.taskId}`)

    if (task.pending_answer !== null) {
      run.history.push({
        at: Date.now(), task_id: task.task_id, from: task.phase, to: input.phase,
        why: `answer to ${task.pending_answer} discarded, undelivered`,
      })
      task.pending_answer = null
    }

    // A terminal rewind ends every question addressed to this task; otherwise
    // openDecisionFor keeps hpipe status reporting a decision the task can never
    // return to. `escalated` is deliberately excluded — it carries returnsTo, so
    // it can come back still needing its answer. After the block above, so an
    // answered-but-undelivered decision keeps its own history entry rather than
    // being abandoned silently.
    if (taskPhaseIsTerminal(input.phase)) {
      const open = openDecisionFor(task)
      abandonDecisions(task)
      if (open) {
        run.history.push({
          at: Date.now(), task_id: task.task_id, from: task.phase, to: input.phase,
          why: `decision ${open.id} abandoned, unanswered`,
        })
      }
    }

    task.phase = input.phase as TaskPhase
    task.passes = {}
    task.delivery_attempts = 0
    task.phase_entered_at = Date.now()
    task.escalated_from = null
    // `implement` persists the first PR it finds and never asks again, and `merge`
    // is a level: a task sent back to rework after its PR merged would otherwise
    // carry the old PR through `merge` on its old mergedAt, with the new work
    // never merged. `prForBranch` lists open PRs only, so it finds the new one.
    if (PHASES_BEFORE_A_PR.has(task.phase)) {
      task.pr = null
      task.ci = null
      task.head_sha_at_entry = null
      task.merged_at_ms = null
      task.issue_closed_at_entry = false
    }
    run.history.push({ at: Date.now(), task_id: task.task_id, from: 'rewind', to: input.phase, why: 'manual rewind' })
    if (taskRow(task.phase).signal === 'verdict') {
      reserved = reserveVerdict(run, task, task.phase)
    }
  } else {
    run.phase = input.phase as RunPhase
    run.passes = {}
    run.phase_entered_at = Date.now()
    run.escalated_from = null
    run.history.push({ at: Date.now(), from: 'rewind', to: input.phase, why: 'manual rewind' })
    if (runRow(run.phase).signal === 'verdict') {
      reserved = reserveVerdict(run, null, run.phase)
    }
  }

  await saveRun(ctx.stateDir, run)
  return ok(
    `rewound ${input.taskId ?? input.runId} to ${input.phase}; counters cleared` +
    (reserved === null ? '' : `; next verdict → ${reserved}`),
  )
}
export const cmdRewind = retryingOnStale(rewind)

async function release(ctx: Ctx, input: {
  taskId: string; repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.taskId, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named', escape: '--run <run-id> releases it anyway',
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  // `escalated` is not `terminal` — it carries `escalated_from` so a human can
  // rewind it — but it has stopped moving and is a legitimate release target too.
  if (!taskRow(task.phase).terminal && task.phase !== 'escalated') {
    return fail(`task ${input.taskId} is still in flight (${task.phase})`)
  }

  task.files = []
  await saveRun(ctx.stateDir, run)
  return ok(`released ${input.taskId}; files reservation cleared`)
}
export const cmdRelease = retryingOnStale(release)

async function decide(ctx: Ctx, input: {
  task: string; question: string; recommendation: string
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  // Alone among the four, this refuses a finished run even when named: opening a
  // decision on one strands the question, because neither `rewind` (it leaves
  // run.phase alone) nor `resume` (it needs a prior abort) can get a worker back.
  // A parked run strands it too, until rewound: the supervisor announces nothing
  // on one, so the orchestrator never hears the question.
  const found = await resolveTask(ctx, {
    taskId: input.task, repoKey: input.repoKey, runId: input.runId,
    reach: 'driven', escape: null,
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

  if (input.recommendation.trim().length === 0) {
    return fail('--recommend is required: a bare question pushes the call up to the orchestrator')
  }

  // decision_from records where the worker actually was; a second call while
  // already blocked-on-decision would overwrite it with 'blocked-on-decision'
  // itself, stranding the task with no phase to rewind back to.
  if (task.phase === 'blocked-on-decision') {
    return fail(`task ${input.task} already has an open decision: ${openDecisionFor(task)?.id}`)
  }

  // Mirrors cmdAnswer's guard. Nothing should move a finished task into a live
  // phase; #38 did exactly that to two tasks whose worktrees were already gone.
  if (taskPhaseIsTerminal(task.phase)) {
    return fail(`task ${input.task} is finished (phase: ${task.phase}) — ` +
      'it cannot be blocked on a decision')
  }

  task.decision_from = task.phase
  const decision = openDecision(task, { question: input.question, recommendation: input.recommendation })
  enterTaskPhase(run, task, 'blocked-on-decision', 'worker surfaced a decision')
  await saveRun(ctx.stateDir, run)
  return ok(`opened decision ${decision.id} on ${input.task}; task blocked-on-decision`)
}
export const cmdDecide = retryingOnStale(decide)

async function answer(ctx: Ctx, input: {
  task: string; decision: string; answer: string; by: 'orchestrator' | 'human'
  repoKey: string | null; runId: string | null
}): Promise<CmdResult> {
  const found = await resolveTask(ctx, {
    taskId: input.task, repoKey: input.repoKey, runId: input.runId,
    reach: 'finished-if-named',
    escape: '--run <run-id> records an answer on it anyway',
  })
  if (!found.ok) return found.result
  const { run, task } = found.value

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
export const cmdAnswer = retryingOnStale(answer)

export async function cmdStatus(ctx: Ctx): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const state = await supervisorState(ctx.stateDir, ctx.session)
  const livePanes = new Set((await new Herdr().paneList()).map((p) => p.pane_id))
  return ok(formatStatus(
    runs,
    { state: state.state, pid: 'info' in state ? state.info.pid : undefined },
    ctx.session,
    hpipeCommand(ctx.pluginRoot),
    livePanes,
  ))
}

export async function cmdDrain(ctx: Ctx): Promise<CmdResult> {
  const events = await drain(join(ctx.stateDir, 'queue', ctx.session))
  return ok(events.length === 0 ? 'queue empty' : JSON.stringify(events, null, 2))
}

async function abort(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = await runById(ctx.stateDir, ctx.session, input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  // Record where it was so resume can put it back. Worktrees and branches are untouched.
  run.history.push({ at: Date.now(), from: run.phase, to: 'done', why: `aborted from ${run.phase}` })
  run.escalated_from = run.phase
  run.phase = 'done'
  await saveRun(ctx.stateDir, run)
  return ok(`aborted ${run.run_id}; worktrees and branches left alone. Undo: hpipe resume ${run.run_id}`)
}
export const cmdAbort = retryingOnStale(abort)

async function resume(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = await runById(ctx.stateDir, ctx.session, input.runId)
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
export const cmdResume = retryingOnStale(resume)

async function forget(ctx: Ctx, input: { workspaceId: string }): Promise<CmdResult> {
  const run = await runForWorkspace(ctx.stateDir, ctx.session, input.workspaceId)
  const task = run?.tasks.find((t) => t.workspace_id === input.workspaceId)
  if (!run || !task) return fail(`no task is bound to ${input.workspaceId}`)

  task.workspace_id = null
  task.pane_id = null
  await saveRun(ctx.stateDir, run)
  return ok(`unbound ${input.workspaceId} from ${task.task_id}`)
}
export const cmdForget = retryingOnStale(forget)

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

const USAGE: Record<string, string[]> = {
  start: ['hpipe start <title>'],
  task: ['hpipe task --branch <branch> (--issue <n> | --title <title> --body-file <path>) --surface <surface> ' +
    '[--depends-on <id,id>] [--files <prefix,prefix>] [--notes <text>] [--keep-worktree] [--run <run-id>]'],
  brief: ['hpipe brief --task <id> [--run <run-id>]'],
  show: ['hpipe show --task <id> [--run <run-id>]'],
  dispatch: [
    'hpipe dispatch --task <id> --pane <pane-id> [--run <run-id>]',
    'hpipe dispatch --done [--run <run-id>]',
  ],
  status: ['hpipe status'],
  drain: ['hpipe drain'],
  rewind: ['hpipe rewind <run-id> <phase> [--task <id>]'],
  release: ['hpipe release --task <id> [--run <run-id>]'],
  decide: ['hpipe decide --task <id> --question <text> --recommend <text> [--run <run-id>]'],
  answer: ['hpipe answer --task <id> --decision <id> --answer <text> --by orchestrator|human [--run <run-id>]'],
  resume: ['hpipe resume <run-id>'],
  abort: ['hpipe abort <run-id>'],
  forget: ['hpipe forget <workspace-id>'],
}

const commandUsage = (forms: string[]): string => `usage: ${forms.join('\n       ')}`

const fullUsage = (): string =>
  `usage: hpipe <${Object.keys(USAGE).join('|')}> …\n\n` +
  Object.values(USAGE).flat().map((form) => `  ${form}`).join('\n')

const HELP_FLAGS = new Set(['--help', '-h'])
const VALUELESS_FLAGS = new Set(['--done', '--keep-worktree', ...HELP_FLAGS])
// Prose can legitimately be `-h`. An identifier never can: taking one as a value
// registered a task on branch `-h`.
const FREE_TEXT_FLAGS = new Set(['--question', '--recommend', '--answer', '--notes', '--title'])
// cmdTask names this one's argv accident more precisely than a usage line can.
const SELF_VALIDATING_FLAGS = new Set(['--files'])

const wantsHelp = (args: string[]): boolean => args.some((arg, i) => {
  if (!HELP_FLAGS.has(arg)) return false
  const previous = args[i - 1]
  return previous === undefined || !FREE_TEXT_FLAGS.has(previous)
})

/** The first identifier flag whose value is missing or looks like a flag. */
function identifierWithoutValue(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const name = args[i] as string
    if (!name.startsWith('--') || VALUELESS_FLAGS.has(name)) continue
    if (FREE_TEXT_FLAGS.has(name) || SELF_VALIDATING_FLAGS.has(name)) { i++; continue }
    const value = args[i + 1]
    if (value === undefined || value.startsWith('-')) return name
    i++
  }
  return null
}

const DISPATCH_CONFIRM_TIMEOUT_MS = 30_000

async function dispatch(argv: string[]): Promise<number> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
    ?? join(process.env.HOME ?? '', '.local/state/herdr/plugins/stein.pipeline')
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, '..')
  const ctx: Ctx = { stateDir, pluginRoot, session: sessionKey() }
  const [command, ...rest] = argv

  if (command === 'help' || (command !== undefined && HELP_FLAGS.has(command))) {
    console.log(fullUsage())
    return 0
  }
  const usage = command !== undefined && Object.hasOwn(USAGE, command) ? USAGE[command] : undefined
  if (command === undefined || usage === undefined) {
    console.error(fullUsage())
    return 1
  }
  // Before the repo lookup and every write: `start --help` used to open a run
  // titled "--help", and `resume --help` looked for a run with that id.
  if (wantsHelp(rest)) {
    console.log(commandUsage(usage))
    return 0
  }
  if (command === 'dispatch' && rest.includes('--done') === (flag(rest, 'task') !== null)) {
    console.error(commandUsage(usage))
    return 1
  }
  const valueless = command === 'start' ? null : identifierWithoutValue(rest)
  if (valueless !== null) {
    console.error(`hpipe: ${valueless} needs a value\n${commandUsage(usage)}`)
    return 1
  }

  // Every command that resolves a run needs the caller's repo to filter by, so
  // this is a deny-list, not an allow-list: a new command is assumed to resolve.
  // Get it wrong that way and it fails loudly outside a repo; get an allow-list
  // wrong and the new command silently gets repoKey: null, which is #21 again
  // with no error anywhere. These six address a run by id, or not at all.
  const byIdOrNothing = ['status', 'drain', 'abort', 'resume', 'forget', 'rewind']
  // --run names the run outright, so the lookup is skipped; `start` has no --run.
  const needsRepo = command === 'start' ||
    (!byIdOrNothing.includes(command ?? '') && flag(rest, 'run') === null)
  const repo = needsRepo ? await repoContext() : null
  if (needsRepo && !repo) {
    console.error(command === 'start'
      ? 'hpipe: not inside a git repository'
      : 'hpipe: not inside a git repository — run it from the repo whose run you mean, or pass --run <run-id>')
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
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
        title: flag(rest, 'title') ?? undefined,
        bodyFile: flag(rest, 'body-file') ?? undefined,
      })
      break

    case 'brief':
      out = await cmdBrief(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'show':
      out = await cmdShow(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'dispatch':
      if (rest.includes('--done')) {
        out = await cmdDispatchDone(ctx, {
          runId: flag(rest, 'run'), repoKey: repo?.repoKey ?? null,
        })
        break
      }
      out = await cmdDispatchTask(ctx, {
        taskId: flag(rest, 'task')!,
        paneId: flag(rest, 'pane') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      }, (paneId, text) => new Herdr().agentPromptConfirmed(paneId, text, DISPATCH_CONFIRM_TIMEOUT_MS))
      break

    case 'rewind':
      out = await cmdRewind(ctx, {
        runId: rest[0] ?? '', phase: rest[1] ?? '', taskId: flag(rest, 'task'),
      })
      break

    case 'release':
      out = await cmdRelease(ctx, {
        taskId: flag(rest, 'task') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'decide':
      out = await cmdDecide(ctx, {
        task: flag(rest, 'task') ?? '',
        question: flag(rest, 'question') ?? '',
        recommendation: flag(rest, 'recommend') ?? '',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'answer':
      out = await cmdAnswer(ctx, {
        task: flag(rest, 'task') ?? '',
        decision: flag(rest, 'decision') ?? '',
        answer: flag(rest, 'answer') ?? '',
        by: (flag(rest, 'by') ?? '') as 'orchestrator' | 'human',
        repoKey: repo?.repoKey ?? null,
        runId: flag(rest, 'run'),
      })
      break

    case 'status': out = await cmdStatus(ctx); break
    case 'drain': out = await cmdDrain(ctx); break
    case 'abort': out = await cmdAbort(ctx, { runId: rest[0] ?? '' }); break
    case 'resume': out = await cmdResume(ctx, { runId: rest[0] ?? '' }); break
    case 'forget': out = await cmdForget(ctx, { workspaceId: rest[0] ?? '' }); break

    default:
      console.error(fullUsage())
      return 1
  }

  console.log(out.text)
  return out.ok ? 0 : 1
}

if (import.meta.main) process.exit(await dispatch(process.argv.slice(2)))
