import { chmodSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Writes an executable that echoes a canned JSON response per argv prefix and
 * appends every invocation to `calls.log`. Responses are matched on the longest
 * prefix, so 'pane list' wins over 'pane'.
 */
export async function makeFakeBin(
  dir: string,
  responses: Record<string, unknown>,
  exitCodes: Record<string, number> = {},
): Promise<string> {
  const path = join(dir, 'fake-bin')
  const table = JSON.stringify(responses)
  const codes = JSON.stringify(exitCodes)

  await Bun.write(path, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, argv.join(' ') + '\\n')
const table = ${table}
const codes = ${codes}
const joined = argv.join(' ')
const key = Object.keys(table)
  .filter((k) => joined.startsWith(k))
  .sort((a, b) => b.length - a.length)[0]
if (key === undefined) {
  process.stdout.write(JSON.stringify({ error: { code: 'unstubbed', message: joined } }))
  process.exit(1)
}
process.stdout.write(JSON.stringify(table[key]))
process.exit(codes[key] ?? 0)
`)
  chmodSync(path, 0o755)
  return path
}
