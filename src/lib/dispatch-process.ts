import { BOOTSTRAP_REL } from './bootstrap'
import { type CheckRun, runLogged } from './check'
import { type HeldDispatchLock, stopGroup } from './dispatch-lock'
import { AGENT_START_BOUND_MS, BOOTSTRAP_DEADLINE_MS, type DispatchGit, type DispatchHerdr } from './dispatch-steps'
import type { Herdr } from './herdr'
import { processStartedAtMs } from './pidfile'
import { isAncestor } from './sync-walk'

/** What a dispatch has running in groups of their own, which a signal must stop along with it. */
export interface DispatchChildren {
  bootstrapPgid: number | null
  agentStartPgid: number | null
}

export const noChildren = (): DispatchChildren => ({ bootstrapPgid: null, agentStartPgid: null })

export function dispatchHerdr(herdr: Herdr, children: DispatchChildren): DispatchHerdr {
  return {
    workspaceListing: () => herdr.workspaceListing(),
    worktreeList: (repoRoot) => herdr.worktreeList(repoRoot),
    worktreeCreate: (repoRoot, branch, base) => herdr.worktreeCreate(repoRoot, branch, base),
    paneListing: (workspaceId) => herdr.paneListing(workspaceId),
    agentPane: (name) => herdr.agentPane(name),
    agentStatus: (paneId) => herdr.agentStatus(paneId),
    paneReadStyled: (paneId, lines) => herdr.paneReadStyled(paneId, lines),
    agentStart: async (request) => {
      try {
        return await herdr.agentStart(request, AGENT_START_BOUND_MS, (pid) => { children.agentStartPgid = pid })
      } finally {
        children.agentStartPgid = null
      }
    },
  }
}

async function gitOut(repoRoot: string, args: string[]): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(['git', '-C', repoRoot, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return { code: await proc.exited, out }
  } catch {
    return { code: -1, out: '' }
  }
}

export const dispatchGit: DispatchGit = {
  // `for-each-ref` matches its pattern by path prefix, so the exact ref is picked out of what it lists.
  branchCommit: async (repoRoot, branch) => {
    const ref = `refs/heads/${branch}`
    const listed = await gitOut(repoRoot, ['for-each-ref', '--format=%(refname)%00%(objectname)', ref])
    if (listed.code !== 0) return undefined
    const line = listed.out.split('\n').find((entry) => entry.startsWith(`${ref}\0`))
    return line === undefined ? null : line.slice(ref.length + 1)
  },
  contains: (repoRoot, ancestor, of) => isAncestor(repoRoot, ancestor, of),
}

/**
 * The bootstrap in its own process group, recorded on the lock while it runs so a
 * dispatch killed with SIGKILL leaves enough behind for the next one to stop it.
 * At the deadline the group gets SIGTERM, then SIGKILL once the grace is spent.
 */
export async function runTrackedBootstrap(
  checkout: string, logPath: string, lock: HeldDispatchLock, children: DispatchChildren,
  deadlineMs: number = BOOTSTRAP_DEADLINE_MS,
): Promise<CheckRun> {
  let recorded: Promise<void> = Promise.resolve()
  try {
    return await runLogged(checkout, BOOTSTRAP_REL, logPath, {
      deadlineMs,
      stop: (pgid) => stopGroup(pgid),
      onStart: (pgid) => {
        children.bootstrapPgid = pgid
        recorded = (async () => {
          const startedAt = await processStartedAtMs(pgid)
          if (startedAt !== null) await lock.bootstrapStarted(pgid, startedAt)
        })()
      },
    })
  } finally {
    children.bootstrapPgid = null
    await recorded
    await lock.bootstrapEnded()
  }
}

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }

/**
 * Set once a signal is being handled. Every step and the command's own return
 * wait on `gate`, so nothing new starts, and nothing exits ahead of the handler,
 * while the handler stops the children and ends the process.
 */
export class DispatchInterrupt {
  private requested = false

  request(): boolean {
    if (this.requested) return false
    this.requested = true
    return true
  }

  async gate(): Promise<void> {
    if (this.requested) await new Promise<never>(() => {})
  }
}

export interface Trap {
  lock: HeldDispatchLock
  children: DispatchChildren
  interrupt: DispatchInterrupt
  say: (line: string) => void
  stop?: (pgid: number) => Promise<void>
  exit?: (code: number) => void
}

/**
 * SIGTERM, SIGINT and SIGHUP stop the bootstrap's group and a running `agent
 * start`, remove the lock, and exit 128+n. Nobody watches a background shell, so
 * a dispatch that died quietly would leave both running. An `agent start` herdr
 * finishes anyway is found in the pane by the next run.
 */
export function trapDispatchSignals(trap: Trap): () => void {
  const stop = trap.stop ?? ((pgid: number) => stopGroup(pgid))
  const exit = trap.exit ?? ((code: number) => process.exit(code))
  const handle = async (signal: string): Promise<void> => {
    if (!trap.interrupt.request()) return
    const running = [trap.children.bootstrapPgid, trap.children.agentStartPgid]
      .filter((pgid): pgid is number => pgid !== null)
    await Promise.all(running.map(stop))
    const { task, step } = trap.lock.record
    trap.lock.release()
    try {
      trap.say(`stopped ${task === null ? 'the dispatch' : `${task} at ${step ?? 'its start'}`}: interrupted`)
    } catch {
      // A SIGHUP can mean the terminal is gone; the exit below must still happen.
    }
    exit(128 + (SIGNAL_NUMBERS[signal] ?? 0))
  }
  const listeners = Object.keys(SIGNAL_NUMBERS).map((signal) => [signal, () => { void handle(signal) }] as const)
  for (const [signal, listener] of listeners) process.on(signal, listener)
  return () => {
    for (const [signal, listener] of listeners) process.off(signal, listener)
  }
}
