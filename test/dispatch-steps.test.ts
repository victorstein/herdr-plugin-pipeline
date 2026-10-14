import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CheckRun } from '../src/lib/check'
import type { DispatchBase } from '../src/lib/dispatch-base'
import {
  AGENT_START_TIMEOUT_MS, type DispatchDeps, dispatchTask, type DispatchHerdr,
} from '../src/lib/dispatch-steps'
import {
  type AgentStartRequest, type CallResult, type CreatedWorktree, HerdrTimeout, type Listing, type PaneInfo,
  type WorkspaceInfo, type WorktreeEntry,
} from '../src/lib/herdr'
import { newRun } from '../src/lib/ledger'
import type { AgentStatus, Run, Task } from '../src/lib/types'
import { beadTaskFields } from './helpers/bead-fields'

let root: string
let repo: string
let checkout: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-steps-'))
  repo = join(root, 'repo')
  checkout = join(root, 'worktrees', 'feat-x')
  mkdirSync(repo, { recursive: true })
  mkdirSync(checkout, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const BASE = '1fb8a43c00000000000000000000000000000000'
const FETCHED: DispatchBase = { commit: BASE, ref: 'origin/main', fetchError: null }
const EMPTY_BOX = ['transcript', '─'.repeat(20), '❯ ', '─'.repeat(20), ''].join('\n')
const BOX_WITH = (text: string) => ['─'.repeat(20), `❯ ${text}`, '─'.repeat(20)].join('\n')

function writeBootstrap(dir: string, executable = true): void {
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'pipeline-bootstrap'), '#!/bin/sh\n')
  chmodSync(join(dir, '.claude', 'pipeline-bootstrap'), executable ? 0o755 : 0o644)
}

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', bead: 'hp-1', surface: 'core', depends_on: [], files: [],
  keep_worktree: false, workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'research', awaiting_brief: true, phase_entered_at: 0, escalated_from: null, head_sha_at_entry: null,
  pr: null, ci: null, checkout_path: null, registered_at: 0, adopted_at: null,
  artifacts: { research: null, spec: null, plan: null, verdicts: {} },
  merged_at_ms: null, ...beadTaskFields(), passes: {}, decisions: [],
  decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '', tier: 'standard', ...over,
})

interface Fakes {
  workspaces: Listing<WorkspaceInfo>
  worktrees: Listing<WorktreeEntry>
  created: CallResult<CreatedWorktree>
  panes: Record<string, Listing<PaneInfo>>
  agentPane: string | null
  started: CallResult<unknown> | CallResult<unknown>[]
  statuses: AgentStatus[]
  screens: string[]
  branchCommit: string | null | undefined
  contains: boolean | null
  base: DispatchBase
  bootstrap: CheckRun
  brief: { ok: boolean; text: string }
  otherRuns: Run[]
  orchestratorPanes: string[]
  /** The ledger's task as a re-read finds it, from the n-th re-read on. */
  rereads: Array<Partial<Task>>
  /** What herdr's hook and lists do once `worktree create` succeeds: bind the task, list the new checkout. */
  createAppears: boolean
}

interface World {
  run: Run
  task: Task
  deps: DispatchDeps
  fakes: Fakes
  calls: string[]
  said: string[]
  slept: number[]
  bootstrapped: Array<{ checkout: string; at: number } | null>
}

function world(taskOver: Partial<Task> = {}, fakeOver: Partial<Fakes> = {}): World {
  const run = newRun({ session: 's', socketPath: '/sock', repoKey: repo, repoRoot: repo, title: 'a' })
  run.run_id = 'r1'
  run.phase = 'execute'
  run.orchestrator_pane = 'w1:p1'
  const task = mkTask(taskOver)
  run.tasks = [task]
  const fakes: Fakes = {
    workspaces: { ok: true, items: [] },
    worktrees: { ok: true, items: [{ path: repo, branch: 'main', is_linked_worktree: false, is_prunable: false }] },
    created: { ok: true, result: { workspaceId: 'w5', paneId: 'w5:p1', path: checkout } },
    panes: { w5: { ok: true, items: [{ pane_id: 'w5:p1', agent: null, agent_status: 'unknown' }] } },
    agentPane: null,
    started: { ok: true },
    statuses: ['idle'],
    screens: [EMPTY_BOX],
    branchCommit: null,
    contains: true,
    base: FETCHED,
    bootstrap: { code: 0, tail: '' },
    brief: { ok: true, text: 'claimed hp-1; delivered to w5:p1, and the worker is working on it' },
    otherRuns: [],
    orchestratorPanes: [],
    rereads: [],
    createAppears: true,
    ...fakeOver,
  }
  const calls: string[] = []
  const said: string[] = []
  const slept: number[] = []
  const bootstrapped: World['bootstrapped'] = []
  let rereadCount = 0
  let boundByHook: Partial<Task> = {}
  let statusIndex = 0
  let screenIndex = 0
  let startIndex = 0
  const next = <T>(list: T[], index: number): T => list[Math.min(index, list.length - 1)] as T

  const herdr: DispatchHerdr = {
    workspaceListing: async () => { calls.push('workspace list'); return fakes.workspaces },
    worktreeList: async (cwd) => { calls.push(`worktree list --cwd ${cwd}`); return fakes.worktrees },
    worktreeCreate: async (cwd, branch, base) => {
      calls.push(`worktree create --cwd ${cwd} --branch ${branch} --base ${base}`)
      const made = fakes.created.result
      if (fakes.created.ok && made !== undefined && fakes.createAppears) {
        boundByHook = { workspace_id: made.workspaceId, checkout_path: made.path }
        if (fakes.worktrees.ok) fakes.worktrees = { ok: true, items: [...fakes.worktrees.items, LINKED(made.path)] }
        if (fakes.workspaces.ok) {
          fakes.workspaces = { ok: true, items: [...fakes.workspaces.items, WORKSPACE(made.path, { workspace_id: made.workspaceId })] }
        }
      }
      return fakes.created
    },
    paneListing: async (ws) => {
      calls.push(`pane list --workspace ${ws}`)
      return fakes.panes[ws] ?? { ok: true, items: [] }
    },
    agentPane: async (name) => { calls.push(`agent get ${name}`); return fakes.agentPane },
    agentStart: async (request: AgentStartRequest) => {
      calls.push(`agent start ${request.name} --kind ${request.kind} --pane ${request.paneId} --timeout ` +
        `${request.timeoutMs} -- ${request.args.join(' ')}`)
      return Array.isArray(fakes.started) ? next(fakes.started, startIndex++) : fakes.started
    },
    agentStatus: async (pane) => { calls.push(`agent status ${pane}`); return next(fakes.statuses, statusIndex++) },
    paneReadStyled: async (pane) => { calls.push(`pane read ${pane}`); return next(fakes.screens, screenIndex++) },
  }
  const deps: DispatchDeps = {
    herdr,
    git: {
      branchCommit: async (_repo, branch) => { calls.push(`git branch ${branch}`); return fakes.branchCommit },
      contains: async (_repo, ancestor, of) => { calls.push(`git contains ${ancestor} ${of}`); return fakes.contains },
    },
    ledger: {
      reread: async () => {
        const over = fakes.rereads[Math.min(rereadCount, fakes.rereads.length - 1)]
        rereadCount++
        Object.assign(task, boundByHook)
        boundByHook = {}
        if (over !== undefined) Object.assign(task, over)
        return { run, task }
      },
      setBootstrapped: async (_runId, _taskId, record) => {
        calls.push(record === null ? 'clear bootstrapped' : `record bootstrapped ${record.checkout}`)
        bootstrapped.push(record)
        if (record === null) delete task.bootstrapped
        else task.bootstrapped = record
      },
      recordPane: async (_runId, _taskId, pane) => { calls.push(`record pane ${pane}`); return null },
      sessionRuns: async () => [run, ...fakes.otherRuns],
      orchestratorPanes: async () => new Set(fakes.orchestratorPanes),
    },
    base: async () => { calls.push('base'); return fakes.base },
    runBootstrap: async (dir) => { calls.push(`bootstrap in ${dir}`); return fakes.bootstrap },
    bootstrapLog: (t) => `/state/runs/s/r1.dispatch/${t.task_id}-bootstrap.log`,
    brief: async (_run, _task, pane) => { calls.push(`brief ${pane}`); return fakes.brief },
    at: async (taskId, step) => { calls.push(`at ${taskId} ${step}`) },
    say: (line) => { said.push(line) },
    now: () => 1_000_000,
    sleep: async (ms) => { slept.push(ms) },
    hpipe: 'hp',
  }
  return { run, task, deps, fakes, calls, said, slept, bootstrapped }
}

const BOUND = { workspace_id: 'w5', checkout_path: '', pane_id: null }
const LINKED = (path: string, over: Partial<WorktreeEntry> = {}): WorktreeEntry =>
  ({ path, branch: 'feat/x', is_linked_worktree: true, is_prunable: false, ...over })
const WORKSPACE = (checkoutPath: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
  workspace_id: 'w5', label: 'feat-x',
  worktree: { repo_key: 'k', repo_root: repo, checkout_path: checkoutPath, is_linked_worktree: true }, ...over,
})

/** A task the hook has bound to w5 at the checkout, as herdr lists it. */
function bound(taskOver: Partial<Task> = {}, fakeOver: Partial<Fakes> = {}): World {
  return world({ ...BOUND, checkout_path: checkout, ...taskOver }, {
    workspaces: { ok: true, items: [WORKSPACE(checkout)] },
    worktrees: { ok: true, items: [LINKED(checkout)] },
    ...fakeOver,
  })
}

const stepsOf = (calls: string[]) => calls.filter((c) => c.startsWith('at t1 ')).map((c) => c.slice('at t1 '.length))

test('a fresh dispatch runs every step in order and says what each did', async () => {
  writeBootstrap(checkout)
  const w = world()
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(stepsOf(w.calls)).toEqual(['base', 'worktree', 'pane', 'bootstrap', 'agent', 'brief'])
  expect(w.calls).toContain(`worktree create --cwd ${repo} --branch feat/x --base ${BASE}`)
  expect(w.calls).toContain(`bootstrap in ${checkout}`)
  expect(w.calls).toContain('agent start hp-1 --kind claude --pane w5:p1 --timeout 80000 -- ' +
    '--dangerously-skip-permissions --effort high')
  expect(w.calls.indexOf('clear bootstrapped')).toBeGreaterThan(w.calls.indexOf(`worktree create --cwd ${repo} --branch feat/x --base ${BASE}`))
  expect(w.said).toEqual([
    't1 feat/x (hp-1) — standard, worker effort high',
    '  base       1fb8a43c (origin/main as just fetched)',
    `  worktree   created w5 at ${checkout}, pane w5:p1`,
    '  bootstrap  ./.claude/pipeline-bootstrap passed in 0s (log: /state/runs/s/r1.dispatch/t1-bootstrap.log)',
    '  agent      started hp-1 in w5:p1 (--effort high)',
    '  brief      claimed hp-1; delivered to w5:p1, and the worker is working on it',
    'dispatched t1',
  ])
  expect(w.bootstrapped.at(-1)).toEqual({ checkout, at: 1_000_000 })
  expect(w.calls.some((c) => c.includes('worktree open'))).toBe(false)
})

test('the agent start waits on herdr for 80 seconds, in milliseconds', () => {
  expect(AGENT_START_TIMEOUT_MS).toBe(80_000)
})

test('a fetch that fails stops at base, before anything is created', async () => {
  const w = world({}, { base: { commit: BASE, ref: 'origin/main', fetchError: 'Could not resolve host' } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe('stopped t1 at base: the fetch failed (Could not resolve host), and a stale base ' +
    'would cut the worktree without what merged since; run this again once origin answers')
  expect(w.calls.some((c) => c.startsWith('worktree'))).toBe(false)
})

test('a bound workspace that passes both cross-checks is the task\'s, and the worktree step is skipped', async () => {
  const w = bound()
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls.some((c) => c.startsWith('worktree create'))).toBe(false)
  expect(w.said).toContain(`  worktree   w5 at ${checkout} exists (pane w5:p1) — skipped`)
})

test('each cross-check of a bound workspace that fails stops before anything starts', async () => {
  const cases: Array<[string, Partial<Fakes>, string]> = [
    ['missing', { workspaces: { ok: true, items: [] } },
      `the ledger binds t1 to w5 at ${checkout}, but herdr lists no workspace w5. If it closed, \`hp forget w5\` ` +
      `and bind the kept checkout with \`herdr worktree open --cwd '${repo}' --branch feat/x\`, then run this again`],
    ['not linked', { workspaces: { ok: true, items: [WORKSPACE(checkout, { worktree: { repo_key: 'k', repo_root: repo, checkout_path: checkout, is_linked_worktree: false } })] } },
      'herdr lists w5 as no linked worktree'],
    ['another checkout', { workspaces: { ok: true, items: [WORKSPACE('/elsewhere')] } },
      'herdr says w5 is the checkout at /elsewhere'],
    ['another repo', { workspaces: { ok: true, items: [WORKSPACE(checkout, {
      worktree: { repo_key: 'k', repo_root: '/other-repo', checkout_path: checkout, is_linked_worktree: true } })] } },
      `herdr says w5 is a checkout of /other-repo, not of ${repo}`],
    ['no checkout path', { workspaces: { ok: true, items: [WORKSPACE(checkout, {
      worktree: { repo_key: 'k', repo_root: repo, is_linked_worktree: true } })] } },
      'herdr says w5 is the checkout at (none given)'],
    ['no entry', { worktrees: { ok: true, items: [LINKED('/elsewhere')] } },
      `herdr worktree list --cwd '${repo}' has no checkout at ${checkout}`],
    ['wrong branch', { worktrees: { ok: true, items: [LINKED(checkout, { branch: 'feat/y' })] } },
      'that checkout is on feat/y, not feat/x'],
    ['prunable', { worktrees: { ok: true, items: [LINKED(checkout, { is_prunable: true })] } },
      'herdr lists that checkout as prunable: its directory is gone'],
    ['workspaces unreadable', { workspaces: { ok: false, reason: 'server_unavailable — down' } },
      'herdr workspace list could not be read (server_unavailable — down)'],
    ['worktrees unreadable', { worktrees: { ok: false, reason: 'not_git_worktree — nope' } },
      `herdr worktree list --cwd '${repo}' could not be read (not_git_worktree — nope)`],
  ]
  for (const [name, fakes, message] of cases) {
    const w = bound({}, fakes)
    expect(await dispatchTask(w.run, w.task, w.deps), name).toBe(false)
    const last = w.said.at(-1) ?? ''
    expect(last, name).toStartWith('stopped t1 at worktree: ')
    expect(last, name).toContain(message)
    expect(last.toLowerCase(), name).toContain('nothing was started')
    expect(w.calls.some((c) => c.startsWith('agent start') || c.startsWith('worktree create') || c.startsWith('bootstrap')), name)
      .toBe(false)
  }
})

test('a checkout of the branch with no workspace bound waits for the binding, then stops with the step that binds it', async () => {
  const w = world({}, { worktrees: { ok: true, items: [LINKED(checkout)] } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.slept.reduce((a, b) => a + b, 0)).toBe(15_000)
  expect(w.said.at(-1)).toBe(`stopped t1 at worktree: a checkout of feat/x exists at ${checkout}, but no workspace ` +
    `is bound to t1: \`herdr worktree open --cwd '${repo}' --branch feat/x\` binds it; run this again once ` +
    '`hp show --task t1` names a workspace. Nothing was started')
  expect(w.calls.some((c) => c.startsWith('worktree create'))).toBe(false)
})

test('a binding that lands within the wait is taken, and the dispatch carries on', async () => {
  const w = world({}, {
    worktrees: { ok: true, items: [LINKED(checkout)] },
    workspaces: { ok: true, items: [WORKSPACE(checkout)] },
    rereads: [{}, {}, { workspace_id: 'w5', checkout_path: checkout }],
  })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.slept.length).toBe(3)
  expect(w.said).toContain(`  worktree   w5 at ${checkout} exists (pane w5:p1) — skipped`)
})

test('the repo\'s own checkout on the branch, or a registered checkout whose directory is gone, stops with its fix', async () => {
  const primary = world({}, { worktrees: { ok: true, items: [{ path: repo, branch: 'feat/x', is_linked_worktree: false, is_prunable: false }] } })
  expect(await dispatchTask(primary.run, primary.task, primary.deps)).toBe(false)
  expect(primary.said.at(-1)).toContain(`feat/x is checked out in the repo's own checkout at ${repo}`)

  const pruned = world({}, { worktrees: { ok: true, items: [LINKED(checkout, { is_prunable: true })] } })
  expect(await dispatchTask(pruned.run, pruned.task, pruned.deps)).toBe(false)
  expect(pruned.said.at(-1)).toContain(`\`git -C '${repo}' worktree prune\``)
})

test('an unreadable worktree list stops: a checkout cannot be told from none, so nothing is created', async () => {
  const w = world({}, { worktrees: { ok: false, reason: 'unparseable' } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toContain('could not be read (unparseable)')
  expect(w.calls.some((c) => c.startsWith('worktree create'))).toBe(false)
})

test('a branch that already exists without the base is not the task\'s, and is refused', async () => {
  const w = world({}, { branchCommit: '3c4d5e6f00000000000000000000000000000000', contains: false })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe('stopped t1 at worktree: `feat/x` already exists at 3c4d5e6f and does not contain the ' +
    "base 1fb8a43c: it is not this task's; rename the task's branch or delete it. Nothing was started")
  expect(w.calls.some((c) => c.startsWith('worktree create'))).toBe(false)

  const ours = world({}, { branchCommit: '3c4d5e6f00000000000000000000000000000000', contains: true })
  expect(await dispatchTask(ours.run, ours.task, ours.deps)).toBe(true)
  expect(ours.calls).toContain(`git contains ${BASE} 3c4d5e6f00000000000000000000000000000000`)
})

test('herdr refusing the create stops with its code; an unreadable response says the worktree may exist', async () => {
  const refused = world({}, { created: { ok: false, code: 'worktree_exists', message: 'exists' } })
  expect(await dispatchTask(refused.run, refused.task, refused.deps)).toBe(false)
  expect(refused.said.at(-1)).toBe('stopped t1 at worktree: herdr refused the worktree: worktree_exists — exists. ' +
    'Nothing was started')

  const unread = world({}, { created: { ok: false, code: 'unreadable_response', message: "herdr's create response named no workspace id" } })
  expect(await dispatchTask(unread.run, unread.task, unread.deps)).toBe(false)
  expect(unread.said.at(-1)).toContain('herdr may have created the worktree')
  expect(unread.said.at(-1)).toContain('Run this again once `hp show --task t1` names a workspace')
  expect(unread.calls.some((c) => c.startsWith('agent start') || c.startsWith('bootstrap'))).toBe(false)
})

test('after its own create, a binding that names another workspace or checkout stops before anything runs', async () => {
  const w = world({}, { rereads: [{ workspace_id: 'w6', checkout_path: '/elsewhere' }] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toContain('stopped t1 at pane: herdr created w5 at')
  expect(w.said.at(-1)).toContain('but the ledger now binds t1 to w6 at /elsewhere')
  expect(w.calls.some((c) => c.startsWith('agent start') || c.startsWith('bootstrap'))).toBe(false)
})

test('the pane guard stops before agent start on another task\'s pane, an orchestrator\'s, or a pane it cannot choose', async () => {
  const other = newRun({ session: 's', socketPath: '/sock', repoKey: '/other', repoRoot: '/other', title: 'b' })
  other.tasks = [mkTask({ task_id: 't7', pane_id: 'w5:p1', phase: 'implement' })]
  const ownOrchestrator = bound()
  ownOrchestrator.run.orchestrator_pane = 'w5:p1'
  const cases: Array<[string, World, string]> = [
    ['another task', bound({}, { otherRuns: [other] }), `w5:p1 is t7's worker pane (run ${other.run_id})`],
    ['a claimed orchestrator', bound({}, { orchestratorPanes: ['w5:p1'] }), 'w5:p1 is an orchestrator\'s pane'],
    ['this run\'s orchestrator', ownOrchestrator, 'w5:p1 is an orchestrator\'s pane'],
    ['several panes', bound({}, { panes: { w5: { ok: true, items: [{ pane_id: 'w5:p1' }, { pane_id: 'w5:p2' }] } } }),
      'w5 has 2 panes and none is recorded as t1\'s'],
    ['no pane', bound({}, { panes: { w5: { ok: true, items: [] } } }), 'w5 has no pane'],
    ['panes unreadable', bound({}, { panes: { w5: { ok: false, reason: 'down' } } }),
      'herdr pane list --workspace w5 could not be read (down)'],
  ]
  for (const [name, w, message] of cases) {
    expect(await dispatchTask(w.run, w.task, w.deps), name).toBe(false)
    expect(w.said.at(-1), name).toStartWith('stopped t1 at pane: ')
    expect(w.said.at(-1), name).toContain(message)
    expect(w.calls.some((c) => c.startsWith('agent start') || c.startsWith('bootstrap')), name).toBe(false)
  }
})

test('a pane the ledger records in the workspace is chosen among several', async () => {
  const w = bound({ pane_id: 'w5:p2' }, {
    panes: { w5: { ok: true, items: [{ pane_id: 'w5:p1' }, { pane_id: 'w5:p2', agent: null, agent_status: 'unknown' }] } },
  })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls).toContain('agent start hp-1 --kind claude --pane w5:p2 --timeout 80000 -- ' +
    '--dangerously-skip-permissions --effort high')
})

test('a finished task\'s stale pane id does not hold the pane', async () => {
  const other = newRun({ session: 's', socketPath: '/sock', repoKey: '/other', repoRoot: '/other', title: 'b' })
  other.tasks = [mkTask({ task_id: 't7', pane_id: 'w5:p1', phase: 'done' })]
  const w = bound({}, { otherRuns: [other] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
})

test('the bootstrap runs in the new checkout, is recorded, and a re-run in that checkout skips it', async () => {
  writeBootstrap(checkout)
  writeBootstrap(repo, false)
  const first = bound()
  expect(await dispatchTask(first.run, first.task, first.deps)).toBe(true)
  expect(first.calls).toContain(`bootstrap in ${checkout}`)
  expect(first.task.bootstrapped).toEqual({ checkout, at: 1_000_000 })

  const again = bound({ bootstrapped: { checkout, at: 1 } })
  expect(await dispatchTask(again.run, again.task, again.deps)).toBe(true)
  expect(again.calls.some((c) => c.startsWith('bootstrap'))).toBe(false)
  expect(again.said).toContain('  bootstrap  passed in this checkout before — skipped')

  const elsewhere = bound({ bootstrapped: { checkout: '/old/checkout', at: 1 } })
  expect(await dispatchTask(elsewhere.run, elsewhere.task, elsewhere.deps)).toBe(true)
  expect(elsewhere.calls).toContain(`bootstrap in ${checkout}`)
})

test('an agent already in the pane means the checkout was set up: the bootstrap and the start are skipped', async () => {
  writeBootstrap(checkout)
  const w = bound({}, {
    panes: { w5: { ok: true, items: [{ pane_id: 'w5:p1', agent: 'claude', agent_status: 'idle' }] } },
  })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls.some((c) => c.startsWith('bootstrap') || c.startsWith('agent start'))).toBe(false)
  expect(w.said).toContain('  agent      an agent already runs in w5:p1 — skipped')
})

test('a failed bootstrap stops with its log tail and records nothing', async () => {
  writeBootstrap(checkout)
  const w = world({}, { bootstrap: { code: 1, tail: 'npm ERR! missing script\nexit 1' } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe('stopped t1 at bootstrap: ./.claude/pipeline-bootstrap failed (exit 1); fix what it ' +
    'names, then run this again (log: /state/runs/s/r1.dispatch/t1-bootstrap.log). Its last lines:\n' +
    '      npm ERR! missing script\n      exit 1')
  expect(w.bootstrapped.filter((r) => r !== null)).toEqual([])
  expect(w.calls.some((c) => c.startsWith('agent start'))).toBe(false)
})

test('a bootstrap stopped at its deadline gives the hand route, not "fix what it names"', async () => {
  writeBootstrap(checkout)
  const w = world({}, { bootstrap: { code: 143, tail: '', timedOutAfterMs: 20 * 60_000 } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  const last = w.said.at(-1) ?? ''
  expect(last).toContain('the bootstrap did not finish within 20 minutes and was stopped, with everything it started')
  expect(last).toContain(`\`(cd '${checkout}' && ./.claude/pipeline-bootstrap)\``)
  expect(last).toContain('`herdr agent start hp-1 --kind claude --pane w5:p1 -- --dangerously-skip-permissions --effort high`')
  expect(last).toContain('then `hp dispatch --task t1`')
  expect(last).not.toContain('fix what it names')
})

test('a bootstrap that is not executable stops with the chmod; an unwired script is named and not run', async () => {
  writeBootstrap(checkout, false)
  const blocked = world()
  expect(await dispatchTask(blocked.run, blocked.task, blocked.deps)).toBe(false)
  expect(blocked.said.at(-1)).toContain('is not executable: `chmod +x .claude/pipeline-bootstrap`')
  expect(blocked.calls.some((c) => c.startsWith('bootstrap'))).toBe(false)

  rmSync(join(checkout, '.claude'), { recursive: true })
  mkdirSync(join(checkout, 'bin'))
  writeFileSync(join(checkout, 'bin', 'bootstrap'), '#!/bin/sh\n')
  chmodSync(join(checkout, 'bin', 'bootstrap'), 0o755)
  const unwired = world()
  expect(await dispatchTask(unwired.run, unwired.task, unwired.deps)).toBe(true)
  expect(unwired.calls.some((c) => c.startsWith('bootstrap'))).toBe(false)
  expect(unwired.said).toContain('  bootstrap  none wired: ./bin/bootstrap is here but is not run (an executable ' +
    '.claude/pipeline-bootstrap that calls it would run in every new worktree)')
})

test('no bootstrap at all is said, and the dispatch goes on', async () => {
  const w = world()
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.said).toContain('  bootstrap  none declared')
})

test('an agent of the bead\'s name in another pane stops the start, naming that pane, without a retry', async () => {
  const w = world({}, { agentPane: 'w3:p1' })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe('stopped t1 at agent: an agent named hp-1 already runs in w3:p1 (an earlier dispatch of ' +
    't1?): close it, or `hp dispatch --task t1 --pane w3:p1` to brief that one')
  expect(w.calls.filter((c) => c.startsWith('agent get'))).toHaveLength(1)
  expect(w.calls.some((c) => c.startsWith('agent start'))).toBe(false)
})

test('herdr refusing the start stops with its code and the pane to read', async () => {
  const w = world({}, { started: { ok: false, code: 'agent_not_ready', message: 'a dialog is open' } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe('stopped t1 at agent: herdr agent start answered agent_not_ready — a dialog is open: ' +
    '`herdr pane read w5:p1`; a re-run skips the worktree and the bootstrap, and starts the agent unless one is in the pane')
})

test('a new pane still starting its shell is given time before the start is called a failure', async () => {
  const busy = { ok: false as const, code: 'agent_pane_busy', message: 'agent target pane w5:p1 is not an available shell' }
  const w = world({}, { started: [busy, busy, { ok: true }] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls.filter((c) => c.startsWith('agent start'))).toHaveLength(3)

  const never = world({}, { started: [busy] })
  expect(await dispatchTask(never.run, never.task, never.deps)).toBe(false)
  expect(never.calls.filter((c) => c.startsWith('agent start'))).toHaveLength(15)
  expect(never.said.at(-1)).toStartWith('stopped t1 at agent: herdr agent start answered agent_pane_busy')

  const other = world({}, { started: [{ ok: false, code: 'agent_not_ready', message: 'a dialog is open' }, { ok: true }] })
  expect(await dispatchTask(other.run, other.task, other.deps)).toBe(false)
  expect(other.calls.filter((c) => c.startsWith('agent start'))).toHaveLength(1)
})

test('the brief re-reads the ledger, and a task already briefed is not sent another', async () => {
  const agentInPane = { w5: { ok: true as const, items: [{ pane_id: 'w5:p1', agent: 'claude', agent_status: 'idle' as const }] } }
  const w = bound({}, { panes: agentInPane, rereads: [{ awaiting_brief: undefined }] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls.some((c) => c.startsWith('brief'))).toBe(false)
  expect(w.said).toContain('  brief      t1\'s worker already has it — skipped')

  const moved = bound({}, { panes: agentInPane, rereads: [{ phase: 'failed', awaiting_brief: undefined }] })
  expect(await dispatchTask(moved.run, moved.task, moved.deps)).toBe(false)
  expect(moved.said.at(-1)).toBe('stopped t1 at brief: t1 is now in failed; nothing was sent')
})

test('an agent the dispatch did not start, reading working, already has its brief: the pane is recorded, nothing sent', async () => {
  const w = bound({}, {
    panes: { w5: { ok: true, items: [{ pane_id: 'w5:p1', agent: 'claude', agent_status: 'working' }] } },
    statuses: ['working'],
  })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls).toContain('record pane w5:p1')
  expect(w.calls.some((c) => c.startsWith('brief'))).toBe(false)
})

test('after its own start, working proves nothing: it waits for a ready agent and an empty box', async () => {
  const w = world({}, { statuses: ['working', 'unknown', 'idle'], screens: [EMPTY_BOX] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.slept.length).toBe(2)
  expect(w.calls).toContain('brief w5:p1')
  expect(w.calls).not.toContain('record pane w5:p1')
})

test('after its own start, an agent that never becomes ready within 30 seconds is not sent the brief', async () => {
  const w = world({}, { statuses: ['blocked'] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.slept.reduce((a, b) => a + b, 0)).toBe(30_000)
  expect(w.said.at(-1)).toBe('stopped t1 at brief: the agent in w5:p1 is not ready (it reads blocked): ' +
    '`herdr pane read w5:p1`; nothing was sent')
  expect(w.calls.some((c) => c.startsWith('brief'))).toBe(false)
})

test('a screen with no recognisable box, or a box holding text, is never sent the brief', async () => {
  const noBox = bound({}, {
    panes: { w5: { ok: true, items: [{ pane_id: 'w5:p1', agent: 'claude', agent_status: 'idle' }] } },
    screens: ['Do you trust the files in this folder?\n  1. Yes'],
  })
  expect(await dispatchTask(noBox.run, noBox.task, noBox.deps)).toBe(false)
  expect(noBox.said.at(-1)).toBe('stopped t1 at brief: the agent in w5:p1 is not ready (no input box on screen): ' +
    '`herdr pane read w5:p1`; nothing was sent')

  const text = bound({}, {
    panes: { w5: { ok: true, items: [{ pane_id: 'w5:p1', agent: 'claude', agent_status: 'idle' }] } },
    screens: [BOX_WITH('# feat/x — hp-1')],
  })
  expect(await dispatchTask(text.run, text.task, text.deps)).toBe(false)
  expect(text.said.at(-1)).toBe('stopped t1 at brief: the input box of w5:p1 holds text: `herdr pane read w5:p1`; ' +
    'if it is the brief, `herdr agent send-keys w5:p1 ctrl+c`, then run this again')
  expect(text.calls.some((c) => c.startsWith('brief'))).toBe(false)
})

test('a brief that fails stops with what the brief step said', async () => {
  const w = world({}, { brief: { ok: false, text: 'bd would not let t1 claim hp-1; nothing was sent:\n  held' } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe('stopped t1 at brief: bd would not let t1 claim hp-1; nothing was sent:\n  held')
})

test('a re-run after the agent failed skips the worktree and the recorded bootstrap, and starts the agent', async () => {
  writeBootstrap(checkout)
  const w = bound({ bootstrapped: { checkout, at: 1 } })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls.some((c) => c.startsWith('worktree create') || c.startsWith('bootstrap'))).toBe(false)
  expect(w.calls.some((c) => c.startsWith('agent start'))).toBe(true)
})

const agentStarted = (w: World) => w.calls.some((c) => c.startsWith('agent start'))

test('a workspace that closes during the bootstrap is caught before agent start', async () => {
  writeBootstrap(checkout)
  const w = bound()
  w.deps.runBootstrap = async () => {
    w.fakes.workspaces = { ok: true, items: [] }
    return { code: 0, tail: '' }
  }
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toStartWith('stopped t1 at agent: ')
  expect(w.said.at(-1)).toContain('herdr lists no workspace w5')
  expect(agentStarted(w)).toBe(false)
})

test('a task the ledger unbinds, abandons or briefs during the bootstrap gets no agent', async () => {
  const cases: Array<[string, Partial<Task>, string]> = [
    ['unbound', { workspace_id: null }, 'the ledger no longer binds t1 to w5'],
    ['abandoned', { phase: 'failed', awaiting_brief: undefined }, 't1 is now in failed, no longer owed its brief'],
    ['rebound elsewhere', { workspace_id: 'w9', checkout_path: '/elsewhere' }, 'the ledger now binds t1 to w9'],
  ]
  for (const [name, change, message] of cases) {
    const w = bound({}, { rereads: [change] })
    expect(await dispatchTask(w.run, w.task, w.deps), name).toBe(false)
    expect(w.said.at(-1), name).toStartWith('stopped t1 at agent: ')
    expect(w.said.at(-1), name).toContain(message)
    expect(w.said.at(-1), name).toContain('nothing was started')
    expect(agentStarted(w), name).toBe(false)
  }
})

test('a run aborted during the bootstrap gets no agent, and the stop says it was aborted', async () => {
  writeBootstrap(checkout)
  const w = bound()
  w.deps.runBootstrap = async () => {
    w.run.history.push({ at: 1, from: w.run.phase, to: 'done', why: `aborted from ${w.run.phase}` })
    w.run.escalated_from = w.run.phase
    w.run.phase = 'done'
    return { code: 0, tail: '' }
  }
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe(`stopped t1 at agent: run ${w.run.run_id} was aborted; nothing was started`)
  expect(agentStarted(w)).toBe(false)
})

test('a run aborted while the brief waits for an empty box is sent no brief', async () => {
  const w = bound({ awaiting_brief: true })
  const abort = () => {
    w.run.history.push({ at: 1, from: w.run.phase, to: 'done', why: `aborted from ${w.run.phase}` })
    w.run.escalated_from = w.run.phase
    w.run.phase = 'done'
  }
  const read = w.deps.herdr.paneReadStyled
  w.deps.herdr.paneReadStyled = async (pane, lines) => {
    if (w.run.phase !== 'done') abort()
    return read(pane, lines)
  }
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toBe(`stopped t1 at brief: run ${w.run.run_id} was aborted; nothing was sent`)
  expect(w.calls).not.toContain('brief w5:p1')
})

test('a pane another task takes during the bootstrap is caught before agent start', async () => {
  const other = newRun({ session: 's', socketPath: '/sock', repoKey: '/other', repoRoot: '/other', title: 'b' })
  other.tasks = [mkTask({ task_id: 't7', pane_id: 'w5:p1', phase: 'implement' })]
  writeBootstrap(checkout)
  const w = bound()
  w.deps.runBootstrap = async () => {
    w.fakes.otherRuns.push(other)
    return { code: 0, tail: '' }
  }
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toStartWith('stopped t1 at agent: ')
  expect(w.said.at(-1)).toContain("w5:p1 is t7's worker pane")
  expect(agentStarted(w)).toBe(false)
})

test('after its own create, the agent waits for the ledger to bind the new worktree, and stops if it never does', async () => {
  const w = world({}, { createAppears: false })
  w.deps.herdr.workspaceListing = async () => ({ ok: true, items: [WORKSPACE(checkout)] })
  w.deps.herdr.worktreeList = async () => ({ ok: true, items: [] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.slept.reduce((a, b) => a + b, 0)).toBe(15_000)
  expect(w.said.at(-1)).toBe('stopped t1 at agent: herdr created w5, but the ledger has not bound t1 to it, so it ' +
    'cannot be checked again; run this again once `hp show --task t1` names a workspace (is the supervisor ' +
    'running?); nothing was started')
  expect(agentStarted(w)).toBe(false)
})

test('an agent this dispatch started gets the brief even if the supervisor saw it working and cleared the flag', async () => {
  const w = world({}, { rereads: [{}, {}, { awaiting_brief: undefined }] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(true)
  expect(w.calls).toContain('brief w5:p1')
})

test('a checkout that can never bind is named at once, without waiting for a binding', async () => {
  for (const entry of [
    { path: repo, branch: 'feat/x', is_linked_worktree: false, is_prunable: false },
    LINKED(checkout, { is_prunable: true }),
  ]) {
    const w = world({}, { worktrees: { ok: true, items: [entry] } })
    expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
    expect(w.slept).toEqual([])
  }
})

test('the pane guard names --pane as the way to give the task its own pane', async () => {
  const w = bound({}, { orchestratorPanes: ['w5:p1'] })
  expect(await dispatchTask(w.run, w.task, w.deps)).toBe(false)
  expect(w.said.at(-1)).toContain("start t1's agent in its own pane by hand and `hp dispatch --task t1 --pane <pane>`")
})

test('a herdr call that outlived its bound stops the step it was in, and nothing after it runs', async () => {
  const wedged = (call: string) => async (): Promise<never> => { throw new HerdrTimeout(call, 30_000) }
  const listing = world()
  listing.deps.herdr = { ...listing.deps.herdr, worktreeList: wedged('herdr worktree list') }
  expect(await dispatchTask(listing.run, listing.task, listing.deps)).toBe(false)
  expect(listing.said.at(-1)).toBe('stopped t1 at worktree: herdr worktree list did not answer within 30s and was ' +
    'stopped; run this again once herdr answers')
  expect(listing.calls.some((c) => c.startsWith('worktree create'))).toBe(false)

  const status = world()
  status.deps.herdr = { ...status.deps.herdr, agentStatus: wedged('herdr agent get') }
  expect(await dispatchTask(status.run, status.task, status.deps)).toBe(false)
  expect(status.said.at(-1)).toBe('stopped t1 at brief: herdr agent get did not answer within 30s and was stopped; ' +
    'run this again once herdr answers')
  expect(status.calls.some((c) => c.startsWith('brief'))).toBe(false)
})
