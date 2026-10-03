import { cmdTask as cmdTaskWithRealBeads, type RegistrationBeads } from '../../src/cli'
import type { BeadDetail } from '../../src/lib/bd'

type CmdTaskArgs = Parameters<typeof cmdTaskWithRealBeads>

export function openBead(id: string, over: Partial<BeadDetail> = {}): BeadDetail {
  return {
    id, title: `Bead ${id}`, description: `What ${id} asks for.`, acceptance_criteria: `${id} is done.`,
    status: 'open', labels: [], dependencies: [], dependents: [], comments: [], ...over,
  }
}

/** Files every bead as hp-318, and shows any id as an open, unassigned, unlinked bead. */
export function fakeBeads(over: Partial<RegistrationBeads> = {}): RegistrationBeads {
  return {
    create: async () => ({ id: 'hp-318' }),
    show: async (_repoKey, id) => openBead(id),
    ...over,
  }
}

/**
 * Registration reads and files beads through `bd`; a call here without beads of
 * its own gets the fake above instead of a real store, which a temp state dir lacks.
 */
export function cmdTask(
  ctx: CmdTaskArgs[0], input: CmdTaskArgs[1], beads: RegistrationBeads = fakeBeads(),
  dispatchBase?: CmdTaskArgs[3],
): ReturnType<typeof cmdTaskWithRealBeads> {
  return cmdTaskWithRealBeads(ctx, input, beads, dispatchBase)
}
