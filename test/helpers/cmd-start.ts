import { cmdStart as cmdStartWithRealBeads, type StartBatch, type StartBeads } from '../../src/cli'
import type { Tools } from '../../src/lib/tools'

type CmdStartArgs = Parameters<typeof cmdStartWithRealBeads>

export const READY_TOOLS: Tools = {
  bd: { state: 'ok', version: '1.3.1' },
  bv: { state: 'ok', version: '0.25.2' },
}

/** Tools present and the store already set up: what a start test assumes unless it says otherwise. */
export function startBeads(over: Partial<StartBeads> = {}): StartBeads {
  return {
    tools: async () => READY_TOOLS,
    setup: async () => ({ ok: true, slug: 'repo-abc123', prefix: 'repo', created: false, notes: [] }),
    ...over,
  }
}

/** No supervisor running, a repo that allows squash merges, and no ruleset on the batch, unless a test says otherwise. */
export function startBatch(over: Partial<StartBatch> = {}): StartBatch {
  return {
    supervisor: async () => ({ state: 'none' }),
    squashMergeAllowed: async () => ({ allowed: true }),
    rulesetProtects: async () => false,
    ...over,
  }
}

/**
 * `hpipe start` checks bd and bv and sets up a Beads store; a call here gets the
 * fake above instead of spawning the machine's own binaries into a temp state dir.
 */
export function cmdStart(
  ctx: CmdStartArgs[0],
  input: Omit<CmdStartArgs[1], 'prefix' | 'singlePr' | 'batchBranch'> &
    { prefix?: string | null; singlePr?: boolean; batchBranch?: string | null },
  beads: StartBeads = startBeads(), batch: StartBatch = startBatch(),
): ReturnType<typeof cmdStartWithRealBeads> {
  return cmdStartWithRealBeads(ctx, { prefix: null, singlePr: false, batchBranch: null, ...input }, beads, batch)
}
