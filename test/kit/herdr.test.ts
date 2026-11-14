import { afterEach, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient, HerdrError, subscribe } from '../../src/kit/herdr'

let server: Server | null = null
afterEach(() => server?.close())

async function serve(onRequest: (sock: Socket, req: { id: string; method: string; params: unknown }) => void): Promise<string> {
  const path = join(mkdtempSync(join(tmpdir(), 'kit-')), 's.sock')
  server = createServer((sock) => sock.on('data', (d) => onRequest(sock, JSON.parse(d.toString()))))
  await new Promise<void>((resolve) => server!.listen(path, resolve))
  return path
}

test('call sends one NDJSON request and resolves its result', async () => {
  const seen: unknown[] = []
  const path = await serve((sock, req) => {
    seen.push(req)
    sock.write(JSON.stringify({ id: req.id, result: { type: 'pong' } }) + '\n')
  })
  expect(await createClient(path).call<{ type: string }>('ping')).toEqual({ type: 'pong' })
  expect(seen[0]).toMatchObject({ method: 'ping', params: {} })
})

test('call rejects with the herdr error code', async () => {
  const path = await serve((sock, req) => sock.write(JSON.stringify({ id: req.id, error: { code: 'not_found', message: 'no pane' } }) + '\n'))
  const err = (await createClient(path).call('pane.get', { pane_id: 'x' }).catch((e) => e)) as HerdrError
  expect(err).toBeInstanceOf(HerdrError)
  expect(err.code).toBe('not_found')
})

test('subscribe reports each pushed event and ends when the socket closes', async () => {
  const path = await serve((sock, req) => {
    sock.write(
      JSON.stringify({ id: req.id, result: { type: 'subscription_started' } }) + '\n' +
      JSON.stringify({ event: 'pane.closed', data: {} }) + '\n' +
      JSON.stringify({ event: 'pane.moved', data: {} }) + '\n',
    )
    sock.end()
  })
  let events = 0
  await new Promise<void>((resolve) => subscribe([{ type: 'pane.closed' }], () => events++, resolve, path))
  expect(events).toBe(2)
})

test('call rejects when herdr closes the socket without replying', async () => {
  const path = await serve((sock) => sock.end())
  const err = (await createClient(path).call('ping').catch((e) => e)) as HerdrError
  expect(err).toBeInstanceOf(HerdrError)
  expect(err.code).toBe('closed')
})

test('call rejects on a reply that is not JSON', async () => {
  const path = await serve((sock) => sock.write('not json\n'))
  const err = await createClient(path).call('ping').catch((e) => e)
  expect(err).toBeInstanceOf(Error)
})

test('subscribe ends the stream on a line that is not JSON', async () => {
  const path = await serve((sock) => sock.write('not json\n'))
  await new Promise<void>((resolve) => subscribe([{ type: 'pane.closed' }], () => {}, resolve, path))
})

test('call rejects with a timeout when herdr never replies', async () => {
  const path = await serve(() => {})
  const err = (await createClient(path, 50).call('ping').catch((e) => e)) as HerdrError
  expect(err).toBeInstanceOf(HerdrError)
  expect(err.code).toBe('timeout')
})
