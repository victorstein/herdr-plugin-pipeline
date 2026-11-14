import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const KIT = join(import.meta.dir, '../../src/kit')
const files = readdirSync(KIT).filter((f) => f.endsWith('.ts'))

test('src/kit is not empty', () => {
  expect(files.length).toBeGreaterThan(0)
})

// the pipeline plugin vendors src/kit as a plain copy, so nothing in it may reach back into pasture
test('kit files import only each other and node builtins', () => {
  for (const file of files) {
    const source = readFileSync(join(KIT, file), 'utf8')
    for (const [, spec] of source.matchAll(/(?:from|import\s*\(?|require\s*\()\s*['"]([^'"]+)['"]/g)) {
      expect({ file, spec, ok: spec!.startsWith('./') || spec!.startsWith('node:') }).toEqual({ file, spec, ok: true })
    }
  }
})

test('kit files never name pasture', () => {
  for (const file of files) expect({ file, named: /pasture/i.test(readFileSync(join(KIT, file), 'utf8')) }).toEqual({ file, named: false })
})
