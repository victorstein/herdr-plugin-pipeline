import { chmodSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Writes an executable that echoes a canned JSON response per argv prefix and
 * appends every invocation to `calls.log`. Responses are matched on the longest
 * prefix, so 'pane list' wins over 'pane'. An `error` envelope goes to stderr
 * with exit 1 and nothing on stdout, which is what herdr 0.9.0 does. A string
 * response is printed as it is, the way herdr 0.9.0 prints `pane read`.
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
// Require a token boundary after the match: without it, a stub for
// 'agent get w1:p1' silently answers 'agent get w1:p10' with the wrong payload.
const key = Object.keys(table)
  .filter((k) => joined === k || joined.startsWith(k + ' '))
  .sort((a, b) => b.length - a.length)[0]
if (key === undefined) {
  process.stderr.write(JSON.stringify({ error: { code: 'unstubbed', message: joined } }))
  process.exit(1)
}
const response = table[key]
const isError = typeof response === 'object' && response !== null && 'error' in response
;(isError ? process.stderr : process.stdout)
  .write(typeof response === 'string' ? response : JSON.stringify(response))
process.exit(codes[key] ?? (isError ? 1 : 0))
`)
  chmodSync(path, 0o755)
  return path
}
