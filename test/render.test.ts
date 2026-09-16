import { join } from 'node:path'
import { expect, test } from 'bun:test'
import { hpipeCommand, render, renderPrompt } from '../src/lib/render'

test('substitutes every placeholder', () => {
  expect(render('spec at {{spec_path}} for {{title}}', { spec_path: '/a.md', title: 'x' }))
    .toBe('spec at /a.md for x')
})

test('substitutes a repeated placeholder', () => {
  expect(render('{{a}}/{{a}}', { a: 'x' })).toBe('x/x')
})

test('throws naming the unresolved placeholder', () => {
  expect(() => render('hello {{missing}}', { a: 'x' }))
    .toThrow('unresolved template placeholder: missing')
})

test('an empty-string value is legal and is not an unresolved placeholder', () => {
  expect(render('[{{note}}]', { note: '' })).toBe('[]')
})

test('the CLI invocation falls back to an absolute bun run when hpipe is not this plugin', () => {
  // herdr cannot put a binary on PATH, so a GitHub-installed plugin has no
  // `hpipe` and every prompt naming one would be uninvokable.
  const cmd = hpipeCommand('/nonexistent/plugin/root')
  expect(cmd).toBe('bun run /nonexistent/plugin/root/src/cli.ts')
})

test('hpipe on PATH is used only when it resolves into this plugin', () => {
  // A symlink left from another checkout would otherwise aim agents at a
  // different codebase's CLI, driving the wrong ledger.
  const real = hpipeCommand(join(import.meta.dir, '..'))
  const foreign = hpipeCommand('/nonexistent/plugin/root')
  expect(foreign.startsWith('bun run ')).toBe(true)
  expect(['hpipe', `bun run ${join(import.meta.dir, '..', 'src', 'cli.ts')}`]).toContain(real)
})

test('renderPrompt supplies hpipe without the caller passing it', async () => {
  const out = await renderPrompt(join(import.meta.dir, '..'), 'escalate', {
    run_id: 'r1', phase: 'spec', pass: '1', task_flag: '',
  })
  expect(out).not.toContain('{{hpipe}}')
  expect(out).toMatch(/(hpipe|src\/cli\.ts) rewind/)
})
