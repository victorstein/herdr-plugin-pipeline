import { existsSync, lstatSync, mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface InstallResult {
  ok: boolean
  target: string
  lines: string[]
}

/** `~/.local/bin` unless HPIPE_BIN_DIR says otherwise. */
export function binDir(env: Record<string, string | undefined>): string {
  return env.HPIPE_BIN_DIR ?? join(env.HOME ?? '', '.local', 'bin')
}

export function onPath(dir: string, env: Record<string, string | undefined>): boolean {
  return (env.PATH ?? '').split(delimiter).includes(dir)
}

/**
 * Links `bin/hpipe` — the wrapper — rather than `src/cli.ts`. Linking the CLI
 * directly pins hand-typed commands to whichever copy was linked, while the
 * installed supervisor drives the same ledger; the wrapper asks herdr which
 * copy is installed at call time instead.
 */
export function installCli(
  pluginRoot: string, env: Record<string, string | undefined>,
): InstallResult {
  const source = join(pluginRoot, 'bin', 'hpipe')
  const dir = binDir(env)
  const target = join(dir, 'hpipe')
  const lines: string[] = []

  if (!existsSync(source)) {
    return { ok: false, target, lines: [`no wrapper at ${source} — is this a complete checkout?`] }
  }

  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    return { ok: false, target, lines: [`could not create ${dir}: ${String(err)}`] }
  }

  if (existsSync(target) || isDanglingLink(target)) {
    // Both sides go through realpath: on macOS /var is a symlink to /private/var,
    // so comparing a resolved path against a raw one never matches and every run
    // reports a replacement it did not need to make.
    const existing = describeExisting(target)
    if (existing !== null && existing === describeExisting(source)) {
      return { ok: true, target, lines: [`already linked: ${target}`] }
    }
    try {
      unlinkSync(target)
      lines.push(`replaced ${existing ?? 'an existing file'}`)
    } catch (err) {
      return { ok: false, target, lines: [`${target} exists and could not be replaced: ${String(err)}`] }
    }
  }

  try {
    symlinkSync(source, target)
  } catch (err) {
    return { ok: false, target, lines: [...lines, `could not link ${target}: ${String(err)}`] }
  }

  lines.push(`linked ${target} -> ${source}`)
  if (!onPath(dir, env)) {
    lines.push(`${dir} is not on your PATH — add it, or run the wrapper by its full path`)
  }
  return { ok: true, target, lines }
}

function isDanglingLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function describeExisting(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
