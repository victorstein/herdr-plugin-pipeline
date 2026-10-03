import { expect, test } from 'bun:test'
import { formatBeadDetail } from '../src/lib/bead-view'

test('a bead prints its title, status, labels, description, acceptance and comments', () => {
  expect(formatBeadDetail({
    id: 'hp-3', title: 'Fix the meter', status: 'in_progress', assignee: 'hpipe', labels: ['ui', 'plan'],
    metadata: { 'hpipe.run': 'r7', other: 'x' }, description: 'It drifts.\n', acceptance_criteria: 'It holds.',
    comments: [{ text: 'Ruling by the human on t1/d1:\n\nsqlite\n\n[hpipe t1/d1/ruling]' }],
  })).toBe([
    'hp-3 [in_progress] Fix the meter',
    'labels:     ui, plan',
    'assignee:   hpipe',
    'run:        r7',
    '',
    'description:',
    'It drifts.',
    '',
    'acceptance:',
    'It holds.',
    '',
    'comments:',
    '- Ruling by the human on t1/d1:\n  \n  sqlite\n  \n  [hpipe t1/d1/ruling]',
  ].join('\n'))
})

test('a bare bead says none rather than printing blanks', () => {
  const text = formatBeadDetail({ id: 'hp-4', title: 'T', status: 'open' })
  expect(text).toContain('labels:     none')
  expect(text).toContain('assignee:   none')
  expect(text).toContain('description:\n(none)')
  expect(text).toContain('acceptance:\n(none)')
  expect(text).toContain('comments: none')
  expect(text).not.toContain('run:')
})
