import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import { processStartedAtMs, readPid, writePid } from '../src/lib/pidfile'
import { claimSupervisor } from '../src/supervisor/main'
import type { SupervisorPid } from '../src/lib/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'boot-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ROOT = join(import.meta.dir, '..')

const self = (over: Partial<SupervisorPid> = {}): SupervisorPid => ({
  pid: 4242, pane_pid: 222, started_at_ms: 1, session: 'personal',
  socket_path: '/s', pane_id: 'w1:p3', ...over,
})

async function liveHolder(): Promise<SupervisorPid> {
  const info = self({ pid: process.pid, started_at_ms: (await processStartedAtMs(process.pid)) ?? 0 })
  await writePid(dir, info)
  return info
}

const twoSupervisorPanes = {
  'pane list --workspace w1': { result: { panes: [
    { pane_id: 'w1:p2', label: 'Pipeline supervisor' },
    { pane_id: 'w1:p3', label: 'Pipeline supervisor' },
  ] } },
  'pane process-info --pane w1:p2': { result: { process_info: { shell_pid: 111 } } },
  'pane process-info --pane w1:p3': { result: { process_info: { shell_pid: 222 } } },
  'pane read w1:p2': 'TypeError: boom\n    at tick (main.ts:1)\n[pipeline] supervisor exited — run hpipe status\n',
  'pane close': { result: {} },
}

test('a supervisor that claims the session closes the dead one beside it and keeps its output — #97', async () => {
  await Bun.write(join(dir, 'workspace.personal.id'), 'w1')
  const bin = await makeFakeBin(dir, twoSupervisorPanes)
  const logged: string[] = []

  expect(await claimSupervisor(dir, new Herdr(bin), self(), (m) => { logged.push(m) })).toBe(true)

  expect((await readPid(dir, 'personal'))?.pid).toBe(4242)
  const calls = await Bun.file(join(dir, 'calls.log')).text()
  expect(calls).toContain('pane read w1:p2 --source recent --lines 200 --format text')
  expect(calls).toContain('pane close w1:p2')
  expect(calls).not.toContain('pane close w1:p3')
  const crashLog = await Bun.file(join(dir, 'supervisor.personal.crash.log')).text()
  expect(crashLog).toContain('TypeError: boom\n    at tick (main.ts:1)\n')
  expect(crashLog).toContain('[pipeline] supervisor exited — run hpipe status')
  expect(logged.join('\n')).toContain('closed dead supervisor panes: w1:p2')
  expect(logged.join('\n')).toContain('supervisor.personal.crash.log')
})

test('a supervisor that finds another live one neither claims nor closes anything — #97', async () => {
  await Bun.write(join(dir, 'workspace.personal.id'), 'w1')
  const holder = await liveHolder()
  const bin = await makeFakeBin(dir, twoSupervisorPanes)

  expect(await claimSupervisor(dir, new Herdr(bin), self(), () => {})).toBe(false)

  expect((await readPid(dir, 'personal'))?.pid).toBe(holder.pid)
  expect(existsSync(join(dir, 'calls.log'))).toBe(false)
})

test('of two supervisors claiming at once, exactly one wins — #97', async () => {
  const bin = await makeFakeBin(dir, {})
  const results = await Promise.all([
    claimSupervisor(dir, new Herdr(bin), self({ pid: 1, pane_id: '' }), () => {}),
    claimSupervisor(dir, new Herdr(bin), self({ pid: 2, pane_id: '' }), () => {}),
  ])
  expect(results.filter(Boolean)).toHaveLength(1)
})

/**
 * `bun test` runs in UTC while a spawned script parses `ps -o lstart=` in the
 * local zone, so the start time is read the way the spawned action will read it.
 */
async function startedAtAsAChildSeesIt(pid: number): Promise<number> {
  const probe = Bun.spawn([
    'bun', '-e',
    `import { processStartedAtMs } from ${JSON.stringify(join(ROOT, 'src/lib/pidfile'))}\n` +
    `console.log(await processStartedAtMs(${pid}))`,
  ], { stdout: 'pipe', env: { ...process.env, TZ: undefined } })
  return Number((await new Response(probe.stdout).text()).trim())
}

test('the reopen action opens nothing while a supervisor is live — #97', async () => {
  await writePid(dir, self({ pid: process.pid, started_at_ms: await startedAtAsAChildSeesIt(process.pid) }))
  const bin = await makeFakeBin(dir, { 'plugin pane open': { result: {} } })
  const proc = Bun.spawn(['bun', 'run', join(ROOT, 'src/actions/supervisor.ts')], {
    env: {
      ...process.env,
      HERDR_PLUGIN_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: dir,
      HERDR_SESSION: 'personal', HERDR_BIN_PATH: bin,
    },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ])
  expect(await proc.exited, err).toBe(0)
  expect(out).toContain('already running')
  expect(existsSync(join(dir, 'calls.log'))).toBe(false)
})
