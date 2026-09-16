import { join } from 'node:path'
import { installCli } from '../lib/install-cli'

const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, '..', '..')
const result = installCli(pluginRoot, process.env)

for (const line of result.lines) console.log(line)
if (result.ok) {
  console.log('')
  console.log('You do not need this to run the pipeline — agents invoke the CLI by full path.')
  console.log('It is a shorthand for the recovery commands: rewind, release, abort, resume, forget.')
}
process.exit(result.ok ? 0 : 1)
