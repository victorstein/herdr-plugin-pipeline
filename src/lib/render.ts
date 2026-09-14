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

export async function renderPrompt(
  pluginRoot: string, name: string, vars: Record<string, string>,
): Promise<string> {
  const template = await Bun.file(join(pluginRoot, 'prompts', `${name}.md`)).text()
  return render(template, vars)
}
