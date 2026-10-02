import { mkdirSync } from 'node:fs'
import { Bd, CLI_LOCK_WAIT_MS, isBdFailure, type BdFailure, type Done } from './bd'
import {
  beadsHome, beadsSlug, defaultPrefix, normalisePrefix, prefixCollisions, prefixOwner,
  readBeadsProject, writeBeadsProject,
} from './beads-project'
import { runBounded } from './spawn'

export interface SetupInput {
  stateDir: string
  repoKey: string
  repoRoot: string
  prefix: string | null
}

export type SetupResult =
  | { ok: true; slug: string; prefix: string; created: boolean; notes: string[] }
  | { ok: false; error: string }

export interface SetupDeps {
  initStore: (stateDir: string, slug: string, prefix: string) => Promise<Done | BdFailure>
  enclosingWorkTree: (dir: string) => Promise<boolean>
  now: () => number
}

const GIT_CHECK_TIMEOUT_MS = 10_000
const COLLISIONS_NAMED = 3

/** Run WITHOUT the ceiling on purpose: it reports the work tree the ceiling exists to hide. */
async function insideGitWorkTree(dir: string): Promise<boolean> {
  const out = await runBounded(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: dir, timeoutMs: GIT_CHECK_TIMEOUT_MS })
  return out.code === 0 && out.stdout.trim() === 'true'
}

export const REAL_SETUP_DEPS: SetupDeps = {
  initStore: (stateDir, slug, prefix) => new Bd({ stateDir, slug, lockWaitMs: CLI_LOCK_WAIT_MS }).initStore(prefix),
  enclosingWorkTree: insideGitWorkTree,
  now: Date.now,
}

export async function setupBeads(input: SetupInput, deps: SetupDeps = REAL_SETUP_DEPS): Promise<SetupResult> {
  const slug = beadsSlug(input.repoKey)
  const existing = await readBeadsProject(input.stateDir, slug)
  if (existing !== null) {
    const ignored = input.prefix !== null && normalisePrefix(input.prefix) !== existing.prefix
      ? [`this repo's Beads store already uses prefix ${existing.prefix}; --prefix ${input.prefix} was ignored`]
      : []
    return { ok: true, slug, prefix: existing.prefix, created: false, notes: ignored }
  }

  const requested = input.prefix ?? defaultPrefix(input.repoKey)
  const prefix = normalisePrefix(requested)
  if (prefix === null) {
    return {
      ok: false,
      error: input.prefix === null
        ? `this repo's name gives the Beads prefix ${requested}, which does not start with a letter — pass --prefix <another>`
        : `--prefix must start with a letter and hold only lowercase letters, digits and dashes, got: ${input.prefix}`,
    }
  }
  const owner = await prefixOwner(input.stateDir, prefix, slug)
  if (owner !== null) {
    return { ok: false, error: `prefix ${prefix} is already the Beads prefix of ${owner.repo_root} — pass --prefix <another>` }
  }
  const collisions = prefixCollisions(input.repoRoot, prefix)
  if (collisions.length > 0) {
    const named = collisions.slice(0, COLLISIONS_NAMED).join(', ') + (collisions.length > COLLISIONS_NAMED ? ', …' : '')
    return {
      ok: false,
      error: `docs/superpowers already holds artifacts named ${prefix}-<n> (${named}); a new store's counter ` +
        'would reuse those names — pass --prefix <another>',
    }
  }

  const home = beadsHome(input.stateDir, slug)
  mkdirSync(home, { recursive: true })
  const notes = (await deps.enclosingWorkTree(home))
    ? [`${home} sits inside a git work tree; every bd and bv call runs with GIT_CEILING_DIRECTORIES set, so none commits into it`]
    : []
  const initialised = await deps.initStore(input.stateDir, slug, prefix)
  if (isBdFailure(initialised)) {
    return { ok: false, error: `bd init failed in ${home}; nothing was recorded:\n  ${initialised.error}` }
  }
  await writeBeadsProject(input.stateDir, slug, { repo_root: input.repoRoot, prefix, created_at: deps.now() })
  return { ok: true, slug, prefix, created: true, notes }
}

export function setupLines(result: Extract<SetupResult, { ok: true }>, stateDir: string): string[] {
  const home = beadsHome(stateDir, result.slug)
  return [
    result.created ? `beads: created ${home} with prefix ${result.prefix}` : `beads: prefix ${result.prefix}, store ${home}`,
    ...result.notes.map((note) => `beads: ${note}`),
  ]
}
