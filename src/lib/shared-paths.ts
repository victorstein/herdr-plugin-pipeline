import { sha8 } from './batch'
import { fileAt } from './sync-walk'
import type { Run, SharedPaths } from './types'

/** Read from the default branch at `hpipe start`, like `ALWAYS_REVIEW_REL` from a change's base. */
export const SHARED_PATHS_REL = '.claude/pipeline-shared-paths'

const GLOB_CHAR = /[*?[{]/

/**
 * Unlike the always-review list, a glob is ignored rather than cut to its prefix:
 * cutting widens the list, which is safe for review and unsafe here, where
 * `docs/*.md` would stop all of `docs/` from locking.
 */
export function sharedPathPrefixes(text: string): { prefixes: string[]; ignored: string[] } {
  const prefixes: string[] = []
  const ignored: string[] = []
  for (const line of text.split('\n')) {
    const entry = line.replace(/#.*$/, '').trim()
    if (entry.length === 0) continue
    const path = entry.replace(/^(\.\/|\/)+/, '')
    if (GLOB_CHAR.test(path) || path.length === 0 || path === '.') ignored.push(entry)
    else prefixes.push(path)
  }
  return { prefixes, ignored }
}

export const sharedPrefixesOf = (run: Pick<Run, 'shared_paths'>): string[] => run.shared_paths?.prefixes ?? []

/** A plain prefix test, as `--files` entries overlap. */
export const isSharedPath = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path.startsWith(prefix))

/** The record says what a task touches, so a shared entry is printed too, marked as one that does not lock. */
export function describeFiles(run: Pick<Run, 'shared_paths'>, files: readonly string[]): string {
  if (files.length === 0) return 'none'
  const shared = sharedPrefixesOf(run)
  return files.map((path) => (isSharedPath(path, shared) ? `${path} (shared)` : path)).join(', ')
}

/** Names the snapshot's commit, so a list changed mid-run shows as not yet in force. */
export function sharedStatusLine(run: Pick<Run, 'shared_paths'>): string | null {
  const shared = run.shared_paths
  if (shared === undefined || shared.prefixes.length === 0) return null
  return `shared: ${shared.prefixes.join(', ')} (from ${shared.commit === null ? shared.ref : sha8(shared.commit)})`
}

/** The commit `start` cuts the run from, and how its start line describes it. */
export interface SharedPathsSource {
  /** What git reads the file at: the commit, or the ref when none resolved. */
  at: string
  commit: string | null
  ref: string
  described: string
}

/** Never refuses: an unreadable file shares nothing, which locks every path as before. */
export async function readSharedPaths(
  repoRoot: string, source: SharedPathsSource, now: () => number = Date.now,
): Promise<SharedPaths> {
  const read = await fileAt(repoRoot, source.at, SHARED_PATHS_REL)
  const snapshot = { commit: source.commit, ref: source.ref, read_at: now() }
  if (!read.ok) {
    return { prefixes: [], ignored: [], ...snapshot, error: `git could not read ${SHARED_PATHS_REL} at ${source.at}` }
  }
  return { ...sharedPathPrefixes(read.text ?? ''), ...snapshot }
}

const whyIgnored = (entry: string): string =>
  GLOB_CHAR.test(entry) ? 'a glob would share more than it names: list each path' : 'it would share the whole repo'

export function startSharedLines(shared: SharedPaths, described: string): string[] {
  if (shared.error !== undefined) return [`⚠ shared: ${shared.error}: nothing is shared, so every declared path locks`]
  const at = shared.commit === null ? shared.ref : sha8(shared.commit)
  return [
    ...(shared.prefixes.length === 0 ? [] : [
      `shared: ${shared.prefixes.join(', ')} — from ${SHARED_PATHS_REL} at ${at} (${described}); never locked`,
    ]),
    ...shared.ignored.map((entry) => `⚠ shared: ignored "${entry}" in ${SHARED_PATHS_REL} — ${whyIgnored(entry)}`),
  ]
}
