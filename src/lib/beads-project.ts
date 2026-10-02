import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readJson, writeJson } from './store'

export interface BeadsProject {
  repo_root: string
  prefix: string
  created_at: number
}

const PREFIX_MAX_CHARS = 8
const SLUG_HASH_CHARS = 6

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function repoName(repoKey: string): string {
  return sanitise(basename(repoKey)) || 'repo'
}

export function beadsSlug(repoKey: string): string {
  const hash = createHash('sha256').update(repoKey).digest('hex').slice(0, SLUG_HASH_CHARS)
  return `${repoName(repoKey)}-${hash}`
}

/** bd trims a trailing `-` from the prefix it stores, so the one recorded here is trimmed the same way. */
export function defaultPrefix(repoKey: string): string {
  return repoName(repoKey).slice(0, PREFIX_MAX_CHARS).replace(/-+$/, '')
}

export function normalisePrefix(raw: string): string | null {
  const prefix = raw.trim().toLowerCase().replace(/-+$/, '')
  return /^[a-z0-9][a-z0-9-]*$/.test(prefix) ? prefix : null
}

export const beadsRoot = (stateDir: string): string => join(stateDir, 'beads')
export const beadsHome = (stateDir: string, slug: string): string => join(beadsRoot(stateDir), slug)
export const beadsDir = (stateDir: string, slug: string): string => join(beadsHome(stateDir, slug), '.beads')
export const beadsExportPath = (stateDir: string, slug: string): string =>
  join(beadsDir(stateDir, slug), 'issues.jsonl')
const projectPath = (stateDir: string, slug: string): string => join(beadsHome(stateDir, slug), 'project.json')

/**
 * The ceiling stops every bd and bv spawn from finding a git work tree that
 * encloses the state dir — a dotfiles repo at $HOME, say — and committing into it.
 */
export function beadsSpawnEnv(stateDir: string, slug: string): Record<string, string | undefined> {
  return { ...process.env, BEADS_DIR: beadsDir(stateDir, slug), GIT_CEILING_DIRECTORIES: beadsRoot(stateDir) }
}

export async function readBeadsProject(stateDir: string, slug: string): Promise<BeadsProject | null> {
  return readJson<BeadsProject>(projectPath(stateDir, slug))
}

export async function writeBeadsProject(stateDir: string, slug: string, project: BeadsProject): Promise<void> {
  await writeJson(projectPath(stateDir, slug), project)
}

export async function prefixOwner(stateDir: string, prefix: string, exceptSlug: string): Promise<BeadsProject | null> {
  let slugs: string[]
  try {
    slugs = readdirSync(beadsRoot(stateDir))
  } catch {
    return null
  }
  for (const slug of slugs.filter((s) => s !== exceptSlug).sort()) {
    const project = await readBeadsProject(stateDir, slug)
    if (project?.prefix === prefix) return project
  }
  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The state dir is the only copy of the backlog. A store set up again after it
 * was lost restarts its counter at `<prefix>-1`, and new artifact stems would
 * collide with ones already committed under these names.
 */
export function prefixCollisions(repoRoot: string, prefix: string): string[] {
  const root = join(repoRoot, 'docs', 'superpowers')
  if (!existsSync(root)) return []
  const named = new RegExp(`(^|[^a-z0-9])${escapeRegExp(prefix)}-\\d+($|[^0-9])`)
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((path) => named.test(basename(path)))
    .map((path) => join('docs', 'superpowers', path))
    .sort()
}
