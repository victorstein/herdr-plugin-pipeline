import { statSync } from 'node:fs'
import { join } from 'node:path'

/** Printed verbatim into prompts as well as resolved on disk, like `BOOTSTRAP_REL`. */
export const CHECK_REL = '.claude/pipeline-check'

export type Check = { kind: 'none' } | { kind: 'ready' } | { kind: 'not-executable' }

/**
 * Whether a repo declares the check a single-PR landing is re-tested with. With
 * no per-task CI it is the only test a landed tree gets before the final PR.
 * Pure filesystem and never throws, like `repoBootstrap`.
 */
export function repoCheck(root: string): Check {
  try {
    const info = statSync(join(root, CHECK_REL))
    if (!info.isFile()) return { kind: 'none' }
    return (info.mode & 0o111) === 0 ? { kind: 'not-executable' } : { kind: 'ready' }
  } catch {
    return { kind: 'none' }
  }
}

export function checkLine(check: Check): string {
  if (check.kind === 'none') {
    return "check: none — each landing is checked only by its worker's own test run, and status says so"
  }
  if (check.kind === 'not-executable') {
    return `check: ${CHECK_REL} (NOT EXECUTABLE — chmod +x it on the default branch, or every submit refuses)`
  }
  return `check: ${CHECK_REL}`
}
