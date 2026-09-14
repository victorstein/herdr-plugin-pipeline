import { expect, test } from 'bun:test'
import { render } from '../src/lib/render'

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
