import { cpSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const from = process.env.PASTURE_DIR ?? join(process.env.HOME ?? '', 'Documents/development/personal/herdr-pasture')
const here = join(import.meta.dir, '..')
for (const dir of ['src/kit', 'test/kit']) {
  if (!existsSync(join(from, dir))) throw new Error(`no ${dir} in ${from}; set PASTURE_DIR`)
  // a plain replace, so a file deleted upstream does not linger here
  rmSync(join(here, dir), { recursive: true, force: true })
  cpSync(join(from, dir), join(here, dir), { recursive: true })
}
const diff = Bun.spawnSync(['git', '-C', here, 'status', '--short', '--', 'src/kit', 'test/kit'], { stdout: 'pipe' })
console.log(diff.stdout.toString() || 'kit unchanged')
