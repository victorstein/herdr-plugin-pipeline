import { type Bd, type BdFailure, type Done, isBdFailure } from './bd'

type ClaimingBd = Pick<Bd, 'show' | 'update' | 'claim'>

/**
 * `--claim` only takes an `open`, unassigned bead. One an earlier life of the
 * task left `blocked`, or assigned but `open`, is put back first, so the claim's
 * answer is about now rather than about that history.
 */
export async function claimForDispatch(bd: ClaimingBd, bead: string): Promise<Done | BdFailure> {
  const current = await bd.show(bead)
  if (isBdFailure(current)) return current
  const assigned = (current.assignee ?? '') !== ''
  if (current.status === 'blocked' || (current.status === 'open' && assigned)) {
    const reset = await bd.update(bead, { status: 'open', assignee: '' })
    if (isBdFailure(reset)) return reset
  }
  return bd.claim(bead)
}
