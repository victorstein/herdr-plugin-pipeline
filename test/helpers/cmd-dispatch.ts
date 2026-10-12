import { cmdDispatchTask as cmdDispatchTaskWithRealBeads, type ClaimBead, type ReadPaneLimit } from '../../src/cli'

type DispatchArgs = Parameters<typeof cmdDispatchTaskWithRealBeads>

/**
 * Dispatch claims the task's bead through `bd` and reads the pane through herdr
 * before it sends the brief; a call here without its own of either claims nothing,
 * finds no usage limit, and succeeds.
 */
export function cmdDispatchTask(
  ctx: DispatchArgs[0], input: DispatchArgs[1], send: DispatchArgs[2], recordPane?: DispatchArgs[3],
  claim: ClaimBead = async () => ({ ok: true }),
  readPaneLimit: ReadPaneLimit = async () => null,
): ReturnType<typeof cmdDispatchTaskWithRealBeads> {
  return cmdDispatchTaskWithRealBeads(ctx, input, send, recordPane, claim, readPaneLimit)
}
