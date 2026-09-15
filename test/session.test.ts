import { expect, test } from 'bun:test'
import { sessionKey } from '../src/lib/session'

test('prefers HERDR_SESSION when set', () => {
  expect(sessionKey({ HERDR_SESSION: 'personal' })).toBe('personal')
})

test('ignores an empty HERDR_SESSION', () => {
  expect(sessionKey({ HERDR_SESSION: '', HERDR_SOCKET_PATH: '/x/herdr.sock' })).toBe('default')
})

test('parses a named session out of the socket path', () => {
  const env = { HERDR_SOCKET_PATH: '/Volumes/stein/.config/herdr/sessions/personal/herdr.sock' }
  expect(sessionKey(env)).toBe('personal')
})

test('falls back to default for the unnamed session socket', () => {
  expect(sessionKey({ HERDR_SOCKET_PATH: '/Volumes/stein/.config/herdr/herdr.sock' })).toBe('default')
})

test('falls back to default with no env at all', () => {
  expect(sessionKey({})).toBe('default')
})
