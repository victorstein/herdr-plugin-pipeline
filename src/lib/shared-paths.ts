import type { Run } from './types'

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
