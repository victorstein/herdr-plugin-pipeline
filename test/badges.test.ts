import { expect, test } from 'bun:test'
import { badgeSource, buildBadges } from '../src/lib/badges'

test('source is the plugin-qualified form herdr requires', () => {
  expect(badgeSource('stein.pipeline')).toBe('plugin:stein.pipeline')
})

test('builds status and branch badges', () => {
  expect(buildBadges({ agent_status: 'working', branch: 'feat/x', phase: 'execute' }))
    .toEqual({ status: 'working', branch: 'feat/x', phase: 'execute' })
})

test('clamps a value longer than 80 characters', () => {
  const long = 'b'.repeat(200)
  expect(buildBadges({ agent_status: 'idle', branch: long, phase: 'ci' }).branch).toHaveLength(80)
})

test('drops an empty value so herdr clears the key', () => {
  expect(buildBadges({ agent_status: 'idle', branch: '', phase: 'ci' }).branch).toBeUndefined()
})
