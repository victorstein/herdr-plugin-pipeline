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

/** The pipeline's own documents: a change made of these alone is nothing to land. */
export const landsNothing = (path: string): boolean => path.startsWith(`${ARTIFACT_ROOT}/`)

/**
 * Tree-based, not ancestry-based: a branch whose only new commit is a merge of the
 * batch is not contained in it, yet it changes nothing but the task's own docs.
 */
export async function nothingToLand(checkout: string, batchRef: string): Promise<boolean | null> {
  const changed = await git(checkout, ['-c', 'core.quotePath=false', 'diff', '--name-only', `${batchRef}...HEAD`])
  if (changed.code !== 0) return null
  return changed.out.split('\n').filter((path) => path.length > 0).every(landsNothing)
}

export async function resolveCommit(repoRoot: string, ref: string): Promise<string | null> {
  const resolved = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  return resolved.code === 0 ? resolved.out : null
}

/**
 * Every path `head` changes since its merge base with `base`, one `added\tdeleted\tpath`
 * record per NUL. Null when git could not compare them, never an empty change.
 */
export async function numstat(repoRoot: string, base: string, head: string): Promise<string | null> {
  const diff = await git(repoRoot, ['diff', '--numstat', '-z', '--no-renames', `${base}...${head}`])
  return diff.code === 0 ? diff.out : null
}

export type FileAtRef = { ok: true; text: string | null } | { ok: false }

/** A file's text at `ref`; `text: null` when `ref` has no such file, and not ok when git could not say. */
export async function fileAt(repoRoot: string, ref: string, path: string): Promise<FileAtRef> {
  const listed = await git(repoRoot, ['ls-tree', '--name-only', ref, '--', path])
  if (listed.code !== 0) return { ok: false }
  if (listed.out.length === 0) return { ok: true, text: null }
  const shown = await git(repoRoot, ['show', `${ref}:${path}`])
  return shown.code === 0 ? { ok: true, text: shown.out } : { ok: false }
}

/** Null when either commit is not in this object store, so the caller cannot mistake it for no change. */
export async function changedPaths(repoRoot: string, from: string, to: string): Promise<string[] | null> {
  const diff = await git(repoRoot, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', from, to])
  if (diff.code !== 0) return null
  return diff.out.split('\n').filter((path) => path.length > 0)
}
