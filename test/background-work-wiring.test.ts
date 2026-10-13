import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadRun, newRun, saveOrReapply, saveRun } from '../src/lib/ledger'
import type { AgentStatus, QueuedEvent, Run, Task } from '../src/lib/types'
import { observedScreens, PaneBackground } from '../src/supervisor/pane-background'
import { applyStalls, type StallDeps, stallCandidates } from '../src/supervisor/stall'
import { advanceTasks, type TaskDeps } from '../src/supervisor/tasks'
import { describeWake, noteBackgroundWork, type WakeLine } from '../src/supervisor/tick'
import { checkLimits, limitedNow, UsageLimits } from '../src/supervisor/usage-limits'
import { beadTaskFields } from './helpers/bead-fields'

/**
 * The limit step's reads, the task step, the digest line and the stall step,
 * driven in `main.ts`'s order against a real ledger with only herdr faked. Unit
 * tests with fakes have missed live-only wiring bugs before.
 */

const ROOT = join(import.meta.dir, '..')
const ORCHESTRATOR = 'w2:p1'
const WORKER = 'w5:p1'
const RULE = '─'.repeat(40)
const STATUS_LINE = '  [Opus 5.5 (1M context)] │ Ctx ██░░░░░░░░ 27%'
const screen = (...below: string[]) => ['⏺ Waiting.', '', RULE, '❯ ', RULE, STATUS_LINE, ...below].join('\n')
const BUILDING = screen('  ⏵⏵ bypass permissions on · 1 shell, 4 monitors · ← 1 agent', '', '  ⏺ main',
  '  ◯ ui-dev  Waiting on x4pro firmware build                                                   2m 10s · ↓ 112.8k tokens')
const REVIEWING = screen('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent', '', '  ⏺ main',
  '  ◯ general-purpose  Building the host suite                                                  9m 52s · ↓ 53.0k tokens')
const QUIET = screen('  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 1 agent')
const UNCOMMITTED = ['src/components/themes/BaseTheme.cpp', 'src/components/themes/BaseTheme.h']

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function herdrFake() {
  const screens: Record<string, string> = { [WORKER]: BUILDING, [ORCHESTRATOR]: REVIEWING }
  const statuses: Record<string, AgentStatus> = { [WORKER]: 'done', [ORCHESTRATOR]: 'done' }
  const reads: string[] = []
  return {
    screens, statuses, reads,
    io: {
      paneReadStyled: async (pane: string) => { reads.push(pane); return screens[pane] ?? '' },
      agentStatus: async (pane: string) => statuses[pane] ?? 'unknown',
    },
  }
}

const turn = (pane: string): QueuedEvent[] => (['working', 'done'] as const).map((agent_status, i) =>
  ({ kind: 'pane.agent_status_changed', session: 'personal', at: i, pane_id: pane, agent_status }))

async function seedRun(): Promise<Run> {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chips' })
  run.phase = 'execute'
  run.intake_closed = true
  run.orchestrator_pane = ORCHESTRATOR
  const task: Task = {
    task_id: 't3', branch: 'feature/header-action-seam', bead: 'btrial-3', surface: 'ui', depends_on: [], files: [],
    keep_worktree: false, workspace_id: 'w5', pane_id: WORKER, agent_status: 'done',
    phase: 'implement', phase_entered_at: Date.now() - 120_000, escalated_from: null, head_sha_at_entry: null,
    pr: null, ci: null, checkout_path: '/wt/t3', registered_at: 0, adopted_at: 0,
    artifacts: { research: null, spec: null, plan: null, verdicts: {} },
    merged_at_ms: null, merge_commit: null, ...beadTaskFields(), passes: {}, decisions: [],
    decision_from: null, pending_answer: null, delivery_attempts: 0, notes: '',
  }
  run.tasks = [task]
  await saveRun(dir, run)
  return run
}

function taskDeps(background: PaneBackground, io: ReturnType<typeof herdrFake>['io']): TaskDeps {
  return {
    pluginRoot: ROOT,
    liveIdle: async (pane) => (await io.agentStatus(pane)) === 'done',
    backgroundWork: (pane) => background.running(pane, io),
    hasLiveAgent: () => true,
    maxPasses: 2, fileSettleMs: 0,
    prForBranch: async () => null, prView: async () => null, verdictFor: async () => null,
    removeWorktree: async () => 'removed', removeCheckout: async () => ({ removed: true }),
    ciDetail: async () => '', ambiguityLog: new Set(),
    uncommittedPaths: async () => UNCOMMITTED,
    freshDispatchBase: async () => ({ commit: '1fb8a43', ref: 'origin/main', fetchError: null }),
  }
}

async function tick(
  run: Run, events: QueuedEvent[], background: PaneBackground, herdr: ReturnType<typeof herdrFake>,
): Promise<string> {
  const limits = new UsageLimits(() => Date.now(), () => {})
  background.noteTurns(events)
  await checkLimits(limits, observedScreens(herdr.io, background), events, new Set([ORCHESTRATOR, WORKER]))
  const fresh = (await loadRun(dir, 'personal', run.run_id)) as Run
  const task = fresh.tasks[0] as Task
  const wake: WakeLine[] = [{ run: fresh, task, event: 'agent:done', phaseAtEvent: task.phase }]
  await advanceTasks(fresh, taskDeps(background, herdr.io))
  await saveOrReapply(dir, fresh, [])
  noteBackgroundWork(wake, (pane) => background.lastSeen(pane))
  return describeWake(wake[0] as WakeLine, Date.now(), 'hpipe')
}

test('a worker idle with its subagent still building is the worker\'s move, and is once it really stops', async () => {
  dir = mkdtempSync(join(tmpdir(), 'hpipe-background-'))
  const herdr = herdrFake()
  const background = new PaneBackground()
  const run = await seedRun()

  const building = await tick(run, turn(WORKER), background, herdr)
  expect(building).toContain('agent:done, background work running (1 shell, 4 monitors, ui-dev subagent)')
  expect(building).toContain("worker's move")
  expect(building).not.toContain('uncommitted')
  expect((await loadRun(dir, 'personal', run.run_id))?.tasks[0]?.uncommitted_work).toBeUndefined()
  const readsWhileBuilding = herdr.reads.length

  // Ticks between events answer from the reading the limit step took: no read per task per tick.
  await tick(run, [], background, herdr)
  expect(herdr.reads).toHaveLength(readsWhileBuilding)

  herdr.screens[WORKER] = QUIET
  const stopped = await tick(run, turn(WORKER), background, herdr)
  expect(stopped).toContain('YOUR move: worker idle with 2 uncommitted paths')
  expect(stopped).not.toContain('background work running')
})

test('the orchestrator waiting on its reviewer subagent is held at the top of the ladder, then escalated once quiet', async () => {
  dir = mkdtempSync(join(tmpdir(), 'hpipe-background-'))
  const herdr = herdrFake()
  const background = new PaneBackground()
  const seeded = await seedRun()
  seeded.phase = 'branch-review'
  seeded.phase_entered_at = Date.now() - 20 * 60_000
  seeded.tasks = []
  seeded.stall = {
    at: seeded.phase_entered_at, run_at: seeded.phase_entered_at,
    last_probe_at: seeded.phase_entered_at, probes: 3, undelivered: 0, holds: 0,
  }
  await saveRun(dir, seeded)
  const limits = new UsageLimits(() => Date.now(), () => {})
  const sent: string[] = []
  const deps: StallDeps = {
    probeMax: 3,
    now: () => Date.now(),
    agentStatus: (pane) => herdr.io.agentStatus(pane),
    backgroundWork: (pane) => background.running(pane, herdr.io),
    persist: (r, effect) => saveOrReapply(dir, r, effect ? [effect] : []),
    probe: async () => { sent.push('probe'); return { ok: true } },
    escalationText: async () => 'escalated',
    queueEscalation: () => { sent.push('escalate') },
    limited: limitedNow(limits, observedScreens(herdr.io, background)),
  }

  await checkLimits(limits, observedScreens(herdr.io, background), turn(ORCHESTRATOR), new Set([ORCHESTRATOR]))
  let run = (await loadRun(dir, 'personal', seeded.run_id)) as Run
  await applyStalls(stallCandidates([run], Date.now(), 15, 3), deps)
  run = (await loadRun(dir, 'personal', seeded.run_id)) as Run
  expect(sent).toEqual([])
  expect(run.phase).toBe('branch-review')
  expect(run.stall?.holds).toBe(1)

  herdr.screens[ORCHESTRATOR] = QUIET
  background.noteTurns(turn(ORCHESTRATOR))
  await checkLimits(limits, observedScreens(herdr.io, background), turn(ORCHESTRATOR), new Set([ORCHESTRATOR]))
  run.stall = { ...run.stall!, last_probe_at: Date.now() - 16 * 60_000 }
  await saveRun(dir, run)
  await applyStalls(stallCandidates([run], Date.now(), 15, 3), deps)
  expect(sent).toEqual(['escalate'])
  expect((await loadRun(dir, 'personal', seeded.run_id))?.phase).toBe('escalated')
})
