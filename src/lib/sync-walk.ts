import { ARTIFACT_ROOT } from './verdict-path'

/**
 * Whether every commit since the reviewed head is an automatic merge of the batch.
 * A clean sync holds no line the batch's own reviews did not judge, so it is only
 * re-tested; anything else is code no reviewer has seen, and goes back to review.
 */
export type SyncWalk = { clean: true } | { clean: false; at: string; why: string }

interface GitOut { code: number; out: string }

async function git(checkout: string, args: string[]): Promise<GitOut> {
  try {
    const proc = Bun.spawn(['git', '-C', checkout, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(proc.stdout).text()
    return { code: await proc.exited, out: out.trim() }
  } catch {
    return { code: -1, out: '' }
  }
}

export async function headOf(checkout: string): Promise<string | null> {
  const head = await git(checkout, ['rev-parse', 'HEAD'])
  return head.code === 0 ? head.out : null
}

/** Exit 0 is yes and 1 is no; anything else is a read that failed, and the caller decides what that means. */
export async function isAncestor(checkout: string, ancestor: string, of: string): Promise<boolean | null> {
  const { code } = await git(checkout, ['merge-base', '--is-ancestor', ancestor, of])
  return code === 0 ? true : code === 1 ? false : null
}

/**
 * The first-parent walk from HEAD back to `reviewed`. Every commit on the way must
 * have exactly two parents, a second parent already on the batch, and the tree
 * `git merge-tree --write-tree` builds from them, with no conflict. Reaching the
 * batch or the root without meeting `reviewed` is dirty too, which covers a rebase.
 * `merge-tree` honours the repo's merge attributes as `git merge` does; a driver
 * missing from this environment reads as a conflict, which errs dirty.
 */
export async function syncWalk(checkout: string, reviewed: string | null, batchRef: string): Promise<SyncWalk> {
  const head = (await git(checkout, ['rev-parse', 'HEAD'])).out
  if (reviewed === null) return { clean: false, at: head, why: 'no reviewed head is recorded to walk back to' }
  const stop = (await git(checkout, ['rev-parse', '--verify', '--quiet', `${reviewed}^{commit}`])).out
  for (let commit = head; commit !== stop;) {
    if (await isAncestor(checkout, commit, batchRef) !== false) {
      return { clean: false, at: commit, why: 'the walk reached the batch branch without meeting the reviewed head' }
    }
    const parents = (await git(checkout, ['rev-list', '--parents', '-n', '1', commit])).out.split(' ').slice(1)
    if (parents.length !== 2) return { clean: false, at: commit, why: 'not a merge' }
    const [first, second] = parents as [string, string]
    if (await isAncestor(checkout, second, batchRef) !== true) {
      return { clean: false, at: commit, why: 'its second parent is not on the batch branch' }
    }
    const merged = await git(checkout, ['merge-tree', '--write-tree', first, second])
    if (merged.code !== 0) return { clean: false, at: commit, why: 'the automatic merge of its parents conflicts' }
    const tree = (await git(checkout, ['rev-parse', `${commit}^{tree}`])).out
    if (merged.out.split('\n')[0] !== tree) {
      return { clean: false, at: commit, why: 'its tree is not the automatic merge of its parents' }
    }
    commit = first
  }
  return { clean: true }
}

/**
 * Tree-based, not ancestry-based: a branch whose only new commit is a merge of the
 * batch is not contained in it, yet it changes nothing but the task's own docs.
 */
export async function nothingToLand(checkout: string, batchRef: string): Promise<boolean | null> {
  const changed = await git(checkout, [
    'diff', '--name-only', `${batchRef}...HEAD`, '--', '.', `:(exclude)${ARTIFACT_ROOT}/`,
  ])
  if (changed.code !== 0) return null
  return changed.out.length === 0
}

export async function resolveCommit(repoRoot: string, ref: string): Promise<string | null> {
  const resolved = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return resolved.code === 0 ? resolved.out : null
}

/** Null when either commit is not in this object store, so the caller cannot mistake it for no change. */
export async function changedPaths(repoRoot: string, from: string, to: string): Promise<string[] | null> {
  const diff = await git(repoRoot, ['diff', '--name-only', '--no-renames', from, to])
  if (diff.code !== 0) return null
  return diff.out.split('\n').filter((path) => path.length > 0)
}
