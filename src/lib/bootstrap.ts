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

/**
 * One line, in the `files:` shape, addressed to the orchestrator. Single-line is
 * a contract rather than a style: see the test that pins it.
 */
export function bootstrapLine(b: Bootstrap): string {
  if (b.kind === 'none') return 'bootstrap: none'
  if (b.kind === 'not-executable') {
    return `bootstrap: ${BOOTSTRAP_REL} (NOT EXECUTABLE — chmod +x it on the base branch)`
  }
  return `bootstrap: ${BOOTSTRAP_REL}`
}

/**
 * The worker's copy. Conditional on purpose: the orchestrator may have skipped
 * the line entirely, so this offers a recovery rather than asserting a state.
 */
export function briefNote(b: Bootstrap): string {
  if (b.kind === 'none') return ''
  // The wrap falls after `run`: break it one word earlier and `should have been
  // run` spans a newline plus `> `, which weakens the test that holds this note
  // conditional rather than assertive.
  const caveat = b.kind === 'not-executable'
    ? ` It is not executable — \`chmod +x ${BOOTSTRAP_REL}\` before you run it.`
    : ''
  return `> This repo declares a worktree bootstrap at \`./${BOOTSTRAP_REL}\`, which should have been run\n` +
    '> in this checkout before you started. If a build, test or typecheck fails on a missing\n' +
    `> dependency, run it yourself rather than installing anything by hand.${caveat}`
}
