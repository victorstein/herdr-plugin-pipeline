import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha8 } from './batch'
import { BOOTSTRAP_REL, repoBootstrap } from './bootstrap'
import type { CheckRun } from './check'
import { type DispatchBase, describeBase } from './dispatch-base'
import type { DispatchStep } from './dispatch-lock'
import {
  type AgentStartRequest, type CallResult, type CreatedWorktree, type Listing, type PaneInfo, paneHasNoAgent,
  type WorkspaceInfo, type WorktreeEntry,
} from './herdr'
import { taskPhaseIsTerminal } from './ledger'
import { isAgentReady } from './machine'
import { WORKER_EFFORT } from './models'
import { taskRow, tierOf } from './phases'
import { inputBoxText, SCREEN_LINES, withoutFaintText } from './screen'
import type { AgentStatus, Run, Task } from './types'
import { shellQuoted, startAgentCommand, unbriefedWorker, workerAgentArgs } from './unstarted'

/** A safety net, not a budget: a bootstrap hung on a prompt would hold the repo's dispatch lock for good. */
export const BOOTSTRAP_DEADLINE_MS = 20 * 60_000
export const AGENT_START_TIMEOUT_MS = 80_000
/** Past herdr's own timeout, for a CLI that never returns. */
export const AGENT_START_BOUND_MS = 90_000
/** The supervisor binds a new worktree within a tick. */
const BINDING_WAIT_MS = 15_000
const READY_WAIT_MS = 30_000
const POLL_MS = 1_000

export interface DispatchHerdr {
  workspaceListing(): Promise<Listing<WorkspaceInfo>>
  worktreeList(repoRoot: string): Promise<Listing<WorktreeEntry>>
  worktreeCreate(repoRoot: string, branch: string, base: string): Promise<CallResult<CreatedWorktree>>
  paneListing(workspaceId: string): Promise<Listing<PaneInfo>>
  agentPane(name: string): Promise<string | null>
  agentStart(request: AgentStartRequest): Promise<CallResult<unknown>>
  agentStatus(paneId: string): Promise<AgentStatus>
  paneReadStyled(paneId: string, lines: number): Promise<string>
}

export interface DispatchGit {
  /** What `refs/heads/<branch>` names: null when there is no such branch, undefined when git could not say. */
  branchCommit(repoRoot: string, branch: string): Promise<string | null | undefined>
  /** Null when git could not say. */
  contains(repoRoot: string, ancestor: string, of: string): Promise<boolean | null>
}

export interface DispatchLedger {
  /** The run and task as they are on disk now. */
  reread(runId: string, taskId: string): Promise<{ run: Run; task: Task } | null>
  setBootstrapped(runId: string, taskId: string, record: { checkout: string; at: number } | null): Promise<void>
  /** Why the pane was not recorded, or null. */
  recordPane(runId: string, taskId: string, paneId: string): Promise<string | null>
  sessionRuns(): Promise<Run[]>
  orchestratorPanes(): Promise<ReadonlySet<string>>
}

export interface BriefOutcome { ok: boolean; text: string }

export interface DispatchDeps {
  herdr: DispatchHerdr
  git: DispatchGit
  ledger: DispatchLedger
  base(run: Run, task: Task): Promise<DispatchBase>
  runBootstrap(checkout: string, logPath: string): Promise<CheckRun>
  bootstrapLog(task: Task): string
  /** Claims the bead, sends the brief and records the pane: the manual `--pane` form's own handover. */
  brief(run: Run, task: Task, paneId: string): Promise<BriefOutcome>
  /** Called as each step begins; the dispatch lock names it. */
  at(taskId: string, step: DispatchStep): Promise<void>
  say(line: string): void
  now(): number
  sleep(ms: number): Promise<void>
  hpipe: string
}

/** herdr may answer with a path whose symlinks it resolved, and the ledger may hold either form. */
function samePath(a: string, b: string): boolean {
  const real = (path: string): string => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return resolve(a) === resolve(b) || real(a) === real(b)
}

class Stop {
  constructor(readonly step: DispatchStep, readonly why: string) {}
}

interface Placed {
  workspaceId: string
  checkout: string
  created: CreatedWorktree | null
}

const nothingStarted = (why: string): string => `${why}; nothing was started`

class TaskDispatch {
  private readonly id: string

  constructor(private run: Run, private task: Task, private readonly deps: DispatchDeps) {
    this.id = task.task_id
  }

  private line(step: DispatchStep, text: string): void {
    this.deps.say(`  ${step.padEnd(10)} ${text}`)
  }

  private openRoute(): string {
    return `\`herdr worktree open --cwd ${shellQuoted(this.run.repo_root)} --branch ${this.task.branch}\``
  }

  async dispatch(): Promise<boolean> {
    const { deps, task } = this
    const tier = tierOf(task)
    deps.say(`${this.id} ${task.branch} (${task.bead}) — ${tier}, worker effort ${WORKER_EFFORT[tier]}`)
    try {
      const base = await this.base()
      const placed = await this.worktree(base)
      const pane = await this.pane(placed)
      await this.bootstrap(placed, pane.paneId, pane.agentAlready)
      const startedHere = await this.agent(placed, pane.paneId)
      await this.brief(pane.paneId, startedHere)
    } catch (error) {
      if (!(error instanceof Stop)) throw error
      deps.say(`stopped ${this.id} at ${error.step}: ${error.why}`)
      return false
    }
    deps.say(`dispatched ${this.id}`)
    return true
  }

  private async base(): Promise<string> {
    await this.deps.at(this.id, 'base')
    const base = await this.deps.base(this.run, this.task)
    if (base.fetchError !== null) {
      throw new Stop('base', `the fetch failed (${base.fetchError}), and a stale base would cut the worktree without ` +
        'what merged since; run this again once origin answers')
    }
    if (base.commit === null) throw new Stop('base', `no commit resolves for ${base.ref}; nothing was started`)
    this.line('base', `${sha8(base.commit)} (${describeBase(base)})`)
    return base.commit
  }

  private async worktree(base: string): Promise<Placed> {
    await this.deps.at(this.id, 'worktree')
    if (this.task.workspace_id !== null) return this.boundWorktree()

    const worktrees = await this.deps.herdr.worktreeList(this.run.repo_root)
    if (!worktrees.ok) {
      throw new Stop('worktree', `herdr worktree list --cwd ${shellQuoted(this.run.repo_root)} could not be read ` +
        `(${worktrees.reason}): with no list, a checkout of ${this.task.branch} cannot be told from none, so ` +
        'nothing was started')
    }
    const onBranch = worktrees.items.find((entry) => entry.branch === this.task.branch)
    if (onBranch !== undefined) {
      if (await this.awaitBinding()) return this.boundWorktree()
      throw new Stop('worktree', this.unboundCheckout(onBranch))
    }
    await this.refuseForeignBranch(base)
    return this.create(base)
  }

  /**
   * The ledger's binding comes from herdr's own `worktree.created`/`opened` payload
   * and is undone when the workspace closes, so it is the record that names the
   * workspace; `worktree list` carries no workspace id and can only confirm it.
   */
  private async boundWorktree(): Promise<Placed> {
    const { task, run } = this
    const workspaceId = task.workspace_id as string
    const checkout = task.checkout_path
    if (checkout === null) {
      throw new Stop('worktree', nothingStarted(`the ledger binds ${this.id} to ${workspaceId} but records no ` +
        'checkout for it, so herdr cannot confirm it'))
    }
    const [workspaces, worktrees] = await Promise.all([
      this.deps.herdr.workspaceListing(), this.deps.herdr.worktreeList(run.repo_root),
    ])
    if (!workspaces.ok) {
      throw new Stop('worktree', nothingStarted(`herdr workspace list could not be read (${workspaces.reason})`))
    }
    if (!worktrees.ok) {
      throw new Stop('worktree', nothingStarted(`herdr worktree list --cwd ${shellQuoted(run.repo_root)} could not ` +
        `be read (${worktrees.reason})`))
    }
    const said = `the ledger binds ${this.id} to ${workspaceId} at ${checkout}`
    const listed = workspaces.items.find((workspace) => workspace.workspace_id === workspaceId)
    if (listed === undefined) {
      throw new Stop('worktree', `${said}, but herdr lists no workspace ${workspaceId}. If it closed, ` +
        `\`${this.deps.hpipe} forget ${workspaceId}\` and bind the kept checkout with ${this.openRoute()}, then run ` +
        'this again. Nothing was started')
    }
    if (listed.worktree?.is_linked_worktree !== true) {
      throw new Stop('worktree', nothingStarted(`${said}, but herdr lists ${workspaceId} as no linked worktree`))
    }
    if (!samePath(listed.worktree.repo_root, checkout)) {
      throw new Stop('worktree', nothingStarted(`${said}, but herdr says ${workspaceId} is the checkout at ` +
        `${listed.worktree.repo_root}`))
    }
    const entry = worktrees.items.find((candidate) => samePath(candidate.path, checkout))
    if (entry === undefined) {
      throw new Stop('worktree', nothingStarted(`${said}, but herdr worktree list --cwd ` +
        `${shellQuoted(run.repo_root)} has no checkout at ${checkout}`))
    }
    if (entry.branch !== task.branch) {
      throw new Stop('worktree', nothingStarted(`${said}, but that checkout is on ${entry.branch ?? 'no branch'}, ` +
        `not ${task.branch}`))
    }
    if (entry.is_prunable || !entry.is_linked_worktree) {
      throw new Stop('worktree', nothingStarted(`${said}, but herdr lists that checkout as ` +
        (entry.is_prunable ? 'prunable: its directory is gone' : 'no linked worktree')))
    }
    return { workspaceId, checkout, created: null }
  }

  /** A re-run straight after this command's own create usually beats the supervisor's binding by a tick. */
  private async awaitBinding(): Promise<boolean> {
    for (let waited = 0; waited < BINDING_WAIT_MS; waited += POLL_MS) {
      await this.deps.sleep(POLL_MS)
      if (await this.reread() && this.task.workspace_id !== null) return true
    }
    return false
  }

  private unboundCheckout(entry: WorktreeEntry): string {
    const { branch } = this.task
    if (!entry.is_linked_worktree) {
      return `${branch} is checked out in the repo's own checkout at ${entry.path}: switch that checkout to another ` +
        'branch, then run this again. Nothing was started'
    }
    if (entry.is_prunable) {
      return `git still registers a checkout of ${branch} at ${entry.path}, whose directory is gone: ` +
        `\`git -C ${shellQuoted(this.run.repo_root)} worktree prune\`, then run this again. Nothing was started`
    }
    return `a checkout of ${branch} exists at ${entry.path}, but no workspace is bound to ${this.id}: ` +
      `${this.openRoute()} binds it; run this again once \`${this.deps.hpipe} show --task ${this.id}\` names a ` +
      'workspace. Nothing was started'
  }

  /**
   * `worktree create` on an existing branch checks it out rather than cutting it
   * from the base. Measured on herdr 0.9.0.
   */
  private async refuseForeignBranch(base: string): Promise<void> {
    const { branch } = this.task
    const existing = await this.deps.git.branchCommit(this.run.repo_root, branch)
    if (existing === undefined) {
      throw new Stop('worktree', nothingStarted(`git could not read refs/heads/${branch} in ${this.run.repo_root}`))
    }
    if (existing === null) return
    const contains = await this.deps.git.contains(this.run.repo_root, base, existing)
    if (contains === null) {
      throw new Stop('worktree', nothingStarted(`git could not tell whether \`${branch}\` contains the base ` +
        sha8(base)))
    }
    if (!contains) {
      throw new Stop('worktree', `\`${branch}\` already exists at ${sha8(existing)} and does not contain the base ` +
        `${sha8(base)}: it is not this task's; rename the task's branch or delete it. Nothing was started`)
    }
  }

  private async create(base: string): Promise<Placed> {
    const created = await this.deps.herdr.worktreeCreate(this.run.repo_root, this.task.branch, base)
    if (!created.ok || created.result === undefined) {
      if (created.code === 'unreadable_response') {
        const unread = created.message ?? 'its response could not be read'
        throw new Stop('worktree', `herdr may have created the worktree, but ${unread}: nothing was started. Run ` +
          `this again once \`${this.deps.hpipe} show --task ${this.id}\` names a workspace`)
      }
      throw new Stop('worktree', `herdr refused the worktree: ${created.code ?? 'error'}` +
        `${created.message ? ` — ${created.message}` : ''}. Nothing was started`)
    }
    await this.deps.ledger.setBootstrapped(this.run.run_id, this.id, null)
    return { workspaceId: created.result.workspaceId, checkout: created.result.path, created: created.result }
  }

  private async pane(placed: Placed): Promise<{ paneId: string; agentAlready: boolean }> {
    await this.deps.at(this.id, 'pane')
    const { created } = placed
    if (created !== null) {
      this.line('worktree', `created ${created.workspaceId} at ${created.path}, pane ${created.paneId}`)
    }
    const chosen = created === null ? await this.chosenPane(placed) : await this.createdPane(created)
    if (created === null) {
      this.line('worktree', `${placed.workspaceId} at ${placed.checkout} exists (pane ${chosen.paneId}) — skipped`)
    }
    await this.guard(chosen.paneId)
    return chosen
  }

  /** The ledger has not caught up with this command's own create, so the guard checks against its response. */
  private async createdPane(created: CreatedWorktree): Promise<{ paneId: string; agentAlready: boolean }> {
    await this.reread()
    const { workspace_id: workspaceId, checkout_path: checkout } = this.task
    const disagrees = (workspaceId !== null && workspaceId !== created.workspaceId) ||
      (checkout !== null && !samePath(checkout, created.path))
    if (disagrees) {
      throw new Stop('pane', nothingStarted(`herdr created ${created.workspaceId} at ${created.path}, but the ledger ` +
        `now binds ${this.id} to ${workspaceId ?? 'no workspace'} at ${checkout ?? 'no checkout'}`))
    }
    return { paneId: created.paneId, agentAlready: false }
  }

  private async chosenPane(placed: Placed): Promise<{ paneId: string; agentAlready: boolean }> {
    const { workspaceId } = placed
    const panes = await this.deps.herdr.paneListing(workspaceId)
    if (!panes.ok) {
      throw new Stop('pane', nothingStarted(`herdr pane list --workspace ${workspaceId} could not be read ` +
        `(${panes.reason})`))
    }
    const recorded = panes.items.find((pane) => pane.pane_id === this.task.pane_id)
    const only = panes.items.length === 1 ? panes.items[0] : undefined
    const pane = recorded ?? only
    if (pane === undefined) {
      const count = panes.items.length === 0 ? `${workspaceId} has no pane`
        : `${workspaceId} has ${panes.items.length} panes and none is recorded as ${this.id}'s`
      throw new Stop('pane', `${count}: start its agent by hand and \`${this.deps.hpipe} dispatch --task ${this.id} ` +
        '--pane <pane>`; nothing was started')
    }
    return { paneId: pane.pane_id, agentAlready: !paneHasNoAgent(pane) }
  }

  /** An agent that skips permissions must never start in a pane that is not this task's. */
  private async guard(paneId: string): Promise<void> {
    const runs = await this.deps.ledger.sessionRuns()
    const orchestrators = await this.deps.ledger.orchestratorPanes()
    if (orchestrators.has(paneId) || runs.some((run) => run.orchestrator_pane === paneId)) {
      throw new Stop('pane', nothingStarted(`${paneId} is an orchestrator's pane`))
    }
    for (const run of runs) {
      const holder = run.tasks.find((task) => task.pane_id === paneId && !this.isThisTask(run, task) &&
        task.phase !== 'done' && !taskPhaseIsTerminal(task.phase))
      if (holder !== undefined) {
        throw new Stop('pane', nothingStarted(`${paneId} is ${holder.task_id}'s worker pane (run ${run.run_id})`))
      }
    }
  }

  private isThisTask(run: Run, task: Task): boolean {
    return run.run_id === this.run.run_id && task.task_id === this.id
  }

  private async bootstrap(placed: Placed, paneId: string, agentAlready: boolean): Promise<void> {
    await this.deps.at(this.id, 'bootstrap')
    if (agentAlready) {
      this.line('bootstrap', `skipped: an agent already runs in ${paneId}, so the checkout was set up before it ` +
        'started')
      return
    }
    const done = this.task.bootstrapped
    if (placed.created === null && done !== undefined && samePath(done.checkout, placed.checkout)) {
      this.line('bootstrap', 'passed in this checkout before — skipped')
      return
    }
    const declared = repoBootstrap(placed.checkout)
    if (declared.kind === 'not-executable') {
      throw new Stop('bootstrap', `${placed.checkout}/${BOOTSTRAP_REL} is not executable: ` +
        `\`chmod +x ${BOOTSTRAP_REL}\` on the default branch, or in the checkout, then run this again`)
    }
    if (declared.kind === 'none') {
      this.line('bootstrap', declared.unwired === undefined
        ? 'none declared'
        : `none wired: ./${declared.unwired} is here but is not run (an executable ${BOOTSTRAP_REL} that calls it ` +
          'would run in every new worktree)')
      return
    }
    const log = this.deps.bootstrapLog(this.task)
    const startedAt = this.deps.now()
    const ran = await this.deps.runBootstrap(placed.checkout, log)
    if (ran.timedOutAfterMs !== undefined) throw new Stop('bootstrap', this.handRoute(placed.checkout, paneId, ran))
    if (ran.code !== 0) {
      const tail = ran.tail.split('\n').map((line) => `      ${line}`).join('\n')
      throw new Stop('bootstrap', `./${BOOTSTRAP_REL} failed (exit ${ran.code}); fix what it names, then run this ` +
        `again (log: ${log}). Its last lines:\n${tail}`)
    }
    const record = { checkout: placed.checkout, at: this.deps.now() }
    await this.deps.ledger.setBootstrapped(this.run.run_id, this.id, record)
    const seconds = Math.round((this.deps.now() - startedAt) / 1000)
    this.line('bootstrap', `./${BOOTSTRAP_REL} passed in ${seconds}s (log: ${log})`)
  }

  /**
   * A hand-run bootstrap writes no `bootstrapped` record, so it is the agent in
   * the pane that tells the re-run the checkout is set up.
   */
  private handRoute(checkout: string, paneId: string, ran: CheckRun): string {
    const minutes = Math.round((ran.timedOutAfterMs ?? BOOTSTRAP_DEADLINE_MS) / 60_000)
    const byHand = `(cd ${shellQuoted(checkout)} && ./${BOOTSTRAP_REL})`
    return `the bootstrap did not finish within ${minutes} minutes and was stopped, with everything it started. If ` +
      `it really takes longer, run it by hand in the background, \`${byHand}\`, then ` +
      `\`${startAgentCommand(this.task, paneId)}\`, then \`${this.deps.hpipe} dispatch --task ${this.id}\``
  }

  /** Whether this run started the agent: only then does `working` prove nothing about a brief. */
  private async agent(placed: Placed, paneId: string): Promise<boolean> {
    await this.deps.at(this.id, 'agent')
    const panes = await this.deps.herdr.paneListing(placed.workspaceId)
    if (!panes.ok) {
      throw new Stop('agent', nothingStarted(`herdr pane list --workspace ${placed.workspaceId} could not be read ` +
        `(${panes.reason})`))
    }
    const pane = panes.items.find((candidate) => candidate.pane_id === paneId)
    if (pane === undefined) throw new Stop('agent', nothingStarted(`${paneId} is no longer in ${placed.workspaceId}`))
    const named = paneHasNoAgent(pane) ? await this.deps.herdr.agentPane(this.task.bead) : paneId
    if (named === paneId) {
      this.line('agent', `an agent already runs in ${paneId} — skipped`)
      return false
    }
    if (named !== null) {
      throw new Stop('agent', `an agent named ${this.task.bead} already runs in ${named} (an earlier dispatch of ` +
        `${this.id}?): close it, or \`${this.deps.hpipe} dispatch --task ${this.id} --pane ${named}\` to brief ` +
        'that one')
    }
    const started = await this.deps.herdr.agentStart({
      name: this.task.bead, kind: 'claude', paneId, timeoutMs: AGENT_START_TIMEOUT_MS, args: workerAgentArgs(this.task),
    })
    if (!started.ok) {
      const answer = `${started.code ?? 'error'}${started.message ? ` — ${started.message}` : ''}`
      throw new Stop('agent', `herdr agent start answered ${answer}: \`herdr pane read ${paneId}\`; a re-run skips ` +
        'the worktree and the bootstrap, and starts the agent unless one is in the pane')
    }
    this.line('agent', `started ${this.task.bead} in ${paneId} (--effort ${WORKER_EFFORT[tierOf(this.task)]})`)
    return true
  }

  /**
   * The box, not a memory of an earlier send, decides: after an uncertain send the
   * manual path's rule is to read the pane before retrying, since a retry sends the
   * brief twice, and no worker finishes research in the seconds since a send.
   */
  private async brief(paneId: string, startedHere: boolean): Promise<void> {
    await this.deps.at(this.id, 'brief')
    if (!(await this.reread())) throw new Stop('brief', `${this.id} is gone from the ledger; nothing was sent`)
    if (unbriefedWorker(this.run, this.task) === null) {
      if (this.task.phase !== taskRow('queued').onClear) {
        throw new Stop('brief', `${this.id} is now in ${this.task.phase}; nothing was sent`)
      }
      this.line('brief', `${this.id}'s worker already has it — skipped`)
      return
    }
    if (!startedHere && await this.deps.herdr.agentStatus(paneId) === 'working') {
      const unrecorded = await this.deps.ledger.recordPane(this.run.run_id, this.id, paneId)
      this.line('brief', `the agent in ${paneId} is working, so an earlier dispatch handed it the brief; ` +
        (unrecorded === null ? 'its pane is recorded' : `its pane was not recorded (${unrecorded})`))
      return
    }
    await this.awaitEmptyBox(paneId, startedHere ? READY_WAIT_MS : 0)
    const sent = await this.deps.brief(this.run, this.task, paneId)
    if (!sent.ok) throw new Stop('brief', sent.text)
    this.line('brief', sent.text)
  }

  private async awaitEmptyBox(paneId: string, waitMs: number): Promise<void> {
    for (let waited = 0; ; waited += POLL_MS) {
      const status = await this.deps.herdr.agentStatus(paneId)
      const box = isAgentReady(status)
        ? inputBoxText(withoutFaintText(await this.deps.herdr.paneReadStyled(paneId, SCREEN_LINES)))
        : null
      if (box === '') return
      if (waited >= waitMs) {
        if (box !== null) {
          throw new Stop('brief', `the input box of ${paneId} holds text: \`herdr pane read ${paneId}\`; if it is ` +
            `the brief, \`herdr agent send-keys ${paneId} ctrl+c\`, then run this again`)
        }
        const why = isAgentReady(status) ? 'no input box on screen' : `it reads ${status}`
        throw new Stop('brief', `the agent in ${paneId} is not ready (${why}): \`herdr pane read ${paneId}\`; ` +
          'nothing was sent')
      }
      await this.deps.sleep(POLL_MS)
    }
  }

  private async reread(): Promise<boolean> {
    const fresh = await this.deps.ledger.reread(this.run.run_id, this.id)
    if (fresh === null) return false
    this.run = fresh.run
    this.task = fresh.task
    return true
  }
}

/** Runs every step a task still needs, saying each as it goes; false when one stopped. */
export function dispatchTask(run: Run, task: Task, deps: DispatchDeps): Promise<boolean> {
  return new TaskDispatch(run, task, deps).dispatch()
}
