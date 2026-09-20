import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Printed verbatim into prompts as well as resolved on disk; one constant for both. */
export const BOOTSTRAP_REL = '.claude/pipeline-bootstrap'

export type Bootstrap =
  | { kind: 'none' }
  | { kind: 'ready' }
  | { kind: 'not-executable' }

/**
 * Whether a repo declares a worktree bootstrap. Pure filesystem: it never reads
 * the file, never spawns, and never throws — `cmdTask` and the supervisor both
 * compose their output through this, and a throw there surfaces to an agent.
 *
 * `repoRoot` is a directory with no ref in it (`src/lib/repo.ts:17-25`), so this
 * reads whatever branch the primary checkout is parked on, not the base the
 * worktree is cut from.
 */
export function repoBootstrap(repoRoot: string): Bootstrap {
  try {
    const path = join(repoRoot, BOOTSTRAP_REL)
    if (!existsSync(path)) return { kind: 'none' }
    const info = statSync(path)
    // A directory carries the executable bits, so isFile() is what excludes one.
    if (!info.isFile()) return { kind: 'none' }
    return (info.mode & 0o111) === 0 ? { kind: 'not-executable' } : { kind: 'ready' }
  } catch {
    return { kind: 'none' }
  }
}
