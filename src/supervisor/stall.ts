import { existsSync } from 'node:fs'
import { type PhaseRow, runRow, taskRow } from '../lib/phases'
import { isUnlandedSave, runIsDriven, type RunEffect, type SaveOutcome } from '../lib/ledger'
import { ageMinutes, resumeCommand } from '../lib/status'
import { enterRunPhase, enterTaskPhase } from '../lib/machine'
import { overdueUnstartedWorker, startWorkerCommand } from '../lib/unstarted'
import { absoluteArtifactPath } from './deliver'
import type { AgentStatus, Run, StallState, Task } from '../lib/types'

/**
 * A row whose actor has no pane of its own is stranded until someone outside it
 * acts, so the table points it at the orchestrator. A worker row can also end up
 * paneless — a dispatch prompt that never landed leaves no pane to nudge — and
 * the same fallback keeps the probe reaching someone.
 */
function probePaneFor(run: Run, row: PhaseRow<string>, taskPane: string | null): string | null {
  if (row.probeTarget === 'orchestrator') return run.orchestrator_pane
  if (row.actor === 'worker') return taskPane ?? run.orchestrator_pane
  return run.orchestrator_pane
}

const MS_PER_MINUTE = 60_000

/** Signals the probed actor produces by its own work. Only these escalate. */
const ESCALATING_SIGNALS: ReadonlySet<string> = new Set(['artifact', 'verdict', 'pr'])

export type StallAction = 'probe' | 'escalate'

export interface StallCandidate {
  run: Run
  task: Task | null
  action: StallAction
  /**
   * Probe rungs climbed so far, delivered or not — never deferrals. Drives the
   * ladder sentence and the reason string.
   */
  probes: number
  /** How many of `probes` never reached the pane. */
  undelivered: number
  /** This record's threshold, which also bounds how long a failing send is retried per rung. */
  thresholdMs: number
  escalatable: boolean
  /** Age in the current phase, for the prompt. */
  minutes: number
  /** Where the probe is SENT. Falls back to the orchestrator for a paneless worker. */
  paneId: string
  /** Whose status gates a deferral. NOT the fallback. */
  actorPaneId: string | null
}

/**
 * The pane of the actor that OWNS the row, with no orchestrator fallback. A
 * paneless worker yields `null`, meaning "the owner is gone, escalate without
 * consulting anyone" — consulting `probePaneFor`'s fallback would gate a
 * worker's escalation on an unrelated agent's status.
 */
function actorPaneFor(run: Run, row: PhaseRow<string>, task: Task | null): string | null {
  return row.actor === 'worker' ? (task?.pane_id ?? null) : run.orchestrator_pane
}

function candidateFor(
  run: Run, record: Run | Task, row: PhaseRow<string>, task: Task | null,
  now: number, thresholdMinutes: number, probeMax: number,
): StallCandidate | null {
  const paneId = probePaneFor(run, row, task?.pane_id ?? null)
  if (!paneId) return null

  const state = stallStateFor(run, record)
  const thresholdMs = thresholdMinutes * MS_PER_MINUTE
  // The anchor is the last rung climbed, NOT the phase entry: anchoring on age
  // makes every rung due at once for a record first seen past its threshold.
  if (now - state.last_probe_at < thresholdMs) return null

  const escalatable = ESCALATING_SIGNALS.has(row.signal)
  return {
    run,
    task,
    action: escalatable && state.probes >= probeMax ? 'escalate' : 'probe',
    probes: state.probes,
    undelivered: state.undelivered ?? 0,
    thresholdMs,
    escalatable,
    minutes: ageMinutes(record.phase_entered_at, now),
    paneId,
    actorPaneId: actorPaneFor(run, row, task),
  }
}

export function stallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, probeMax: number,
): StallCandidate[] {
  const out: StallCandidate[] = []
  for (const run of runs) {
    const row = runRow(run.phase)
    if (!row.stallable) continue
    if (row.stallWhen && !row.stallWhen(run)) continue
    const c = candidateFor(run, run, row, null, now, thresholdMinutes, probeMax)
    if (c) out.push(c)
  }
  return out
}

/**
 * `unstartedThresholdMinutes` is the orchestrator's own cadence: a worktree with
 * no agent in it is the orchestrator's fault and its probe goes there, so waiting
 * out a worker's threshold would only leave the pane empty for longer.
 */
export function taskStallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, probeMax: number,
  unstartedThresholdMinutes: number = thresholdMinutes,
): StallCandidate[] {
  const out: StallCandidate[] = []
  for (const run of runs) {
    // `pickOneAdvance` skips an undriven run too, and `cmdAbort` parks a run in
    // `done` with its tasks intact.
    if (!runIsDriven(run)) continue
    for (const task of run.tasks) {
      const row = taskRow(task.phase)
      if (!row.stallable) continue
      const minutes = overdueUnstartedWorker(run, task, now) === null
        ? thresholdMinutes
        : Math.min(thresholdMinutes, unstartedThresholdMinutes)
      const c = candidateFor(run, task, row, task, now, minutes, probeMax)
      if (c) out.push(c)
    }
  }
  return out
}

/**
 * The ladder state for this phase entry, or a fresh one. BOTH stamps must
 * match: `at` re-arms on the record's own phase entry, `run_at` on the run's —
 * which is what makes `hpipe resume` re-arm a task's ladder even though
 * `cmdResume` (`src/cli.ts:304-320`) never walks `run.tasks`.
 */
export function stallStateFor(run: Run, record: Run | Task): StallState {
  const s = record.stall
  if (s && s.at === record.phase_entered_at && s.run_at === run.phase_entered_at) return s
  return {
    at: record.phase_entered_at,
    run_at: run.phase_entered_at,
    last_probe_at: Math.max(record.phase_entered_at, run.phase_entered_at),
    probes: 0,
    undelivered: 0,
    holds: 0,
  }
}

/**
 * Advances the ladder by one rung and moves the due anchor. Rewriting `at` and
 * `run_at` is REQUIRED, not incidental: `stallStateFor` rejects a mismatched
 * stamp, so a bump that advanced only `last_probe_at` and the counter would be
 * rejected on the next read, re-anchor every tick, and never accumulate — which
 * is the rung-per-tick burst this design exists to prevent.
 */
export function bumpStall(
  run: Run, record: Run | Task, kind: 'probes' | 'holds', now: number,
): void {
  const s = stallStateFor(run, record)
  record.stall = {
    at: record.phase_entered_at,
    run_at: run.phase_entered_at,
    last_probe_at: now,
    probes: s.probes + (kind === 'probes' ? 1 : 0),
    undelivered: s.undelivered ?? 0,
    holds: s.holds + (kind === 'holds' ? 1 : 0),
  }
}

/**
 * Records a probe that did not reach the pane, and reports whether the ledger
 * changed. A failure does NOT climb a rung on its own — the anchor stays put, so
 * the probe is retried next tick and a one-tick blip costs nothing. Only a
 * streak that has lasted a whole threshold climbs, and the rung is dated to when
 * the streak began: that keeps an unreachable pane on the same rung cadence as a
 * silent one, where dating it to `now` would stretch every rung to two
 * thresholds.
 */
export function noteUndelivered(
  run: Run, record: Run | Task, now: number, thresholdMs: number,
): boolean {
  const s = stallStateFor(run, record)
  const since = s.undeliverable_since
  if (since === undefined) {
    record.stall = { ...s, undeliverable_since: now }
    return true
  }
  if (now - since < thresholdMs) return false
  record.stall = {
    ...s,
    last_probe_at: since,
    probes: s.probes + 1,
    undelivered: (s.undelivered ?? 0) + 1,
    undeliverable_since: now,
  }
  return true
}

export interface Awaiting {
  /** The whole waiting paragraph, so the template asserts nothing about its shape. */
  clause: string
  /** A noun phrase, for the escalation prompt's single sentence. */
  short: string
}

/**
 * What this phase is waiting for, phrased so the sentence is true of what it
 * names. Mostly keyed on `row.signal`, but not only: `escalated` and
 * `blocked-on-decision` share `signal: 'manual'` and need opposite sentences,
 * so the human-owned branch is checked first. #19 found that the hard way —
 * this docblock used to claim signal-keying alone would carry it.
 * `hpipe` arrives already rendered:
 * `render` never re-scans replacement text (`src/lib/render.ts:8-14`), so a
 * `{{hpipe}}` inside a VALUE would ship to an agent verbatim.
 */
export function stallAwaiting(
  run: Run, task: Task | null, hpipe: string, now: number = Date.now(),
): Awaiting {
  const row = task ? taskRow(task.phase) : runRow(run.phase)
  const phase = task ? task.phase : run.phase
  const sentence = (short: string): Awaiting =>
    ({ short, clause: `This phase is waiting for ${short}.` })
  // `ci` and `merge` deadlock identically on a missing PR and share one way out,
  // so the command a reader will paste is composed in one place.
  const missingPr = (t: Task, consequence: string): Awaiting => ({
    short: 'a PR number this task never recorded',
    clause: 'This phase is waiting for a PR number that was never recorded for this task, ' +
      `${consequence} The rewind is what produces one: \`${hpipe} rewind ` +
      `${run.run_id} implement --task ${t.task_id}\`.`,
  })

  // A human-owned row waits on a person, not on the pane being probed. Checked
  // before the `manual` branch, which `blocked-on-decision` shares with it and
  // which would otherwise tell an escalated task it is waiting for an answer to a
  // decision it never asked.
  if (row.actor === 'human') {
    return {
      short: 'a human to act on the escalation',
      clause: 'This phase is escalated and waits on the human, not on you. If they have not been ' +
        'told, tell them now; once they have decided, ' +
        `\`${resumeCommand(hpipe, run, task)}\` resumes it.`,
    }
  }

  // Ahead of the artifact branch, whose "nothing has appeared" would have the
  // orchestrator wait on a worker that does not exist.
  const unstarted = task === null ? null : overdueUnstartedWorker(run, task, now)
  if (task !== null && unstarted !== null) {
    return {
      short: 'an agent detected in its worktree',
      clause: `No agent has been detected in this task's worktree (workspace ` +
        `${unstarted.workspaceId}) since it was created, so this phase cannot advance and it waits ` +
        `on you, not on a worker: ${startWorkerCommand(task, unstarted.workspaceId, hpipe)}.`,
    }
  }

  if (row.signal === 'artifact' || row.signal === 'verdict') {
    const short = row.signal === 'artifact' ? 'its research/spec/plan artifact' : 'its review verdict'
    // With no worktree `absoluteArtifactPath` falls back to the main checkout,
    // which is the orchestrator's tree and holds every sibling's merged docs — so
    // naming it sends the reader at the wrong file when the real fault is that
    // this task was never dispatched. `adoptableArtifacts` refuses the identical
    // fallback for the identical reason.
    if (task !== null && task.checkout_path === null) {
      return sentence('a worktree for this task, which has never been dispatched')
    }
    const path = absoluteArtifactPath(run, task)
    if (path !== null) {
      // An `onBlocker` re-entry leaves the previous pass's file in place, so
      // "nothing has appeared" is simply false there. What the phase waits for is
      // a version newer than its entry, which is what `isFresh` tests.
      const lead = existsSync(path)
        ? `Nothing newer than this phase's start has appeared at:\n\n    ${path}`
        : `Nothing has appeared at:\n\n    ${path}`
      return {
        short,
        // Not "the supervisor stats that path and nothing else": adoption also asks
        // the branch what it added, so that sentence stopped being true when #9
        // landed, and #9 deleted it from `prompts/worker-brief.md` in this batch.
        clause: `${lead}\n\nIf you finished but wrote it elsewhere, move it exactly there — ` +
          "an artifact written anywhere else does not satisfy this phase's contract.",
      }
    }
  }
  if (row.signal === 'pr' && task) {
    return sentence(`a pushed PR for ${task.branch} (#${task.issue})`)
  }
  if (row.signal === 'ci' && task) {
    // `ciTransitions` skips a `ci` row with no PR (ci.ts:12), so that row is never
    // polled and cannot clear — a different fault from a slow CI run, and the
    // probe is the only thing that will ever say so.
    if (task.pr === null) return missingPr(task, 'so CI is never polled for it.')
    // NOT "cancelled": rollUpBucket maps `cancel` to `fail` (gh.ts:19), which
    // advances the row back to `implement` — one of the fastest ways OUT of ci.
    return {
      short: `CI on PR #${task.pr}`,
      clause: `This phase is waiting for CI to report on PR #${task.pr}. Check it with ` +
        `\`gh pr checks ${task.pr}\` — a run that is queued or was never triggered reports no ` +
        'conclusion, and this phase waits on it forever.',
    }
  }
  if (row.signal === 'merged' && task) {
    // `gatherSignals` returns early on a null PR (tasks.ts:278), so `merged` is
    // never true and machine.ts:165-171 never fires.
    if (task.pr === null) return missingPr(task, 'so no merge is ever seen.')
    // The second sentence is not padding: this row cannot distinguish "not yet
    // merged" from "merged too early to be seen" (machine.ts:167), so a clause
    // asserting the first would be false in the second.
    return {
      short: `PR #${task.pr} to be merged`,
      clause: `This phase is waiting for you to merge PR #${task.pr} (${task.branch}). ` +
        "Merging is yours, not the plugin's; nothing merges automatically. If it is already " +
        "merged, this phase cannot see it: only a merge that postdates this phase's entry " +
        'counts, so say so rather than waiting.',
    }
  }
  if (row.signal === 'closed' && task) {
    // Not "the issue is still open": `closedByMerge` needs `merged_at_ms`, which
    // only the merge edge writes (machine.ts:168). A task rewound into `close`
    // from before `merge` has none, so a closed issue never satisfies
    // machine.ts:178-181 and this row parks with the work already done.
    return {
      short: `issue #${task.issue} to close`,
      clause: `This phase is waiting for issue #${task.issue} to close. Check it with ` +
        `\`gh issue view ${task.issue} --json closed,state\`; if the PR body used a phrase ` +
        'GitHub does not treat as a closing keyword, close it by hand. If it is already ' +
        'closed, this phase cannot see it: it only counts a close it can tie to this ' +
        "task's recorded merge, so say so rather than waiting.",
    }
  }
  if (row.signal === 'files') {
    return {
      short: 'the files another task holds',
      clause: 'This phase is waiting for another task to release the files this one declared.',
    }
  }
  if (row.signal === 'manual') return sentence('an answer to the open decision')
  if (row.signal === 'worktree') {
    return task
      ? { short: 'its worktree to be removed',
          clause: "This phase is waiting for this task's worktree to be removed. Teardown is " +
            'unconditional and runs first in every tick, so a task still here means this run is ' +
            "not being advanced — check the supervisor pane's log, and check whether another run " +
            'already holds this orchestrator pane.' }
      : { short: 'a worktree for a dispatched task',
          clause: 'This phase is waiting for a worktree to be adopted for a dispatched task.' }
  }
  if (row.signal === 'gate') {
    return {
      short: 'intake to be closed',
      clause: `This phase is waiting for \`${hpipe} dispatch --done\` to close intake.`,
    }
  }
  return sentence(`whatever clears ${phase}`)
}

/**
 * The ladder sentence, composed here rather than templated, because a bare
 * "probe N of M" is false for every row escalation excludes: those keep being
 * probed past the cap and are never escalated.
 */
export function ladderFor(
  c: { probes: number; undelivered: number; escalatable: boolean }, probeMax: number,
): string {
  if (!c.escalatable) {
    return 'This is a standing nudge — this phase is not escalated automatically, and clears ' +
      'when whatever it is waiting for arrives.'
  }
  // Numbered by rung, not by delivered probe: undelivered rungs count toward the
  // cap, so a delivered-only count would promise the agent probes it will not get.
  const missed = c.undelivered === 0
    ? ''
    : ` ${c.undelivered === 1 ? 'One earlier probe' : `${c.undelivered} earlier probes`} ` +
      'could not be delivered to this pane and still counted.'
  return `This is probe ${c.probes + 1} of ${probeMax}.${missed} After ${probeMax} unanswered ` +
    'probes this phase is escalated to the human and stops moving on its own.'
}

/**
 * For the escalation prompt, which otherwise asks the orchestrator what the
 * worker was doing — the wrong first question when the pane never got a probe.
 */
export function undeliveredNote(undelivered: number): string {
  if (undelivered === 0) return ''
  return `\n\n${undelivered} of them never reached the pane, so it may be unreachable — ` +
    'check that the pane and its agent are still alive before asking what it was doing.'
}

export interface StallDeps {
  probeMax: number
  now: () => number
  /**
   * `ok: false` means the probe did not reach the pane — a failed send, or one
   * deliberately skipped because the pane cannot answer. Either is retried and,
   * once undeliverable for a whole threshold, climbs as an undelivered rung, so a
   * filter that stops sending must still return here rather than drop the
   * candidate.
   */
  probe: (c: StallCandidate) => Promise<{ ok: boolean }>
  /**
   * Rendered BEFORE the transition, so it describes the phase being left —
   * `escalated`'s own row is `signal: 'manual'` and would describe nothing.
   */
  escalationText: (c: StallCandidate, from: string) => Promise<string>
  /** Sends an already-rendered prompt. The transition is already persisted. */
  sendEscalation: (c: StallCandidate, text: string) => Promise<void>
  agentStatus: (paneId: string) => Promise<AgentStatus>
  /**
   * `effect` re-records an action already taken — a probe that was sent — should
   * the save lose to a CLI write; see `saveOrReapply`.
   */
  persist: (run: Run, effect?: RunEffect) => Promise<SaveOutcome | void>
}

/**
 * A bump is persisted immediately: `listRuns` re-reads every run from disk each
 * tick (`src/lib/ledger.ts:48-62`) and both `saveRun` sites in the tick
 * (`src/supervisor/main.ts:137`, `:218`) precede this block, so an unpersisted
 * bump is discarded and `last_probe_at` never advances — the rung-per-tick
 * burst again.
 */
export async function applyStalls(
  candidates: StallCandidate[], deps: StallDeps,
): Promise<void> {
  // A run whose save lost to a CLI command is stale for the rest of the batch:
  // its later candidates were computed from state the command replaced.
  const staleRuns = new Set<Run>()
  for (const c of candidates) {
    if (staleRuns.has(c.run)) continue
    try {
      if (await applyStall(c, deps) === 'reapplied') staleRuns.add(c.run)
    } catch (error) {
      if (!isUnlandedSave(error)) throw error
      staleRuns.add(c.run)
      console.error(`[pipeline] run ${c.run.run_id}: stall bookkeeping not saved (${error.message}); ` +
        're-read next tick')
    }
  }
}

/**
 * A probe's ladder bookkeeping, applicable both to the tick's copy and — should
 * that save lose to a CLI write — to a freshly read run, where it applies only if
 * neither the record nor the run has changed phase since the candidate was built.
 * Both outcomes are replayed: a delivered probe must not be sent again at once,
 * and an undelivered streak that restarted on every lost save would postpone the
 * escalation #61 exists for. Returns whether there was anything to save.
 */
function stallEffectFor(
  c: StallCandidate, mutate: (run: Run, record: Run | Task) => boolean | void,
): (run: Run) => boolean {
  const taskId = c.task?.task_id
  const recordEnteredAt = (c.task ?? c.run).phase_entered_at
  const runEnteredAt = c.run.phase_entered_at
  return (run) => {
    const record = taskId === undefined ? run : run.tasks.find((t) => t.task_id === taskId)
    if (!record || record.phase_entered_at !== recordEnteredAt) return false
    if (run.phase_entered_at !== runEnteredAt) return false
    return mutate(run, record) !== false
  }
}

async function applyStall(c: StallCandidate, deps: StallDeps): Promise<SaveOutcome | void> {
  const record: Run | Task = c.task ?? c.run

  // An undeliverable probe must still climb eventually: the ladder exists to
  // end silence, and a pane that cannot be reached is the case escalation
  // matters most (#32). `noteUndelivered` decides when.
  if (c.action === 'probe') {
    const now = deps.now()
    const delivered = (await deps.probe(c)).ok
    const bookkeeping = stallEffectFor(c, delivered
      ? (run, record) => { bumpStall(run, record, 'probes', now) }
      : (run, record) => noteUndelivered(run, record, now, c.thresholdMs))
    if (!bookkeeping(c.run)) return
    return deps.persist(c.run, (fresh) => { bookkeeping(fresh) })
  }

  const { holds } = stallStateFor(c.run, record)
  if (
    holds < deps.probeMax && c.actorPaneId !== null &&
    (await deps.agentStatus(c.actorPaneId)) === 'working'
  ) {
    bumpStall(c.run, record, 'holds', deps.now())
    return deps.persist(c.run)
  }

  await escalate(c, deps)
}

/**
 * The transition lives here, not in the caller's callback, so both branches are
 * reachable from a test and the ordering is enforced by the code rather than by
 * a comment: the text describes the phase being LEFT, and the ledger write
 * precedes the send so a rejected prompt costs a prompt and never a transition.
 * This mirrors `deliverPendingAnswers` (`src/supervisor/tasks.ts:283`), which
 * calls `enterTaskPhase` in-module and injects only the send.
 */
async function escalate(c: StallCandidate, deps: StallDeps): Promise<void> {
  const from = c.task ? c.task.phase : c.run.phase
  const text = await deps.escalationText(c, from)
  const why = `${c.probes} stall probes unanswered` +
    (c.undelivered > 0 ? `, ${c.undelivered} of them undelivered` : '')

  if (c.task) enterTaskPhase(c.run, c.task, 'escalated', why)
  else enterRunPhase(c.run, 'escalated', why)

  await deps.persist(c.run)
  await deps.sendEscalation(c, text)
}
