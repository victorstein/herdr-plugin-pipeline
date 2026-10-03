import { cmdDispatchTask as cmdDispatchTaskWithRealBeads, type ClaimBead } from '../../src/cli'

type DispatchArgs = Parameters<typeof cmdDispatchTaskWithRealBeads>

/**
 * Dispatch claims the task's bead through `bd` before it sends the brief; a call
 * here without a claim of its own claims nothing and succeeds.
 */
export function cmdDispatchTask(
  ctx: DispatchArgs[0], input: DispatchArgs[1], send: DispatchArgs[2], recordPane?: DispatchArgs[3],
  claim: ClaimBead = async () => ({ ok: true }),
): ReturnType<typeof cmdDispatchTaskWithRealBeads> {
  return cmdDispatchTaskWithRealBeads(ctx, input, send, recordPane, claim)
}
