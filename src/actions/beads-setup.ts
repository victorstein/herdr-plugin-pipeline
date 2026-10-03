import { setupBeads, setupLines } from '../lib/beads-setup'
import { repoContext } from '../lib/repo'
import { bdProblem, checkBd } from '../lib/tools'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
if (!stateDir) process.exit(0)

const repo = await repoContext()
if (!repo) {
  console.error('[pipeline] "Set up Beads for this repo" must be invoked from a pane inside a git repository')
  process.exit(1)
}

const broken = bdProblem(await checkBd())
if (broken !== null) {
  console.error(`[pipeline] ${broken}`)
  process.exit(1)
}

// herdr actions take no input, so the prefix override rides in the environment.
const result = await setupBeads({
  stateDir, repoKey: repo.repoKey, repoRoot: repo.repoRoot, prefix: process.env.HPIPE_BEADS_PREFIX ?? null,
})
if (!result.ok) {
  console.error(`[pipeline] ${result.error}`)
  process.exit(1)
}
for (const line of setupLines(result, stateDir)) console.log(`[pipeline] ${line}`)
