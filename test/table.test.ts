import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { RUN_ROWS, TASK_ROWS, type PhaseRow } from '../src/lib/phases'

const ALL: readonly PhaseRow<string>[] = [...RUN_ROWS, ...TASK_ROWS]

test('every row with an onBlocker names a counter keyed to itself', () => {
  for (const row of ALL) {
    if (!row.onBlocker) continue
    expect(row.counter, `${row.phase} loops back but names no counter`).toBe(row.phase)
  }
})

test('every counter-bearing row can loop back', () => {
  for (const row of ALL) {
    if (!row.counter) continue
    expect(row.onBlocker, `${row.phase} has a counter but never loops`).toBeDefined()
  }
})

test('every non-terminal row has an onClear or a returnsTo', () => {
  for (const row of ALL) {
    if (row.terminal) continue
    const exits = row.onClear !== undefined || row.returnsTo !== undefined
    expect(exits, `${row.phase} is non-terminal with no exit`).toBe(true)
  }
})

test('every stallable row resolves to a pane or names a probe target', () => {
  for (const row of ALL) {
    if (!row.stallable) continue
    const hasPane = row.actor === 'orchestrator' || row.actor === 'worker'
    expect(hasPane || row.probeTarget !== undefined,
      `${row.phase} is stallable but nothing can be probed`).toBe(true)
  }
})

test('every prompt named by a row exists on disk', () => {
  for (const row of ALL) {
    for (const name of [row.prompt, row.resumePrompt]) {
      if (!name) continue
      const path = join(import.meta.dir, '..', 'prompts', `${name}.md`)
      expect(existsSync(path), `${row.phase} names missing prompt ${name}.md`).toBe(true)
    }
  }
})

test('every resumePrompt names a resumeActor', () => {
  for (const row of ALL) {
    if (!row.resumePrompt) continue
    expect(row.resumeActor, `${row.phase} has a resumePrompt with no actor`).toBeDefined()
  }
})

// Named one by one, not globbed: `prompts/*-review*.md` also matches
// branch-review.md, which is orchestrator-owned and must carry neither.
const WORKER_REVIEW_PROMPTS = ['spec-review', 'plan-review', 'pr-review-intent', 'pr-review-quality']

const promptText = (name: string) =>
  Bun.file(join(import.meta.dir, '..', 'prompts', `${name}.md`)).text()

test('every worker review prompt demands an awaited subagent and a pushed verdict', async () => {
  for (const name of WORKER_REVIEW_PROMPTS) {
    const text = await promptText(name)
    expect(text, `${name}.md must require the subagent be awaited`)
      .toContain('wait for it within this turn')
    expect(text, `${name}.md must require the verdict be pushed`)
      .toContain('Commit and push the verdict')
  }
})

test('branch-review carries neither worker instruction — it is orchestrator-owned', async () => {
  const text = await promptText('branch-review')
  expect(text).not.toContain('wait for it within this turn')
  expect(text).not.toContain('Commit and push the verdict')
})
