import { realpathSync } from 'node:fs'
import { join } from 'node:path'

// Matches any {{...}} token, not just \w+, so a hyphenated or dotted name
// fails loudly instead of shipping through to an agent verbatim.
const PLACEHOLDER = /\{\{([^}]*)\}\}/g

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`unresolved template placeholder: ${name}`)
    return value
  })
}

/**
 * How an agent should invoke this plugin's CLI.
 *
 * herdr's manifest has no way to put a binary on PATH — `[[build]]` runs only on
 * GitHub install, never on `plugin link` — so a plugin installed from GitHub has
 * no `hpipe`, and every prompt that names one would be uninvokable. Rendering the
 * absolute invocation instead makes both install paths behave identically.
 *
 * PATH is trusted only when it resolves back into this plugin: a symlink left
 * over from another checkout would otherwise point agents at a different
 * codebase's CLI, driving the wrong ledger.
 */
export function hpipeCommand(pluginRoot: string): string {
  const onPath = Bun.which('hpipe')
  if (onPath !== null) {
    try {
      if (realpathSync(onPath).startsWith(realpathSync(pluginRoot))) return 'hpipe'
    } catch {
      // Fall through to the absolute invocation.
    }
  }
  return `bun run ${join(pluginRoot, 'src', 'cli.ts')}`
}

export async function renderPrompt(
  pluginRoot: string, name: string, vars: Record<string, string>,
): Promise<string> {
  const template = await Bun.file(join(pluginRoot, 'prompts', `${name}.md`)).text()
  // Injected here rather than added to each caller's bag: there are eighteen
  // render sites and a missed one throws at delivery, in front of an agent.
  return render(template, { hpipe: hpipeCommand(pluginRoot), ...vars })
}
