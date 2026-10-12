import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ConventionalTitle {
  type: string
  breaking: boolean
}

const TITLE = /^([a-z]+)(\([^()\s]+\))?(!)?: \S/

export function parseTitle(title: string): ConventionalTitle | null {
  if (title.includes('\n')) return null
  const match = TITLE.exec(title)
  return match === null ? null : { type: match[1]!, breaking: match[3] === '!' }
}

export interface ReleaseSection { type: string; hidden?: boolean }

/**
 * release-please's own list for a repo that configures none. Its version on the
 * target repos is not pinned here; the smoke run checks it (Verify 6).
 */
export const DEFAULT_RELEASE_SECTIONS: readonly ReleaseSection[] = [
  { type: 'feat' }, { type: 'fix' }, { type: 'perf' }, { type: 'revert' },
  { type: 'docs', hidden: true }, { type: 'style', hidden: true }, { type: 'chore', hidden: true },
  { type: 'refactor', hidden: true }, { type: 'test', hidden: true }, { type: 'build', hidden: true },
  { type: 'ci', hidden: true },
]

const CONFIG_FILE = 'release-please-config.json'

/** The repo's `changelog-sections`, at the top level or on its root package; release-please's default without one. */
export function releaseSections(repoRoot: string): readonly ReleaseSection[] {
  type Sections = { 'changelog-sections'?: ReleaseSection[] }
  let config: Sections & { packages?: Record<string, Sections> }
  try {
    config = JSON.parse(readFileSync(join(repoRoot, CONFIG_FILE), 'utf8'))
  } catch {
    return DEFAULT_RELEASE_SECTIONS
  }
  return config.packages?.['.']?.['changelog-sections'] ?? config['changelog-sections'] ?? DEFAULT_RELEASE_SECTIONS
}

export type TitleCheck = { ok: true; note: string | null } | { ok: false; error: string }

/**
 * A title becomes one line of the batch's release notes, so it must be one
 * release-please reads: `feet:` passes the pattern and is silently dropped.
 */
export function checkReleaseTitle(title: string, sections: readonly ReleaseSection[]): TitleCheck {
  const parsed = parseTitle(title)
  if (parsed === null) {
    return {
      ok: false,
      error: '--title must be one conventional line, `<type>(<scope>)!: <summary>` with the scope and `!` optional, ' +
        `got: ${title}`,
    }
  }
  const section = sections.find((s) => s.type === parsed.type)
  if (section === undefined) {
    return { ok: false, error: `--title's type \`${parsed.type}\` is not one this repo's release notes read; ` +
      `use one of ${sections.map((s) => s.type).join(', ')}` }
  }
  return {
    ok: true,
    note: section.hidden === true
      ? `\`${parsed.type}\` is hidden from this repo's release notes, so this change will not appear in them`
      : null,
  }
}
