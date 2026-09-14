# herdr-plugin-pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a herdr plugin that drives the superpowers pipeline across worktrees — event hooks that only enqueue, a per-session supervisor pane that owns all timing and evaluation, and just-in-time prompt templates so the orchestrator agent never has to hold the pipeline in context.

**Architecture:** Five one-shot event hooks write one JSON file each into a queue directory and exit in under 50 ms (herdr caps plugin commands at 32 concurrent and *drops* the overflow, so a hook must never block). One long-lived supervisor process per herdr session — running in a plugin-owned pane — ticks once a second: drains the queue, evaluates edge-triggered phase predicates gated on the actor agent being idle, renders exactly one phase prompt per orchestrator per tick, polls CI, and runs teardown. All state is JSON on disk under `$HERDR_PLUGIN_STATE_DIR`, scoped by session key.

**Tech Stack:** Bun + TypeScript (no build step — Bun runs `.ts` directly from the manifest), `bun:test`, the herdr 0.9.0 CLI via `$HERDR_BIN_PATH`, and `gh` 2.96.0 via `$GH_BIN`.

**Spec:** `docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md` (v4, cleared at the third adversarial pass). Read it before Task 1.

---

## File structure

| File | Responsibility |
| --- | --- |
| `herdr-plugin.toml` | Manifest: 5 event hooks, 1 startup hook, 4 actions, 1 pane |
| `src/lib/types.ts` | Every shared type. Nothing else declares a domain type |
| `src/lib/session.ts` | `sessionKey()` — the one place `HERDR_SESSION` is read |
| `src/lib/store.ts` | Atomic JSON read/write (`.tmp` + rename) |
| `src/lib/config.ts` | `config.env` parsing and defaults |
| `src/lib/queue.ts` | `enqueue()` (hooks) and `drain()` (supervisor) |
| `src/lib/herdr.ts` | Typed `$HERDR_BIN_PATH` wrapper |
| `src/lib/gh.ts` | Typed `$GH_BIN` wrapper; bucket mapping and exit-8 handling |
| `src/lib/ledger.ts` | Run and orchestrator records, session-scoped |
| `src/lib/badges.ts` | Workspace token writes, clamped to herdr's limits |
| `src/lib/predicates.ts` | Artifact freshness/settle, verdict parsing, GitHub-state edges |
| `src/lib/machine.ts` | Phase table, run and task transitions |
| `src/lib/render.ts` | Prompt template rendering |
| `src/hooks/_hook.ts` | Shared hook body: parse event → enqueue → exit |
| `src/hooks/*.ts` | Five thin entrypoints, one per herdr event |
| `src/supervisor/main.ts` | Singleton guard, pid file, tick loop |
| `src/supervisor/tick.ts` | One tick: drain → evaluate → deliver |
| `src/supervisor/ci.ts` | CI polling |
| `src/supervisor/teardown.ts` | Worktree removal, gated on issue closure |
| `src/actions/*.ts` | `status`, `claim`, `drain`, `supervisor` |
| `src/startup.ts` | Workspace/ghost reconcile, badge reapply, `hpipe` symlink, `.tmp` GC |
| `src/cli.ts` | `hpipe` — everything that takes arguments |
| `prompts/*.md` | All instruction text |
| `test/helpers/fake-bin.ts` | Scripted fake `herdr`/`gh` for hermetic tests |

**Milestones.** M1 (Tasks 1–11) is the transport: hooks, queue, ledger, badges. It is independently useful — events land and the ledger is correct — and nothing after it reshapes it. M2 (Tasks 12–21) is the runner. M3 (Tasks 22–27) is CI, teardown, actions, and the one live test. Commit after every task; open a PR per milestone.

---

## Task 1: Repo scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `src/lib/types.ts`, `test/smoke.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "herdr-plugin-pipeline",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["bun-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Create `.gitignore`**

```
node_modules/
*.log
.DS_Store
```

- [ ] **Step 4: Create `src/lib/types.ts`**

Every domain type lives here and nowhere else. Later tasks import from this file rather than redeclaring.

```ts
export type SessionKey = string

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown'

export type RunPhase =
  | 'spec' | 'spec-review' | 'plan' | 'plan-review'
  | 'dispatch' | 'execute' | 'branch-review'
  | 'escalated' | 'done'

export type TaskPhase =
  | 'queued' | 'execute' | 'task-review-spec' | 'task-review-quality'
  | 'ci' | 'merge' | 'close' | 'teardown'
  | 'done' | 'failed' | 'orphaned' | 'blocked-on-failure' | 'escalated'

export type Verdict = 'CLEAR' | 'BLOCKER'

export type CiBucket = 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel' | 'unknown'

export type EventKind =
  | 'worktree.created' | 'worktree.removed'
  | 'pane.agent_detected' | 'pane.agent_status_changed' | 'pane.exited'

export interface QueuedEvent {
  kind: EventKind
  session: SessionKey
  at: number
  workspace_id?: string
  pane_id?: string
  agent_status?: AgentStatus
  released?: boolean
  branch?: string
  checkout_path?: string
  repo_key?: string
  repo_root?: string
  is_linked_worktree?: boolean
}

export interface Task {
  task_id: string
  branch: string
  issue: number
  surface: string
  depends_on: string[]
  files: string[]
  keep_worktree: boolean
  text: string
  workspace_id: string | null
  pane_id: string | null
  agent_status: AgentStatus
  phase: TaskPhase
  pass: number
  phase_entered_at: number
  escalated_from: TaskPhase | null
  head_sha_at_entry: string | null
  pr: number | null
  ci: CiBucket | null
}

export interface RunArtifacts {
  spec: string | null
  plan: string | null
  verdicts: Record<string, string>
}

export interface Run {
  run_id: string
  session: SessionKey
  socket_path: string
  repo_key: string
  repo_root: string
  title: string
  phase: RunPhase
  pass: number
  phase_entered_at: number
  escalated_from: RunPhase | null
  orchestrator_pane: string | null
  artifacts: RunArtifacts
  tasks: Task[]
  history: HistoryEntry[]
}

export interface HistoryEntry {
  at: number
  task_id?: string
  from: string
  to: string
  why: string
}

export interface Orchestrator {
  pane_id: string
  workspace_id: string
  socket_path: string
  claimed_at: number
}

export interface SupervisorPid {
  pid: number
  pane_pid: number
  started_at_ms: number
  session: SessionKey
  socket_path: string
  pane_id: string
}
```

- [ ] **Step 5: Write the smoke test**

```ts
// test/smoke.test.ts
import { expect, test } from 'bun:test'
import type { Run } from '../src/lib/types'

test('types module loads and Run is structurally usable', () => {
  const run: Pick<Run, 'run_id' | 'phase'> = { run_id: 'r1', phase: 'spec' }
  expect(run.phase).toBe('spec')
})
```

- [ ] **Step 6: Run the test**

Run: `bun test test/smoke.test.ts`
Expected: PASS, 1 test.

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore src/lib/types.ts test/smoke.test.ts
git commit -m "chore: scaffold bun+ts plugin package with shared types"
```

---

## Task 2: `sessionKey()`

`HERDR_SESSION` is injected for **named sessions only** — it is unset in the default session and is not in `plugins.mdx`'s documented variable list. `HERDR_SOCKET_PATH` is present everywhere and encodes the session, so it is the fallback.

**Files:**
- Create: `src/lib/session.ts`, `test/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/session.test.ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/session.test.ts`
Expected: FAIL — cannot resolve `../src/lib/session`.

- [ ] **Step 3: Implement**

```ts
// src/lib/session.ts
import type { SessionKey } from './types'

const SESSION_PATH = /\/sessions\/([^/]+)\/herdr\.sock$/

export function sessionKey(env: Record<string, string | undefined> = process.env): SessionKey {
  const named = env.HERDR_SESSION
  if (named && named.length > 0) return named

  const socket = env.HERDR_SOCKET_PATH
  if (socket) {
    const matched = SESSION_PATH.exec(socket)
    if (matched?.[1]) return matched[1]
  }

  return 'default'
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/session.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/session.ts test/session.test.ts
git commit -m "feat: derive session key from HERDR_SESSION or socket path"
```

---

## Task 3: Atomic JSON store

Every state write in this plugin goes through here. Concurrent hook processes are real, so a partial write must never be observable.

**Files:**
- Create: `src/lib/store.ts`, `test/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/store.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJson, writeJson } from '../src/lib/store'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'store-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('round-trips a value', async () => {
  const p = join(dir, 'a.json')
  await writeJson(p, { hello: 'world' })
  expect(await readJson<{ hello: string }>(p)).toEqual({ hello: 'world' })
})

test('returns null for a missing file', async () => {
  expect(await readJson(join(dir, 'nope.json'))).toBeNull()
})

test('returns null for unparseable content rather than throwing', async () => {
  const p = join(dir, 'bad.json')
  await Bun.write(p, '{not json')
  expect(await readJson(p)).toBeNull()
})

test('creates parent directories', async () => {
  const p = join(dir, 'nested', 'deep', 'a.json')
  await writeJson(p, { n: 1 })
  expect(await readJson<{ n: number }>(p)).toEqual({ n: 1 })
})

test('leaves no .tmp file behind', async () => {
  const p = join(dir, 'a.json')
  await writeJson(p, { n: 1 })
  expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/store.test.ts`
Expected: FAIL — cannot resolve `../src/lib/store`.

- [ ] **Step 3: Implement**

```ts
// src/lib/store.ts
import { mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

export async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  try {
    return (await file.json()) as T
  } catch {
    return null
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  // Unique per CALL, not per process: two concurrent writeJson calls in one
  // process would otherwise share a tmp path and race on rename.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await Bun.write(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/store.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/store.ts test/store.test.ts
git commit -m "feat: atomic JSON store with tmp+rename writes"
```

---

## Task 4: Configuration

**Files:**
- Create: `src/lib/config.ts`, `test/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/config.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/lib/config'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cfg-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('returns defaults when no config file exists', async () => {
  const cfg = await loadConfig(dir)
  expect(cfg.TICK_MS).toBe(1000)
  expect(cfg.MAX_PASSES).toBe(2)
  expect(cfg.WAKE_ON).toEqual(['blocked', 'done', 'idle', 'unknown', 'exited', 'released'])
  expect(cfg.REPOS_ALLOW).toEqual([])
})

test('overrides numbers and lists from config.env', async () => {
  await Bun.write(join(dir, 'config.env'), [
    '# a comment',
    'TICK_MS=250',
    'WAKE_ON=blocked,done',
    'REPOS_ALLOW=repo-a,repo-b',
    '',
  ].join('\n'))
  const cfg = await loadConfig(dir)
  expect(cfg.TICK_MS).toBe(250)
  expect(cfg.WAKE_ON).toEqual(['blocked', 'done'])
  expect(cfg.REPOS_ALLOW).toEqual(['repo-a', 'repo-b'])
})

test('ignores a non-numeric override and keeps the default', async () => {
  await Bun.write(join(dir, 'config.env'), 'TICK_MS=banana\n')
  expect((await loadConfig(dir)).TICK_MS).toBe(1000)
})

test('parses HPIPE_LINK as a boolean', async () => {
  await Bun.write(join(dir, 'config.env'), 'HPIPE_LINK=0\n')
  expect((await loadConfig(dir)).HPIPE_LINK).toBe(false)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/config.test.ts`
Expected: FAIL — cannot resolve `../src/lib/config`.

- [ ] **Step 3: Implement**

```ts
// src/lib/config.ts
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface Config {
  TICK_MS: number
  WAKE_ON: string[]
  MAX_PASSES: number
  STALL_MINUTES: number
  TASK_STALL_MINUTES: number
  FILE_SETTLE_MS: number
  ACTOR_SETTLE_MS: number
  CI_POLL_SECONDS: number
  PROMPT_RETRY_MAX: number
  BLOCKED_TAIL_LINES: number
  REPOS_ALLOW: string[]
  PIPELINE_WORKSPACE_LABEL: string
  GH_BIN: string
  HPIPE_LINK: boolean
  HPIPE_LINK_PATH: string
}

const DEFAULTS: Config = {
  TICK_MS: 1000,
  WAKE_ON: ['blocked', 'done', 'idle', 'unknown', 'exited', 'released'],
  MAX_PASSES: 2,
  STALL_MINUTES: 15,
  TASK_STALL_MINUTES: 45,
  FILE_SETTLE_MS: 750,
  ACTOR_SETTLE_MS: 750,
  CI_POLL_SECONDS: 30,
  PROMPT_RETRY_MAX: 5,
  BLOCKED_TAIL_LINES: 8,
  REPOS_ALLOW: [],
  PIPELINE_WORKSPACE_LABEL: 'pipeline',
  GH_BIN: 'gh',
  HPIPE_LINK: true,
  HPIPE_LINK_PATH: join(homedir(), '.local', 'bin', 'hpipe'),
}

const NUMERIC = [
  'TICK_MS', 'MAX_PASSES', 'STALL_MINUTES', 'TASK_STALL_MINUTES',
  'FILE_SETTLE_MS', 'ACTOR_SETTLE_MS', 'CI_POLL_SECONDS',
  'PROMPT_RETRY_MAX', 'BLOCKED_TAIL_LINES',
] as const

const LISTS = ['WAKE_ON', 'REPOS_ALLOW'] as const

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return out
}

export async function loadConfig(configDir: string): Promise<Config> {
  const file = Bun.file(join(configDir, 'config.env'))
  if (!(await file.exists())) return { ...DEFAULTS }

  const raw = parseEnvFile(await file.text())
  const cfg: Config = { ...DEFAULTS }

  for (const key of NUMERIC) {
    const value = raw[key]
    if (value === undefined) continue
    const parsed = Number(value)
    if (Number.isFinite(parsed)) cfg[key] = parsed
  }

  for (const key of LISTS) {
    const value = raw[key]
    if (value === undefined) continue
    cfg[key] = value.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
  }

  if (raw.PIPELINE_WORKSPACE_LABEL) cfg.PIPELINE_WORKSPACE_LABEL = raw.PIPELINE_WORKSPACE_LABEL
  if (raw.GH_BIN) cfg.GH_BIN = raw.GH_BIN
  if (raw.HPIPE_LINK_PATH) cfg.HPIPE_LINK_PATH = raw.HPIPE_LINK_PATH
  if (raw.HPIPE_LINK !== undefined) {
    const falsy = ['0', 'false']
    cfg.HPIPE_LINK = !falsy.includes(raw.HPIPE_LINK.toLowerCase())
  }

  return cfg
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/config.ts test/config.test.ts
git commit -m "feat: config.env loading with typed defaults"
```

---

## Task 5: Queue — enqueue and drain

The filename must sort lexicographically into emission order. Measured during review: eight events emitted in a known order all landed in the same millisecond, `readdir` matched neither emission nor sorted order, and an unpadded pid sorts `9` after `88888`. Hence zero-padded `ts`, a per-process monotonic `seq`, and a zero-padded `pid`.

**Files:**
- Create: `src/lib/queue.ts`, `test/queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/queue.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drain, enqueue, gcStaleTmp, queueName } from '../src/lib/queue'
import type { QueuedEvent } from '../src/lib/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'queue-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const ev = (n: number): QueuedEvent => ({
  kind: 'pane.agent_status_changed', session: 'default', at: n, pane_id: `p${n}`,
})

test('names sort lexicographically into emission order within a process', () => {
  const names = [queueName(1, 0, 9), queueName(1, 1, 88888), queueName(1, 2, 9)]
  expect([...names].sort()).toEqual(names)
})

test('drain returns events in emission order', async () => {
  for (let i = 0; i < 8; i++) await enqueue(dir, ev(i))
  const drained = await drain(dir)
  expect(drained.map((e) => e.at)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
})

test('drain removes the files it processed', async () => {
  await enqueue(dir, ev(1))
  await drain(dir)
  expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toHaveLength(0)
})

test('drain ignores a partially written .tmp file', async () => {
  await enqueue(dir, ev(1))
  await Bun.write(join(dir, '0000000001-000000-000001.json.tmp'), '{"half')
  const drained = await drain(dir)
  expect(drained).toHaveLength(1)
})

test('drain skips an unparseable event without losing the rest', async () => {
  await enqueue(dir, ev(1))
  await Bun.write(join(dir, '9999999999-000000-000001.json'), 'not json')
  await enqueue(dir, ev(2))
  expect((await drain(dir)).map((e) => e.at)).toEqual([1, 2])
})

test('gcStaleTmp removes only .tmp files older than the cutoff', async () => {
  const fresh = join(dir, 'a.json.tmp')
  await Bun.write(fresh, 'x')
  await Bun.write(join(dir, 'keep.json'), '{}')
  expect(await gcStaleTmp(dir, 0)).toBe(1)
  expect(readdirSync(dir)).toEqual(['keep.json'])
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/queue.test.ts`
Expected: FAIL — cannot resolve `../src/lib/queue`.

- [ ] **Step 3: Implement**

```ts
// src/lib/queue.ts
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { QueuedEvent } from './types'

let seq = 0

const pad = (n: number, width: number) => String(n).padStart(width, '0')

export function queueName(atMs: number, sequence: number, pid: number): string {
  // The trailing random segment is a pure uniqueness tie-breaker and must stay
  // LAST so it never perturbs sort order. Hooks are one-shot processes, so
  // `sequence` is 0 on nearly every real call and `pid` alone would carry
  // uniqueness — and pid reuse within one millisecond would then silently
  // overwrite an already-queued event.
  const unique = randomUUID().slice(0, 8)
  return `${pad(atMs, 13)}-${pad(sequence, 6)}-${pad(pid, 6)}-${unique}.json`
}

export async function enqueue(queueDir: string, event: QueuedEvent): Promise<string> {
  mkdirSync(queueDir, { recursive: true })
  const name = queueName(event.at, seq++, process.pid)
  const target = join(queueDir, name)
  const tmp = `${target}.tmp`
  await Bun.write(tmp, JSON.stringify(event))
  renameSync(tmp, target)
  return target
}

export async function drain(queueDir: string): Promise<QueuedEvent[]> {
  let names: string[]
  try {
    names = readdirSync(queueDir)
  } catch {
    return []
  }

  const ready = names.filter((n) => n.endsWith('.json')).sort()
  const events: QueuedEvent[] = []

  for (const name of ready) {
    const path = join(queueDir, name)
    try {
      events.push((await Bun.file(path).json()) as QueuedEvent)
    } catch {
      // An unreadable event must not wedge the queue.
    }
    unlinkSync(path)
  }

  return events
}

export async function gcStaleTmp(queueDir: string, maxAgeMs: number): Promise<number> {
  let names: string[]
  try {
    names = readdirSync(queueDir)
  } catch {
    return 0
  }

  const cutoff = Date.now() - maxAgeMs
  let removed = 0
  for (const name of names) {
    if (!name.endsWith('.tmp')) continue
    const path = join(queueDir, name)
    if (statSync(path).mtimeMs <= cutoff) {
      unlinkSync(path)
      removed++
    }
  }
  return removed
}
```

> **Drain ordering note for the implementer.** `drain()` returns events; the caller writes the ledger
> *before* it would be safe to consider them consumed. Files are unlinked here, which makes drain
> at-most-once on a crash between drain and ledger write. Task 19 restores at-least-once by writing
> the ledger inside the same tick before any delivery, and dedup makes a replay harmless. Do not
> "optimise" the unlink into the caller.

- [ ] **Step 4: Run the tests**

Run: `bun test test/queue.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/queue.ts test/queue.test.ts
git commit -m "feat: one-file-per-event queue with sortable names"
```

---

## Task 6: herdr CLI wrapper and the fake-bin test helper

The plugin calls herdr by absolute path from `$HERDR_BIN_PATH`, which a `PATH`-order fake cannot intercept. Tests therefore point `HERDR_BIN_PATH` at a generated script.

**Files:**
- Create: `src/lib/herdr.ts`, `test/helpers/fake-bin.ts`, `test/herdr.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/herdr.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'herdr-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('parses a result envelope', async () => {
  const bin = await makeFakeBin(dir, { 'pane list': { result: { panes: [{ pane_id: 'w1:p1' }] } } })
  const panes = await new Herdr(bin).paneList('w1')
  expect(panes[0]?.pane_id).toBe('w1:p1')
})

test('surfaces an error envelope as ok:false with the code', async () => {
  const bin = await makeFakeBin(dir, {
    'agent prompt': { error: { code: 'agent_blocked', message: 'blocked' } },
  })
  const res = await new Herdr(bin).agentPrompt('w1:p1', 'hello')
  expect(res.ok).toBe(false)
  expect(res.code).toBe('agent_blocked')
})

test('treats a zero exit with an error body as failure', async () => {
  const bin = await makeFakeBin(dir, {
    'plugin pane open': { error: { code: 'no_active_workspace', message: 'none' } },
  })
  const res = await new Herdr(bin).pluginPaneOpen('stein.pipeline', 'supervisor', 'w1')
  expect(res.ok).toBe(false)
  expect(res.code).toBe('no_active_workspace')
})

test('records the argv it was called with', async () => {
  const bin = await makeFakeBin(dir, { 'agent get': { result: { agent: { agent_status: 'idle' } } } })
  await new Herdr(bin).agentStatus('w1:p1')
  const log = await Bun.file(join(dir, 'calls.log')).text()
  expect(log).toContain('agent get w1:p1')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/herdr.test.ts`
Expected: FAIL — cannot resolve `./helpers/fake-bin`.

- [ ] **Step 3: Write the fake-bin helper**

```ts
// test/helpers/fake-bin.ts
import { chmodSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Writes an executable that echoes a canned JSON response per argv prefix and
 * appends every invocation to `calls.log`. Responses are matched on the longest
 * prefix, so 'pane list' wins over 'pane'.
 */
export async function makeFakeBin(
  dir: string,
  responses: Record<string, unknown>,
  exitCodes: Record<string, number> = {},
): Promise<string> {
  const path = join(dir, 'fake-bin')
  const table = JSON.stringify(responses)
  const codes = JSON.stringify(exitCodes)

  await Bun.write(path, `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, argv.join(' ') + '\\n')
const table = ${table}
const codes = ${codes}
const joined = argv.join(' ')
// Require a token boundary after the match: without it, a stub for
// 'agent get w1:p1' silently answers 'agent get w1:p10' with the wrong payload.
const key = Object.keys(table)
  .filter((k) => joined === k || joined.startsWith(k + ' '))
  .sort((a, b) => b.length - a.length)[0]
if (key === undefined) {
  process.stdout.write(JSON.stringify({ error: { code: 'unstubbed', message: joined } }))
  process.exit(1)
}
process.stdout.write(JSON.stringify(table[key]))
process.exit(codes[key] ?? 0)
`)
  chmodSync(path, 0o755)
  return path
}
```

- [ ] **Step 4: Implement the wrapper**

```ts
// src/lib/herdr.ts
import type { AgentStatus } from './types'

export interface CallResult<T> {
  ok: boolean
  code?: string
  message?: string
  result?: T
}

export interface PaneInfo {
  pane_id: string
  workspace_id?: string
  agent_status?: AgentStatus
  label?: string
}

export interface WorkspaceInfo {
  workspace_id: string
  label: string
  worktree?: { repo_key: string; repo_root: string; is_linked_worktree: boolean } | null
}

interface Envelope<T> {
  result?: T
  error?: { code: string; message: string }
}

export class Herdr {
  constructor(private readonly bin: string = process.env.HERDR_BIN_PATH ?? 'herdr') {}

  private async call<T>(args: string[]): Promise<CallResult<T>> {
    // Bun.spawn throws synchronously on a missing binary. Callers rely on these
    // methods never throwing, so a bad HERDR_BIN_PATH must degrade to a failed
    // CallResult rather than crash the supervisor loop.
    let text: string
    try {
      const proc = Bun.spawn([this.bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
      text = await new Response(proc.stdout).text()
      await proc.exited
    } catch (error) {
      return { ok: false, code: 'spawn_failed', message: String(error) }
    }

    let parsed: Envelope<T>
    try {
      parsed = JSON.parse(text) as Envelope<T>
    } catch {
      return { ok: false, code: 'unparseable', message: text.slice(0, 200) }
    }

    // herdr reports some failures in the body while exiting 0.
    if (parsed.error) return { ok: false, code: parsed.error.code, message: parsed.error.message }
    return { ok: true, result: parsed.result }
  }

  async paneList(workspaceId?: string): Promise<PaneInfo[]> {
    const args = ['pane', 'list']
    if (workspaceId) args.push('--workspace', workspaceId)
    const res = await this.call<{ panes: PaneInfo[] }>(args)
    return res.result?.panes ?? []
  }

  async workspaceList(): Promise<WorkspaceInfo[]> {
    const res = await this.call<{ workspaces: WorkspaceInfo[] }>(['workspace', 'list'])
    return res.result?.workspaces ?? []
  }

  async agentStatus(target: string): Promise<AgentStatus> {
    const res = await this.call<{ agent: { agent_status: AgentStatus } }>(['agent', 'get', target])
    return res.result?.agent.agent_status ?? 'unknown'
  }

  async agentPrompt(target: string, text: string): Promise<CallResult<unknown>> {
    return this.call(['agent', 'prompt', target, text])
  }

  async paneRead(target: string, lines: number): Promise<string> {
    const res = await this.call<{ text: string }>(
      ['pane', 'read', target, '--source', 'visible', '--lines', String(lines)],
    )
    return res.result?.text ?? ''
  }

  /**
   * `undefined` means the call FAILED and the pid is unknown; `null` means herdr
   * answered but reported no shell pid. Callers that act destructively on the
   * result must treat unknown as "do not touch" — conflating the two once made
   * the ghost reaper close the live supervisor pane it was protecting.
   */
  async paneShellPid(paneId: string): Promise<number | null | undefined> {
    const res = await this.call<{ process_info: { shell_pid: number } }>(
      ['pane', 'process-info', '--pane', paneId],
    )
    if (!res.ok) return undefined
    return res.result?.process_info.shell_pid ?? null
  }

  async paneClose(paneId: string): Promise<CallResult<unknown>> {
    return this.call(['pane', 'close', paneId])
  }

  async workspaceCreate(label: string): Promise<CallResult<{ workspace: WorkspaceInfo }>> {
    return this.call(['workspace', 'create', '--label', label, '--no-focus'])
  }

  async workspaceReportTokens(
    workspaceId: string, source: string, tokens: Record<string, string>,
  ): Promise<CallResult<unknown>> {
    return this.call([
      'workspace', 'report-metadata', '--workspace', workspaceId,
      '--source', source, '--tokens', JSON.stringify(tokens),
    ])
  }

  async worktreeRemove(workspaceId: string): Promise<CallResult<unknown>> {
    return this.call(['worktree', 'remove', '--workspace', workspaceId, '--force'])
  }

  async pluginPaneOpen(
    pluginId: string, entrypoint: string, workspaceId: string,
  ): Promise<CallResult<unknown>> {
    return this.call([
      'plugin', 'pane', 'open', '--plugin', pluginId, '--entrypoint', entrypoint,
      '--workspace', workspaceId, '--placement', 'tab', '--no-focus',
    ])
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/herdr.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/herdr.ts test/helpers/fake-bin.ts test/herdr.test.ts
git commit -m "feat: typed herdr CLI wrapper with error-body handling"
```

---

## Task 7: Ledger — session-scoped runs and orchestrators

**Files:**
- Create: `src/lib/ledger.ts`, `test/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/ledger.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activeRunForRepo, listRuns, newRun, readOrchestrator,
  saveRun, writeOrchestrator,
} from '../src/lib/ledger'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ledger-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('newRun produces a unique suffixed id and spec phase', () => {
  const a = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })
  const b = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })
  expect(a.phase).toBe('spec')
  expect(a.run_id).not.toBe(b.run_id)
  expect(a.run_id).toContain('chat-meter')
})

test('listRuns only returns runs for the requested session', async () => {
  const mine = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  const theirs = newRun({ session: 'default', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'b' })
  await saveRun(dir, mine)
  await saveRun(dir, theirs)

  const runs = await listRuns(dir, 'personal')
  expect(runs).toHaveLength(1)
  expect(runs[0]?.title).toBe('a')
})

test('activeRunForRepo ignores a finished run', async () => {
  const done = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  done.phase = 'done'
  await saveRun(dir, done)
  expect(await activeRunForRepo(dir, 'personal', 'k')).toBeNull()
})

test('activeRunForRepo finds a live run', async () => {
  const live = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  await saveRun(dir, live)
  expect((await activeRunForRepo(dir, 'personal', 'k'))?.run_id).toBe(live.run_id)
})

test('orchestrators are keyed by session and repo', async () => {
  await writeOrchestrator(dir, 'personal', 'k', {
    pane_id: 'w1:p1', workspace_id: 'w1', socket_path: '/s', claimed_at: 1,
  })
  expect((await readOrchestrator(dir, 'personal', 'k'))?.pane_id).toBe('w1:p1')
  expect(await readOrchestrator(dir, 'default', 'k')).toBeNull()
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/ledger.test.ts`
Expected: FAIL — cannot resolve `../src/lib/ledger`.

- [ ] **Step 3: Implement**

```ts
// src/lib/ledger.ts
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './store'
import type { Orchestrator, Run, SessionKey } from './types'

const FINISHED: ReadonlySet<string> = new Set(['done'])

const runsDir = (stateDir: string, session: SessionKey) => join(stateDir, 'runs', session)

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
}

export function newRun(input: {
  session: SessionKey
  socketPath: string
  repoKey: string
  repoRoot: string
  title: string
}): Run {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const suffix = Math.random().toString(36).slice(2, 6)
  const repoName = input.repoRoot.split('/').filter(Boolean).pop() ?? 'repo'

  return {
    run_id: `${repoName}-${date}-${slugify(input.title)}-${suffix}`,
    session: input.session,
    socket_path: input.socketPath,
    repo_key: input.repoKey,
    repo_root: input.repoRoot,
    title: input.title,
    phase: 'spec',
    pass: 1,
    phase_entered_at: Date.now(),
    escalated_from: null,
    orchestrator_pane: null,
    artifacts: { spec: null, plan: null, verdicts: {} },
    tasks: [],
    history: [],
  }
}

export async function saveRun(stateDir: string, run: Run): Promise<void> {
  await writeJson(join(runsDir(stateDir, run.session), `${run.run_id}.json`), run)
}

export async function listRuns(stateDir: string, session: SessionKey): Promise<Run[]> {
  let names: string[]
  try {
    names = readdirSync(runsDir(stateDir, session))
  } catch {
    return []
  }

  const runs: Run[] = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const run = await readJson<Run>(join(runsDir(stateDir, session), name))
    if (run) runs.push(run)
  }
  return runs
}

export async function activeRunForRepo(
  stateDir: string, session: SessionKey, repoKey: string,
): Promise<Run | null> {
  const runs = await listRuns(stateDir, session)
  return runs.find((r) => r.repo_key === repoKey && !FINISHED.has(r.phase)) ?? null
}

export async function runForWorkspace(
  stateDir: string, session: SessionKey, workspaceId: string,
): Promise<Run | null> {
  const runs = await listRuns(stateDir, session)
  return runs.find((r) => r.tasks.some((t) => t.workspace_id === workspaceId)) ?? null
}

// One file per record, mirroring the runs layout above. A single shared
// orchestrators.json would be read-modify-written whole, so two concurrent
// claims in different sessions could silently clobber each other's entry.
const orchestratorPath = (stateDir: string, session: SessionKey, repoKey: string) =>
  join(stateDir, 'orchestrators', session, `${encodeURIComponent(repoKey)}.json`)

export async function writeOrchestrator(
  stateDir: string, session: SessionKey, repoKey: string, value: Orchestrator,
): Promise<void> {
  await writeJson(orchestratorPath(stateDir, session, repoKey), value)
}

export async function readOrchestrator(
  stateDir: string, session: SessionKey, repoKey: string,
): Promise<Orchestrator | null> {
  return readJson<Orchestrator>(orchestratorPath(stateDir, session, repoKey))
}

export async function allOrchestratorPanes(
  stateDir: string, session: SessionKey,
): Promise<Set<string>> {
  const dir = join(stateDir, 'orchestrators', session)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return new Set()
  }

  const panes = new Set<string>()
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const entry = await readJson<Orchestrator>(join(dir, name))
    if (entry) panes.add(entry.pane_id)
  }
  return panes
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/ledger.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ledger.ts test/ledger.test.ts
git commit -m "feat: session-scoped run and orchestrator ledger"
```

---

## Task 8: Event hooks

Five entrypoints over one shared body. The body must do nothing but parse, enqueue, and exit.

**Files:**
- Create: `src/hooks/_hook.ts`, `src/hooks/worktree-created.ts`, `src/hooks/agent-detected.ts`, `src/hooks/agent-status.ts`, `src/hooks/pane-exited.ts`, `src/hooks/worktree-removed.ts`, `test/hook.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/hook.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drain } from '../src/lib/queue'
import { toQueuedEvent } from '../src/hooks/_hook'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hook-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('maps a worktree.created payload', () => {
  const event = toQueuedEvent('worktree.created', 'personal', JSON.stringify({
    type: 'worktree_created',
    workspace: { workspace_id: 'w7', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: true } },
    worktree: { branch: 'feat/x', path: '/r/.worktrees/x' },
  }))
  expect(event).toMatchObject({
    kind: 'worktree.created', workspace_id: 'w7', branch: 'feat/x',
    repo_key: 'k', repo_root: '/r', is_linked_worktree: true,
  })
})

test('maps an agent_status_changed payload', () => {
  const event = toQueuedEvent('pane.agent_status_changed', 'personal', JSON.stringify({
    pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'blocked',
  }))
  expect(event).toMatchObject({ kind: 'pane.agent_status_changed', pane_id: 'w7:p1', agent_status: 'blocked' })
})

test('marks a release on agent_detected', () => {
  const event = toQueuedEvent('pane.agent_detected', 'personal', JSON.stringify({
    pane_id: 'w7:p1', workspace_id: 'w7', released: true,
  }))
  expect(event?.released).toBe(true)
})

test('returns null for unparseable JSON', () => {
  expect(toQueuedEvent('pane.exited', 'personal', 'not json')).toBeNull()
})

test('returns null for JSON that parses to a non-object', () => {
  // JSON.parse("null") succeeds; reading a field off it would throw out of a hook.
  expect(toQueuedEvent('pane.exited', 'personal', 'null')).toBeNull()
  expect(toQueuedEvent('pane.exited', 'personal', '42')).toBeNull()
})

test('an unparseable payload enqueues nothing rather than a phantom entry', async () => {
  const { runHook } = await import('../src/hooks/_hook')
  await runHook('pane.exited', dir, 'personal', 'null')
  expect(await drain(dir)).toHaveLength(0)
})

test('the enqueued event survives a round trip through the queue', async () => {
  const { runHook } = await import('../src/hooks/_hook')
  await runHook('pane.exited', dir, 'personal', JSON.stringify({ pane_id: 'w7:p1', workspace_id: 'w7' }))
  const drained = await drain(dir)
  expect(drained[0]).toMatchObject({ kind: 'pane.exited', pane_id: 'w7:p1' })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/hook.test.ts`
Expected: FAIL — cannot resolve `../src/hooks/_hook`.

- [ ] **Step 3: Implement the shared body**

```ts
// src/hooks/_hook.ts
import { join } from 'node:path'
import { enqueue } from '../lib/queue'
import { sessionKey } from '../lib/session'
import type { AgentStatus, EventKind, QueuedEvent } from '../lib/types'

interface RawEvent {
  pane_id?: string
  workspace_id?: string
  agent_status?: AgentStatus
  released?: boolean
  workspace?: {
    workspace_id?: string
    worktree?: { repo_key?: string; repo_root?: string; is_linked_worktree?: boolean } | null
  }
  worktree?: { branch?: string | null; path?: string }
}

/** Returns null when the payload carries nothing actionable. */
export function toQueuedEvent(
  kind: EventKind, session: string, rawJson: string,
): QueuedEvent | null {
  let raw: RawEvent
  try {
    const parsed: unknown = JSON.parse(rawJson)
    // `JSON.parse("null")` succeeds and returns null, so guarding the parse
    // alone is not enough — reading a field off it would throw out of a hook.
    if (parsed === null || typeof parsed !== 'object') return null
    raw = parsed as RawEvent
  } catch {
    return null
  }

  const event: QueuedEvent = { kind, session, at: Date.now() }

  if (raw.pane_id) event.pane_id = raw.pane_id
  if (raw.agent_status) event.agent_status = raw.agent_status
  if (raw.released !== undefined) event.released = raw.released
  event.workspace_id = raw.workspace?.workspace_id ?? raw.workspace_id

  const provenance = raw.workspace?.worktree
  if (provenance) {
    if (provenance.repo_key) event.repo_key = provenance.repo_key
    if (provenance.repo_root) event.repo_root = provenance.repo_root
    if (provenance.is_linked_worktree !== undefined) {
      event.is_linked_worktree = provenance.is_linked_worktree
    }
  }

  if (raw.worktree?.branch) event.branch = raw.worktree.branch
  if (raw.worktree?.path) event.checkout_path = raw.worktree.path

  return event
}

export async function runHook(
  kind: EventKind, queueDir: string, session: string, rawJson: string,
): Promise<void> {
  const event = toQueuedEvent(kind, session, rawJson)
  if (!event) {
    // A queue entry with no fields is indistinguishable from a legitimately
    // sparse event, so the supervisor could not act on it either way. Report
    // and drop rather than enqueue something unactionable.
    console.error(`[pipeline] ${kind}: unparseable event payload, dropped`)
    return
  }
  await enqueue(queueDir, event)
}

/** Entrypoint shared by all five hook scripts. Parses env, enqueues, exits. */
export async function main(kind: EventKind): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  if (!stateDir) process.exit(0)
  await runHook(kind, join(stateDir, 'queue'), sessionKey(), process.env.HERDR_PLUGIN_EVENT_JSON ?? '')
}
```

- [ ] **Step 4: Implement the five entrypoints**

```ts
// src/hooks/worktree-created.ts
import { main } from './_hook'
await main('worktree.created')
```

```ts
// src/hooks/worktree-removed.ts
import { main } from './_hook'
await main('worktree.removed')
```

```ts
// src/hooks/agent-detected.ts
import { main } from './_hook'
await main('pane.agent_detected')
```

```ts
// src/hooks/agent-status.ts
import { main } from './_hook'
await main('pane.agent_status_changed')
```

```ts
// src/hooks/pane-exited.ts
import { main } from './_hook'
await main('pane.exited')
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/hook.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify a hook is fast enough**

Run: `time bun run src/hooks/pane-exited.ts`
Expected: completes well under 50 ms wall (no `HERDR_PLUGIN_STATE_DIR` set, so it exits immediately).

- [ ] **Step 7: Commit**

```bash
git add src/hooks test/hook.test.ts
git commit -m "feat: five append-and-exit event hooks"
```

---

## Task 9: Manifest

**Files:**
- Create: `herdr-plugin.toml`

- [ ] **Step 1: Write the manifest**

```toml
id = "stein.pipeline"
name = "Pipeline"
version = "0.1.0"
min_herdr_version = "0.9.0"
description = "Drives the superpowers pipeline across herdr worktrees"
platforms = ["macos", "linux"]

[[startup]]
command = ["bun", "run", "src/startup.ts"]

[[events]]
on = "worktree.created"
command = ["bun", "run", "src/hooks/worktree-created.ts"]

[[events]]
on = "worktree.removed"
command = ["bun", "run", "src/hooks/worktree-removed.ts"]

[[events]]
on = "pane.agent_detected"
command = ["bun", "run", "src/hooks/agent-detected.ts"]

[[events]]
on = "pane.agent_status_changed"
command = ["bun", "run", "src/hooks/agent-status.ts"]

[[events]]
on = "pane.exited"
command = ["bun", "run", "src/hooks/pane-exited.ts"]

[[actions]]
id = "status"
title = "Pipeline status"
contexts = ["global", "workspace"]
command = ["bun", "run", "src/actions/status.ts"]

[[actions]]
id = "claim"
title = "Claim this pane as orchestrator"
contexts = ["pane"]
command = ["bun", "run", "src/actions/claim.ts"]

[[actions]]
id = "drain"
title = "Drain pending events"
contexts = ["global"]
command = ["bun", "run", "src/actions/drain.ts"]

[[actions]]
id = "supervisor"
title = "Reopen the supervisor"
contexts = ["global"]
command = ["bun", "run", "src/actions/supervisor.ts"]

[[panes]]
id = "supervisor"
title = "Pipeline supervisor"
placement = "tab"
command = ["sh", "-c", "bun run src/supervisor/main.ts; code=$?; [ $code = 3 ] || echo '[pipeline] supervisor exited — run hpipe status'; exec \"${SHELL:-/bin/sh}\""]
```

> `exec "${SHELL:-/bin/sh}"` — bare `exec $SHELL` is a silent no-op when `SHELL` is unset (herdr does
> not inject it), and the pane would then vanish at exactly the moment the wrapper exists to prevent
> that. Exit code 3 is the singleton-guard path, which prints its own message.

- [ ] **Step 2: Verify the manifest parses**

Run: `herdr plugin link "$PWD" && herdr plugin list`
Expected: `stein.pipeline` listed. Check the `warnings` field is empty — an unknown event name would
appear there rather than failing the link.

- [ ] **Step 3: Unlink again until the code exists**

Run: `herdr plugin unlink stein.pipeline`
Expected: unlinked.

- [ ] **Step 4: Commit**

```bash
git add herdr-plugin.toml
git commit -m "feat: herdr plugin manifest"
```

---

## Task 10: Badges

herdr caps token values at 80 characters and 32 keys per resource, and rejects a plugin `source` that
is not `plugin:<id>`.

**Files:**
- Create: `src/lib/badges.ts`, `test/badges.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/badges.test.ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/badges.test.ts`
Expected: FAIL — cannot resolve `../src/lib/badges`.

- [ ] **Step 3: Implement**

```ts
// src/lib/badges.ts
const MAX_VALUE = 80

export function badgeSource(pluginId: string): string {
  return `plugin:${pluginId}`
}

export function buildBadges(input: {
  agent_status: string
  branch: string
  phase: string
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    status: input.agent_status,
    branch: input.branch,
    phase: input.phase,
  })) {
    if (value.length === 0) continue
    out[key] = value.slice(0, MAX_VALUE)
  }
  return out
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/badges.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/badges.ts test/badges.test.ts
git commit -m "feat: workspace badge building with herdr limit clamping"
```

---

## Task 11: Orchestrator resolution

Two steps only. The event-context `focused_pane_id` fallback is deliberately absent — measured during
review, it resolves to the *worker's* pane during dispatch.

**Files:**
- Create: `src/lib/orchestrator.ts`, `test/orchestrator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/orchestrator.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import { writeOrchestrator } from '../src/lib/ledger'
import { resolveOrchestrator } from '../src/lib/orchestrator'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orch-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('prefers an explicit claim', async () => {
  await writeOrchestrator(dir, 'personal', 'k', {
    pane_id: 'w1:p1', workspace_id: 'w1', socket_path: '/s', claimed_at: 1,
  })
  const bin = await makeFakeBin(dir, { 'pane list': { result: { panes: [{ pane_id: 'w1:p1' }] } } })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBe('w1:p1')
})

test('falls back to the repo primary workspace agent pane', async () => {
  const bin = await makeFakeBin(dir, {
    'workspace list': {
      result: {
        workspaces: [
          { workspace_id: 'w9', label: 'wt', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: true } },
          { workspace_id: 'w1', label: 'main', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: false } },
        ],
      },
    },
    'pane list': { result: { panes: [{ pane_id: 'w1:p1', agent_status: 'idle' }] } },
  })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBe('w1:p1')
})

test('returns null when two agent panes qualify, rather than picking one', async () => {
  const bin = await makeFakeBin(dir, {
    'workspace list': {
      result: {
        workspaces: [
          { workspace_id: 'w1', label: 'main', worktree: { repo_key: 'k', repo_root: '/r', is_linked_worktree: false } },
        ],
      },
    },
    'pane list': { result: { panes: [
      { pane_id: 'w1:p1', agent_status: 'idle' },
      { pane_id: 'w1:p2', agent_status: 'working' },
    ] } },
  })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBeNull()
})

test('returns null rather than guessing when nothing resolves', async () => {
  const bin = await makeFakeBin(dir, { 'workspace list': { result: { workspaces: [] } } })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBeNull()
})

test('discards a claimed pane that no longer exists', async () => {
  await writeOrchestrator(dir, 'personal', 'k', {
    pane_id: 'w4:p9', workspace_id: 'w4', socket_path: '/s', claimed_at: 1,
  })
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [] } },
    'workspace list': { result: { workspaces: [] } },
  })
  expect(await resolveOrchestrator(dir, new Herdr(bin), 'personal', 'k')).toBeNull()
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/orchestrator.test.ts`
Expected: FAIL — cannot resolve `../src/lib/orchestrator`.

- [ ] **Step 3: Implement**

```ts
// src/lib/orchestrator.ts
import type { Herdr } from './herdr'
import { readOrchestrator } from './ledger'
import type { SessionKey } from './types'

export async function resolveOrchestrator(
  stateDir: string, herdr: Herdr, session: SessionKey, repoKey: string,
): Promise<string | null> {
  const claimed = await readOrchestrator(stateDir, session, repoKey)
  if (claimed) {
    const panes = await herdr.paneList(claimed.workspace_id)
    if (panes.some((p) => p.pane_id === claimed.pane_id)) return claimed.pane_id
  }

  const workspaces = await herdr.workspaceList()
  const primary = workspaces.find(
    (w) => w.worktree?.repo_key === repoKey && w.worktree.is_linked_worktree === false,
  )
  if (!primary) return null

  const panes = await herdr.paneList(primary.workspace_id)
  const agentPanes = panes.filter(
    (p) => p.agent_status !== undefined && p.agent_status !== 'unknown',
  )

  // Ambiguity is not resolved by guessing. Pane list order is not documented as
  // meaningful, and picking wrong types a long prompt into an unrelated agent.
  // Explicit `claim` is the disambiguator, so force it.
  if (agentPanes.length !== 1) return null
  return agentPanes[0]?.pane_id ?? null
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/orchestrator.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: all green. **This closes Milestone 1.**

- [ ] **Step 6: Commit**

```bash
git add src/lib/orchestrator.ts test/orchestrator.test.ts
git commit -m "feat: orchestrator resolution by claim then repo provenance"
```

---

# Milestone 2 — Runner

## Task 12: Predicates — freshness, settle, verdict parsing

**Files:**
- Create: `src/lib/predicates.ts`, `test/predicates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/predicates.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFresh, parseVerdict } from '../src/lib/predicates'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pred-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function writeAged(name: string, body: string, mtimeMs: number): Promise<string> {
  const p = join(dir, name)
  await Bun.write(p, body)
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
  return p
}

test('a file older than phase entry is not fresh', async () => {
  const p = await writeAged('spec.md', 'x', 1_000)
  expect(await isFresh(p, 5_000)).toBe(false)
})

test('a file newer than phase entry is fresh', async () => {
  const p = await writeAged('spec.md', 'x', 9_000)
  expect(await isFresh(p, 5_000)).toBe(true)
})

test('a missing file is never fresh', async () => {
  expect(await isFresh(join(dir, 'nope.md'), 0)).toBe(false)
})

test('sub-millisecond mtime does not read as fresh against a truncated phase entry', async () => {
  // Date.now() truncates; statSync().mtimeMs does not. A file written a fraction of a
  // millisecond before phase entry must NOT count as fresh.
  const p = await writeAged('spec.md', 'x', 5_000)
  utimesSync(p, new Date(5_000), new Date(5_000))
  const withFraction = join(dir, 'frac.md')
  await Bun.write(withFraction, 'x')
  const entered = Math.floor(statSync(withFraction).mtimeMs)
  expect(await isFresh(withFraction, entered)).toBe(false)
})

test('parses a CLEAR trailer', async () => {
  const p = await writeAged('r.md', 'findings\n\nVERDICT: CLEAR\n', 9_000)
  expect(await parseVerdict(p)).toEqual({ verdict: 'CLEAR', blockers: 0, majors: 0 })
})

test('parses a BLOCKER trailer with counts', async () => {
  const p = await writeAged('r.md', 'x\n\nVERDICT: BLOCKER\nBLOCKERS: 2\nMAJORS: 5\n', 9_000)
  expect(await parseVerdict(p)).toEqual({ verdict: 'BLOCKER', blockers: 2, majors: 5 })
})

test('uses the LAST verdict line when a review quotes an earlier one', async () => {
  const p = await writeAged('r.md', 'quoting VERDICT: BLOCKER inline\n\nVERDICT: CLEAR\n', 9_000)
  expect((await parseVerdict(p))?.verdict).toBe('CLEAR')
})

test('rejects a trailer that is not the last non-empty line', async () => {
  const p = await writeAged('r.md', 'VERDICT: CLEAR\n\nstill writing the next section\n', 9_000)
  expect(await parseVerdict(p)).toBeNull()
})

test('returns null for a file with no trailer', async () => {
  const p = await writeAged('r.md', 'no verdict here\n', 9_000)
  expect(await parseVerdict(p)).toBeNull()
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/predicates.test.ts`
Expected: FAIL — cannot resolve `../src/lib/predicates`.

- [ ] **Step 3: Implement**

```ts
// src/lib/predicates.ts
import { statSync } from 'node:fs'
import type { Verdict } from './types'

export interface VerdictResult {
  verdict: Verdict
  blockers: number
  majors: number
}

export async function isFresh(path: string, phaseEnteredAt: number): Promise<boolean> {
  try {
    // `mtimeMs` carries sub-millisecond precision while `phase_entered_at` comes from
    // `Date.now()`, which truncates. Without flooring, a file written a fraction of a
    // millisecond BEFORE phase entry compares as greater and reads as fresh — a false
    // positive on exactly the stale artifact edge-triggering exists to reject.
    return Math.floor(statSync(path).mtimeMs) > phaseEnteredAt
  } catch {
    return false
  }
}

/**
 * Stability re-read. Guards against reading a file mid-write(2); it does NOT
 * prove the artifact is finished. The trailer-is-last-line rule in
 * parseVerdict is the real completeness signal for a review.
 */
export async function isSettled(path: string, settleMs: number): Promise<boolean> {
  const before = statSync(path)
  await Bun.sleep(settleMs)
  try {
    const after = statSync(path)
    return before.size === after.size && before.mtimeMs === after.mtimeMs
  } catch {
    return false
  }
}

const VERDICT_LINE = /^VERDICT:\s*(CLEAR|BLOCKER)\s*$/
const COUNT_LINE = /^(BLOCKERS|MAJORS):\s*(\d+)\s*$/

export async function parseVerdict(path: string): Promise<VerdictResult | null> {
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  const lines = (await file.text()).split('\n').map((l) => l.trim()).filter((l) => l.length > 0)

  let verdictIndex = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (VERDICT_LINE.test(lines[i] ?? '')) { verdictIndex = i; break }
  }
  if (verdictIndex === -1) return null

  // Only count lines may follow the trailer; anything else means the file is still being written.
  const counts = { blockers: 0, majors: 0 }
  for (const line of lines.slice(verdictIndex + 1)) {
    const matched = COUNT_LINE.exec(line)
    if (!matched) return null
    if (matched[1] === 'BLOCKERS') counts.blockers = Number(matched[2])
    else counts.majors = Number(matched[2])
  }

  const verdict = VERDICT_LINE.exec(lines[verdictIndex] ?? '')?.[1] as Verdict
  return { verdict, ...counts }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/predicates.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/predicates.ts test/predicates.test.ts
git commit -m "feat: freshness, settle, and trailer-last-line verdict parsing"
```

---

## Task 13: Template rendering

An unresolved placeholder is a hard error. A prompt that silently renders `{{spec_path}}` as empty
sends an agent to write a file nowhere.

**Files:**
- Create: `src/lib/render.ts`, `test/render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/render.test.ts
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
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/render.test.ts`
Expected: FAIL — cannot resolve `../src/lib/render`.

- [ ] **Step 3: Implement**

```ts
// src/lib/render.ts
import { join } from 'node:path'

const PLACEHOLDER = /\{\{(\w+)\}\}/g

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`unresolved template placeholder: ${name}`)
    return value
  })
}

export async function renderPrompt(
  pluginRoot: string, name: string, vars: Record<string, string>,
): Promise<string> {
  const template = await Bun.file(join(pluginRoot, 'prompts', `${name}.md`)).text()
  return render(template, vars)
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/render.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/render.ts test/render.test.ts
git commit -m "feat: template rendering that errors on unresolved placeholders"
```

---

## Task 14: Prompt templates

Every template names where its output goes. Review templates additionally require the machine-readable
trailer, because that is the only completeness signal the supervisor can trust.

**Files:**
- Create: `prompts/spec.md`, `prompts/spec-review.md`, `prompts/plan.md`, `prompts/plan-review.md`, `prompts/dispatch.md`, `prompts/task.md`, `prompts/task-review-spec.md`, `prompts/task-review-quality.md`, `prompts/ci-red.md`, `prompts/merge.md`, `prompts/close.md`, `prompts/branch-review.md`, `prompts/escalate.md`, `prompts/stall-probe.md`, `prompts/digest.md`
- Create: `test/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/prompts.test.ts
import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const REVIEW_PROMPTS = [
  'spec-review', 'plan-review', 'task-review-spec', 'task-review-quality', 'branch-review',
]
const ALL = [
  'spec', 'plan', 'dispatch', 'task', 'ci-red', 'merge', 'close',
  'escalate', 'stall-probe', 'digest', ...REVIEW_PROMPTS,
]

test('every declared prompt file exists', () => {
  const present = readdirSync(join(ROOT, 'prompts')).map((f) => f.replace(/\.md$/, ''))
  for (const name of ALL) expect(present).toContain(name)
})

test('no orphan prompt files', () => {
  const present = readdirSync(join(ROOT, 'prompts')).map((f) => f.replace(/\.md$/, ''))
  for (const name of present) expect(ALL).toContain(name)
})

test('review prompts demand the trailer as the last line', async () => {
  for (const name of REVIEW_PROMPTS) {
    const text = await Bun.file(join(ROOT, 'prompts', `${name}.md`)).text()
    expect(text).toContain('VERDICT: CLEAR')
    expect(text).toContain('VERDICT: BLOCKER')
    expect(text).toContain('last non-empty line')
    expect(text).toContain('{{verdict_path}}')
  }
})

test('the task prompt routes to the surface agent and demands a closing keyword', async () => {
  const text = await Bun.file(join(ROOT, 'prompts', 'task.md')).text()
  expect(text).toContain('{{agent_file}}')
  expect(text).toContain('Closes #{{issue}}')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/prompts.test.ts`
Expected: FAIL — `prompts` directory does not exist.

- [ ] **Step 3: Write `prompts/spec.md`**

```markdown
# Write the spec — run {{run_id}}

The design for **{{title}}** is agreed. Write the spec now. Do not ask whether to proceed.

Write it to exactly this path:

    {{spec_path}}

Cover: problem, goal, non-goals, architecture, the data and control flow, error handling, and a
testing strategy. Cite `file:line` for every claim about how this repo already works — verify against
the code, do not assert from memory.

Follow the repo's prime directive: mirror the nearest existing example and name the file you modelled
on. If neither this repo nor the gold standard establishes a pattern the work needs, stop and say so
rather than inventing one.

When the file exists and is complete, stop. The next step is dispatched automatically.
```

- [ ] **Step 4: Write `prompts/spec-review.md`**

```markdown
# Adversarial review of the spec — run {{run_id}}, pass {{pass}}

Dispatch a fresh subagent to review `{{spec_path}}` adversarially. A review that finds nothing is a
failed review.

The reviewer must be evidence-first: verify every claim against the installed packages, the live CLI
help, and current docs — they drift. Cite `file:line` or exact command output for every finding.
Attack internal consistency, integration seams, and contradictions introduced by churn — not just the
happy path. A wrong or half-applied fix from a prior pass is the highest-value finding there is.

Rank each finding **BLOCKER**, **MAJOR**, or **MINOR**, each as claim → problem → evidence →
concrete fix, most severe first.

The reviewer writes the review to exactly this path:

    {{verdict_path}}

It must end with a trailer whose **last non-empty line** is the verdict, optionally preceded by
counts:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 2
    MAJORS: 5

`BLOCKER` means: any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs
a judgment only the user can make. Otherwise `CLEAR`, with MAJORs and MINORs fixed inline.

Nothing but count lines may follow the verdict line — a file with prose after it reads as still being
written and will not be accepted.
```

- [ ] **Step 5: Write `prompts/plan.md`**

```markdown
# Write the implementation plan — run {{run_id}}

The spec at `{{spec_path}}` cleared review. Write the implementation plan now.

Write it to exactly this path:

    {{plan_path}}

Bite-sized tasks, two to five minutes each, TDD throughout: write the failing test, run it, implement
the minimum, run it again, commit. Exact file paths. Complete code in every step — no placeholders,
no "similar to task N", no "add appropriate error handling". Assume the implementer has no context
for this codebase.

When the file exists and is complete, stop.
```

- [ ] **Step 6: Write `prompts/plan-review.md`**

```markdown
# Adversarial review of the plan — run {{run_id}}, pass {{pass}}

Dispatch a fresh subagent to review `{{plan_path}}` adversarially against `{{spec_path}}`.

Check specifically: does every spec requirement map to a task? Do types, function names, and
signatures stay consistent across tasks? Are there placeholders, vague steps, or steps that describe
what to do without showing how? Does each task leave the tree working and committable?

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**, most severe first.

The reviewer writes the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 3

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Nothing but count lines may follow the verdict line.
```

- [ ] **Step 7: Write `prompts/dispatch.md`**

```markdown
# Decompose and dispatch — run {{run_id}}

The plan at `{{plan_path}}` cleared review. Turn it into tasks and dispatch them.

For each task:

1. **Open a GitHub issue** — one per task, no exceptions: `gh issue create`.
2. **Register it:**

       hpipe task --branch <branch> --issue <n> --surface <surface> \
                  [--depends-on <task_ids>] [--files <path-prefixes>] \
                  --text "<the full task text>"

   `--surface` routes the worker to `.claude/agents/<surface>-dev.md` and is rejected if no such file
   exists. Route by the surface the change touches, and make app tasks `--depends-on` any `core` task,
   because the apps consume the built `dist`.

   `hpipe task` prints the task id. If the task is gated it prints `queued: waiting on …` instead of a
   prompt — that is correct; you will be told when to dispatch it.

3. **When told a task is ready**, create its worktree and start the agent:

       herdr worktree create --branch <branch> --base main
       # capture .result.root_pane.pane_id from that response
       herdr agent start <name> --kind claude --pane <root_pane_id> -- \
         --dangerously-skip-permissions "<the worker prompt you were given>"

   `agent start` adopts the **existing** root pane — it does not create one, and there is no orphan
   pane to close. Do not pass `--cwd`, `--workspace`, or `--split`; they are not the 0.9.0 signature.

Never run two agents against the same files in parallel. When two tasks must touch one file,
serialize them with `--depends-on`.

Register every task, then stop.
```

- [ ] **Step 8: Write `prompts/task.md`**

```markdown
# {{branch}} — issue #{{issue}}

You own this task end to end. Work only in this worktree, only on surface `{{surface}}`.

**Read `{{agent_file}}` first** — it is the scoped guide for this surface, and the repo's root
`CLAUDE.md` outranks it where they conflict.

{{dist_note}}

## The task

{{task_text}}

## Definition of done

- TDD: a failing test first, then the minimum code to pass it.
- Mirror the nearest existing example; name the file you modelled on in your first message.
- Conventional-commit messages on this branch. Never commit to `main`.
- Open a PR whose body ends with a real closing keyword:

      Closes #{{issue}}

  "Implements #{{issue}}" does **not** auto-close the issue and will be treated as a failure.

If neither this repo nor the gold standard establishes a pattern this work needs, stop and escalate
rather than inventing one.
```

- [ ] **Step 9: Write `prompts/task-review-spec.md`**

```markdown
# Stage 1 review — spec compliance for {{branch}} (#{{issue}}), pass {{pass}}

Dispatch a fresh subagent to review PR #{{pr}} on `{{branch}}` for **spec compliance only** — does it
do what the task asked, completely, and nothing it was not asked to do? Code quality is stage 2 and
is not your concern here.

Check: every acceptance criterion in the task met; no silent scope reduction; no scope expansion;
tests actually exercise the behaviour rather than restating the implementation.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.

Write the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 0

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Nothing but count lines may follow the verdict line.
```

- [ ] **Step 10: Write `prompts/task-review-quality.md`**

```markdown
# Stage 2 review — code quality for {{branch}} (#{{issue}}), pass {{pass}}

Stage 1 confirmed PR #{{pr}} does what was asked. Dispatch a fresh subagent to review it for **code
quality**: does it match how this codebase is already written?

Check: mirrors an existing pattern rather than introducing a second way to do something; naming and
structure consistent with siblings; no dead code, no commented-out code, no comments that restate
what the next line does; error handling matches the established shape; tests are well designed, not
merely present.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.

Write the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 0
    MAJORS: 2

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Nothing but count lines may follow the verdict line.
```

- [ ] **Step 11: Write `prompts/ci-red.md`**

```markdown
# CI is red — {{branch}} (#{{issue}}), PR #{{pr}}

CI failed on PR #{{pr}}. The failing checks:

{{ci_failure}}

Send the worker back to fix it. Read the actual failure output before deciding what is wrong —
`gh run view --log-failed` — rather than guessing from the check name.

If the failure is environmental rather than a defect in this branch, say so explicitly and re-run
the check instead of editing code.
```

- [ ] **Step 12: Write `prompts/merge.md`**

```markdown
# Ready to merge — {{branch}} (#{{issue}}), PR #{{pr}}

Both review stages cleared and CI is green on PR #{{pr}}.

Before merging, check the PR does not conflict with anything merged since it branched — if another
task touched the same files, rebase this one onto the result and let CI re-run rather than merging on
a stale green.

Then merge it. Merging is yours, not the plugin's; nothing merges automatically.
```

- [ ] **Step 13: Write `prompts/close.md`**

```markdown
# Verify the issue closed — {{branch}} (#{{issue}}), PR #{{pr}}

PR #{{pr}} is merged. Confirm issue #{{issue}} actually closed:

    gh issue view {{issue}} --json closed,state

If it is still open, the PR body used a phrase GitHub does not treat as a closing keyword. Close it
by hand and note which phrasing failed, so the task prompt can be corrected.

Teardown of the worktree runs automatically once closure is confirmed.
```

- [ ] **Step 14: Write `prompts/branch-review.md`**

```markdown
# Final whole-branch review — run {{run_id}}, pass {{pass}}

Every task is merged and torn down. Dispatch a fresh subagent to review the **whole** body of work
against `{{spec_path}}`, not task by task.

Check specifically what per-task review cannot see: seams between tasks, duplicated abstractions
introduced independently by two workers, contradictions between what task 1 assumed and task 6 built,
and requirements in the spec that no task actually implemented.

Evidence-first, `file:line` citations, ranked **BLOCKER** / **MAJOR** / **MINOR**.

Write the review to exactly this path:

    {{verdict_path}}

Ending with a trailer whose **last non-empty line** is the verdict:

    VERDICT: CLEAR

or

    VERDICT: BLOCKER
    BLOCKERS: 1
    MAJORS: 2

`BLOCKER` means any BLOCKER finding, or any MAJOR that reverses a decision, changes scope, or needs a
judgment only the user can make. Nothing but count lines may follow the verdict line.
```

- [ ] **Step 15: Write `prompts/escalate.md`**

```markdown
# Escalation — run {{run_id}}, phase `{{phase}}`

This phase hit {{pass}} review passes without clearing. The pipeline has stopped here on purpose.

Do not start another pass. Summarise for the human, in a few lines:

- what the reviews keep finding,
- which decision or tradeoff is actually in dispute,
- the options, with your recommendation.

This is one of the only two reasons to interrupt them, so make it worth the interruption.

When they have answered, resume with:

    hpipe rewind {{run_id}} {{phase}}{{task_flag}}

which resets the pass count for that phase.
```

- [ ] **Step 16: Write `prompts/stall-probe.md`**

```markdown
# Still working? — run {{run_id}}, phase `{{phase}}`

This phase has been open {{minutes}} minutes and nothing has appeared at:

    {{artifact_path}}

If you are still working, ignore this — it will not ask again for this phase.

If you are waiting on the human, say so now rather than waiting silently. If you finished but wrote
the file somewhere else, move it to the path above.
```

- [ ] **Step 17: Write `prompts/digest.md`**

```markdown
[pipeline] run {{run_id}}{{phase_note}}

{{event_count}} events:
{{event_lines}}

{{next_prompt}}
```

- [ ] **Step 18: Run the tests**

Run: `bun test test/prompts.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 19: Commit**

```bash
git add prompts test/prompts.test.ts
git commit -m "feat: phase prompt templates with machine-readable verdict contract"
```

---

## Task 15: Phase machine — run-level transitions

The livelock test is the important one: re-entering a phase whose *old* artifact still exists must
not advance. That defect survived two revisions because it was fixed at one level and not the other.

**Files:**
- Create: `src/lib/machine.ts`, `test/machine-run.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/machine-run.test.ts
import { expect, test } from 'bun:test'
import { advanceRun, enterRunPhase } from '../src/lib/machine'
import { newRun } from '../src/lib/ledger'
import type { Run } from '../src/lib/types'

const mkRun = (): Run =>
  newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })

test('spec advances to spec-review when the artifact is fresh and the actor is idle', () => {
  const run = mkRun()
  const next = advanceRun(run, { actorIdle: true, artifactFresh: true, verdict: null, maxPasses: 2 })
  expect(next?.phase).toBe('spec-review')
})

test('spec does not advance while the actor is working', () => {
  const run = mkRun()
  expect(advanceRun(run, { actorIdle: false, artifactFresh: true, verdict: null, maxPasses: 2 })).toBeNull()
})

test('spec does not advance without a fresh artifact', () => {
  const run = mkRun()
  expect(advanceRun(run, { actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2 })).toBeNull()
})

test('a CLEAR spec review advances to plan', () => {
  const run = enterRunPhase(mkRun(), 'spec-review', 'test')
  const next = advanceRun(run, {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'CLEAR', blockers: 0, majors: 0 }, maxPasses: 2,
  })
  expect(next?.phase).toBe('plan')
})

test('a BLOCKER spec review returns to spec and increments pass', () => {
  const run = enterRunPhase(mkRun(), 'spec-review', 'test')
  const next = advanceRun(run, {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 }, maxPasses: 2,
  })
  expect(next?.phase).toBe('spec')
  expect(next?.pass).toBe(2)
})

test('exhausting MAX_PASSES escalates and records where from', () => {
  const run = enterRunPhase(mkRun(), 'spec-review', 'test')
  run.pass = 2
  const next = advanceRun(run, {
    actorIdle: true, artifactFresh: true,
    verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 }, maxPasses: 2,
  })
  expect(next?.phase).toBe('escalated')
  expect(next?.escalated_from).toBe('spec-review')
})

test('LIVELOCK: re-entered spec does not re-advance on the stale artifact', () => {
  // The spec file still exists from pass 1, but its mtime predates this phase entry.
  const run = enterRunPhase(mkRun(), 'spec', 'blocker on pass 1')
  expect(advanceRun(run, { actorIdle: true, artifactFresh: false, verdict: null, maxPasses: 2 })).toBeNull()
})

test('enterRunPhase stamps phase_entered_at and appends history', () => {
  const before = Date.now() - 1
  const run = enterRunPhase(mkRun(), 'plan', 'spec review cleared')
  expect(run.phase_entered_at).toBeGreaterThan(before)
  expect(run.history.at(-1)).toMatchObject({ to: 'plan', why: 'spec review cleared' })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/machine-run.test.ts`
Expected: FAIL — cannot resolve `../src/lib/machine`.

- [ ] **Step 3: Implement**

```ts
// src/lib/machine.ts
import type { VerdictResult } from './predicates'
import type { Run, RunPhase, Task, TaskPhase } from './types'

export interface RunSignals {
  actorIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  maxPasses: number
}

/** Phases whose completion signal is an artifact file. */
export const ARTIFACT_RUN_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'spec', 'spec-review', 'plan', 'plan-review', 'branch-review',
])

const REVIEW_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>([
  'spec-review', 'plan-review', 'branch-review',
])

const ON_CLEAR: Partial<Record<RunPhase, RunPhase>> = {
  spec: 'spec-review',
  'spec-review': 'plan',
  plan: 'plan-review',
  'plan-review': 'dispatch',
  'branch-review': 'done',
}

const ON_BLOCKER: Partial<Record<RunPhase, RunPhase>> = {
  'spec-review': 'spec',
  'plan-review': 'plan',
  'branch-review': 'branch-review',
}

export function enterRunPhase(run: Run, phase: RunPhase, why: string): Run {
  run.history.push({ at: Date.now(), from: run.phase, to: phase, why })
  if (phase === 'escalated') run.escalated_from = run.phase
  run.phase = phase
  run.phase_entered_at = Date.now()
  return run
}

export function advanceRun(run: Run, signals: RunSignals): Run | null {
  if (!ARTIFACT_RUN_PHASES.has(run.phase)) return null
  if (!signals.actorIdle || !signals.artifactFresh) return null

  if (!REVIEW_PHASES.has(run.phase)) {
    const next = ON_CLEAR[run.phase]
    return next ? enterRunPhase(run, next, 'actor idle + artifact fresh') : null
  }

  if (!signals.verdict) return null

  if (signals.verdict.verdict === 'CLEAR') {
    const next = ON_CLEAR[run.phase]
    return next ? enterRunPhase(run, next, 'review cleared') : null
  }

  if (run.pass >= signals.maxPasses) {
    return enterRunPhase(run, 'escalated', `${run.pass} passes without clearing`)
  }

  const back = ON_BLOCKER[run.phase]
  if (!back) return null
  const passes = run.pass + 1
  enterRunPhase(run, back, `review returned BLOCKER (pass ${run.pass})`)
  run.pass = passes
  return run
}

export function enterTaskPhase(run: Run, task: Task, phase: TaskPhase, why: string): Task {
  run.history.push({ at: Date.now(), task_id: task.task_id, from: task.phase, to: phase, why })
  if (phase === 'escalated') task.escalated_from = task.phase
  task.phase = phase
  task.phase_entered_at = Date.now()
  return task
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/machine-run.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine.ts test/machine-run.test.ts
git commit -m "feat: run-level phase machine with edge-triggered predicates"
```

---

## Task 16: Task-level transitions, including the escalation twin

`MAX_PASSES` and `escalated` exist at **both** levels. A task that keeps failing review escalates
alone, and the run continues with its remaining tasks.

**Files:**
- Modify: `src/lib/machine.ts`
- Create: `test/machine-task.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/machine-task.test.ts
import { expect, test } from 'bun:test'
import { advanceTask, enterTaskPhase } from '../src/lib/machine'
import { newRun } from '../src/lib/ledger'
import type { Run, Task, TaskPhase } from '../src/lib/types'

function fixture(phase: TaskPhase): { run: Run; task: Task } {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 't' })
  const task: Task = {
    task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
    depends_on: [], files: [], keep_worktree: false, text: 'do it',
    workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
    phase, pass: 1, phase_entered_at: Date.now(), escalated_from: null,
    head_sha_at_entry: 'aaa', pr: 5, ci: null,
  }
  run.tasks.push(task)
  return { run, task }
}

test('execute advances when the worker is idle, a PR exists, and the head sha moved', () => {
  const { run, task } = fixture('execute')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: true, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'bbb', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('task-review-spec')
})

test('execute does NOT advance when the head sha is unchanged', () => {
  const { run, task } = fixture('execute')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: true, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next).toBeNull()
})

test('stage 1 CLEAR moves to stage 2, not straight to ci', () => {
  const { run, task } = fixture('task-review-spec')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: true,
    verdict: { verdict: 'CLEAR', blockers: 0, majors: 0 },
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('task-review-quality')
})

test('a task escalates alone at MAX_PASSES', () => {
  const { run, task } = fixture('task-review-quality')
  task.pass = 2
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: true,
    verdict: { verdict: 'BLOCKER', blockers: 1, majors: 0 },
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('escalated')
  expect(next?.escalated_from).toBe('task-review-quality')
  expect(run.phase).not.toBe('escalated')
})

test('merge requires mergedAt to postdate phase entry, not merely MERGED', () => {
  const { run, task } = fixture('merge')
  const stale = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: true, mergedAtMs: task.phase_entered_at - 1_000,
    issueClosed: false, ciBucket: null, maxPasses: 2,
  })
  expect(stale).toBeNull()
})

test('merge advances when mergedAt postdates phase entry', () => {
  const { run, task } = fixture('merge')
  const next = advanceTask(run, task, {
    actorIdle: true, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: true, mergedAtMs: task.phase_entered_at + 1_000,
    issueClosed: false, ciBucket: null, maxPasses: 2,
  })
  expect(next?.phase).toBe('close')
})

test('ci pass advances to merge; ci fail returns to execute', () => {
  const pass = fixture('ci')
  expect(advanceTask(pass.run, pass.task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: 'pass', maxPasses: 2,
  })?.phase).toBe('merge')

  const fail = fixture('ci')
  expect(advanceTask(fail.run, fail.task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: 'fail', maxPasses: 2,
  })?.phase).toBe('execute')
})

test('a pending ci bucket advances nothing', () => {
  const { run, task } = fixture('ci')
  expect(advanceTask(run, task, {
    actorIdle: false, workerIdle: false, artifactFresh: false, verdict: null,
    prNumber: 5, headSha: 'aaa', merged: false, issueClosed: false,
    ciBucket: 'pending', maxPasses: 2,
  })).toBeNull()
})

test('enterTaskPhase records the task id in run history', () => {
  const { run, task } = fixture('execute')
  enterTaskPhase(run, task, 'ci', 'both reviews cleared')
  expect(run.history.at(-1)).toMatchObject({ task_id: 't1', to: 'ci' })
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/machine-task.test.ts`
Expected: FAIL — `advanceTask` is not exported.

- [ ] **Step 3: Add `advanceTask` to `src/lib/machine.ts`**

Append to the existing file:

```ts
export interface TaskSignals {
  actorIdle: boolean
  workerIdle: boolean
  artifactFresh: boolean
  verdict: VerdictResult | null
  prNumber: number | null
  headSha: string | null
  merged: boolean
  mergedAtMs?: number
  issueClosed: boolean
  closedAtMs?: number
  ciBucket: CiBucket | null
  maxPasses: number
}

const TASK_REVIEW_PHASES: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'task-review-spec', 'task-review-quality',
])

export const ARTIFACT_TASK_PHASES = TASK_REVIEW_PHASES

export function advanceTask(run: Run, task: Task, s: TaskSignals): Task | null {
  switch (task.phase) {
    case 'execute': {
      // Edge, not level: the PR must have moved since this phase was entered.
      const moved = s.headSha !== null && s.headSha !== task.head_sha_at_entry
      if (!s.workerIdle || s.prNumber === null || !moved) return null
      task.pr = s.prNumber
      return enterTaskPhase(run, task, 'task-review-spec', `PR #${s.prNumber} at ${s.headSha}`)
    }

    case 'task-review-spec':
    case 'task-review-quality': {
      if (!s.actorIdle || !s.artifactFresh || !s.verdict) return null

      if (s.verdict.verdict === 'CLEAR') {
        const next: TaskPhase = task.phase === 'task-review-spec' ? 'task-review-quality' : 'ci'
        return enterTaskPhase(run, task, next, 'review cleared')
      }

      if (task.pass >= s.maxPasses) {
        return enterTaskPhase(run, task, 'escalated', `${task.pass} passes without clearing`)
      }

      const passes = task.pass + 1
      enterTaskPhase(run, task, 'execute', `review returned BLOCKER (pass ${task.pass})`)
      task.pass = passes
      task.head_sha_at_entry = s.headSha
      return task
    }

    case 'ci': {
      if (s.ciBucket === 'pass') return enterTaskPhase(run, task, 'merge', 'CI green')
      if (s.ciBucket === 'fail') {
        enterTaskPhase(run, task, 'execute', 'CI red')
        task.head_sha_at_entry = s.headSha
        return task
      }
      return null
    }

    case 'merge': {
      if (!s.merged) return null
      if (s.mergedAtMs === undefined || s.mergedAtMs <= task.phase_entered_at) return null
      return enterTaskPhase(run, task, 'close', 'PR merged')
    }

    case 'close': {
      if (!s.issueClosed) return null
      if (s.closedAtMs === undefined || s.closedAtMs <= task.phase_entered_at) return null
      return enterTaskPhase(run, task, 'teardown', `issue #${task.issue} closed`)
    }

    default:
      return null
  }
}
```

Add `CiBucket` to the type import at the top of the file:

```ts
import type { CiBucket, Run, RunPhase, Task, TaskPhase } from './types'
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/machine-task.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/machine.ts test/machine-task.test.ts
git commit -m "feat: task-level transitions with per-task escalation and GitHub-state edges"
```

---

## Task 17: The `queued` gate

**Files:**
- Create: `src/lib/gating.ts`, `test/gating.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/gating.test.ts
import { expect, test } from 'bun:test'
import { detectCycle, filesOverlap, gateStatus } from '../src/lib/gating'
import type { Task } from '../src/lib/types'

const task = (over: Partial<Task>): Task => ({
  task_id: 't', branch: 'b', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: null, pane_id: null, agent_status: 'unknown',
  phase: 'queued', pass: 1, phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null, ...over,
})

test('files overlap on a prefix, not only an exact path', () => {
  expect(filesOverlap(['packages/core/src/db/'], ['packages/core/src/db/usage.ts'])).toBe(true)
  expect(filesOverlap(['apps/api/'], ['packages/core/'])).toBe(false)
})

test('a task with satisfied dependencies and no overlap is ready', () => {
  const done = task({ task_id: 't1', phase: 'done' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [done, waiting])).toEqual({ state: 'ready' })
})

test('a task waits on an unfinished dependency', () => {
  const running = task({ task_id: 't1', phase: 'execute' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [running, waiting])).toEqual({ state: 'waiting', on: ['t1'] })
})

test('a failed dependency blocks permanently rather than waiting forever', () => {
  const failed = task({ task_id: 't1', phase: 'failed' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [failed, waiting])).toEqual({ state: 'blocked-on-failure', on: ['t1'] })
})

test('an orphaned dependency also blocks permanently', () => {
  const orphaned = task({ task_id: 't1', phase: 'orphaned' })
  const waiting = task({ task_id: 't2', depends_on: ['t1'] })
  expect(gateStatus(waiting, [orphaned, waiting]).state).toBe('blocked-on-failure')
})

test('an in-flight task holding an overlapping file blocks the gate', () => {
  const running = task({ task_id: 't1', phase: 'execute', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', files: ['packages/core/src/db/usage.ts'] })
  expect(gateStatus(waiting, [running, waiting])).toEqual({ state: 'waiting', on: ['t1'] })
})

test('a finished task does not hold its files', () => {
  const done = task({ task_id: 't1', phase: 'done', files: ['packages/core/'] })
  const waiting = task({ task_id: 't2', files: ['packages/core/x.ts'] })
  expect(gateStatus(waiting, [done, waiting]).state).toBe('ready')
})

test('detectCycle names a cycle', () => {
  const a = task({ task_id: 't1', depends_on: ['t2'] })
  const b = task({ task_id: 't2', depends_on: ['t1'] })
  expect(detectCycle([a, b])).toEqual(['t1', 't2'])
})

test('detectCycle returns null for an acyclic graph', () => {
  const a = task({ task_id: 't1' })
  const b = task({ task_id: 't2', depends_on: ['t1'] })
  expect(detectCycle([a, b])).toBeNull()
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/gating.test.ts`
Expected: FAIL — cannot resolve `../src/lib/gating`.

- [ ] **Step 3: Implement**

```ts
// src/lib/gating.ts
import type { Task, TaskPhase } from './types'

const TERMINAL_OK: ReadonlySet<TaskPhase> = new Set<TaskPhase>(['done'])
const TERMINAL_BAD: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'failed', 'orphaned', 'blocked-on-failure', 'escalated',
])

export type GateState =
  | { state: 'ready' }
  | { state: 'waiting'; on: string[] }
  | { state: 'blocked-on-failure'; on: string[] }

/**
 * Declared-intent heuristic, not enforcement: entries are path prefixes, and the
 * real backstop is the orchestrator's PR-level conflict check before merge.
 */
export function filesOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => x.startsWith(y) || y.startsWith(x)))
}

function isInFlight(task: Task): boolean {
  return !TERMINAL_OK.has(task.phase) && !TERMINAL_BAD.has(task.phase) && task.phase !== 'queued'
}

export function gateStatus(task: Task, all: Task[]): GateState {
  const byId = new Map(all.map((t) => [t.task_id, t]))

  const broken = task.depends_on.filter((id) => {
    const dep = byId.get(id)
    return dep !== undefined && TERMINAL_BAD.has(dep.phase)
  })
  if (broken.length > 0) return { state: 'blocked-on-failure', on: broken }

  const pending = task.depends_on.filter((id) => {
    const dep = byId.get(id)
    return dep === undefined || !TERMINAL_OK.has(dep.phase)
  })
  if (pending.length > 0) return { state: 'waiting', on: pending }

  const colliding = all
    .filter((t) => t.task_id !== task.task_id && isInFlight(t) && filesOverlap(task.files, t.files))
    .map((t) => t.task_id)
  if (colliding.length > 0) return { state: 'waiting', on: colliding }

  return { state: 'ready' }
}

/** Kahn's algorithm. Returns the ids still in the graph when progress stops. */
export function detectCycle(tasks: Task[]): string[] | null {
  const indegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const t of tasks) {
    indegree.set(t.task_id, 0)
    dependents.set(t.task_id, [])
  }
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!indegree.has(dep)) continue
      indegree.set(t.task_id, (indegree.get(t.task_id) ?? 0) + 1)
      dependents.get(dep)?.push(t.task_id)
    }
  }

  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id)
  let visited = 0
  while (queue.length > 0) {
    const id = queue.shift() as string
    visited++
    for (const next of dependents.get(id) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1
      indegree.set(next, remaining)
      if (remaining === 0) queue.push(next)
    }
  }

  if (visited === tasks.length) return null
  return [...indegree.entries()].filter(([, n]) => n > 0).map(([id]) => id).sort()
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/gating.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/gating.ts test/gating.test.ts
git commit -m "feat: queued gating with dependency, collision, and cycle rules"
```

---

## Task 18: `hpipe` CLI

Manifest actions accept no arguments, so everything carrying data goes through this CLI. Note
`hpipe start` and `hpipe task` **print** their prompts rather than injecting — the caller is by
construction mid-turn running the command.

**Files:**
- Create: `src/cli.ts`, `test/cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/cli.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeRunForRepo, newRun, saveRun } from '../src/lib/ledger'
import { cmdRewind, cmdStart, cmdTask } from '../src/cli'

let dir: string
let repoDir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-'))
  // `hpipe task` rejects a --surface with no matching agent definition, so the
  // fixture repo must carry real ones.
  repoDir = mkdtempSync(join(tmpdir(), 'repo-'))
  mkdirSync(join(repoDir, '.claude', 'agents'), { recursive: true })
  for (const surface of ['core', 'api']) {
    writeFileSync(join(repoDir, '.claude', 'agents', `${surface}-dev.md`), `# ${surface}-dev\n`)
  }
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(repoDir, { recursive: true, force: true })
})

test('start opens a run and prints the spec prompt', async () => {
  const out = await cmdStart(ctx(), {
    title: 'chat meter', repoKey: 'k', repoRoot: repoDir, socketPath: '/s',
    paneId: 'w1:p1', workspaceId: 'w1',
  })
  expect(out.ok).toBe(true)
  expect(out.text).toContain('Write the spec')
  expect((await activeRunForRepo(dir, 'personal', 'k'))?.title).toBe('chat meter')
})

test('start refuses a second run for the same repo and names the blocker', async () => {
  const first = await cmdStart(ctx(), {
    title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
  })
  const second = await cmdStart(ctx(), {
    title: 'b', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1',
  })
  expect(second.ok).toBe(false)
  expect(second.text).toContain(JSON.parse(first.json ?? '{}').run_id ?? 'run')
})

test('task prints its id and withholds the prompt while gated', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const run = await activeRunForRepo(dir, 'personal', 'k')
  run!.phase = 'dispatch'
  await saveRun(dir, run!)

  const t1 = await cmdTask(c, { branch: 'feat/core', issue: 1, surface: 'core', text: 'core work', dependsOn: [], files: [], keepWorktree: false })
  const t2 = await cmdTask(c, { branch: 'feat/api', issue: 2, surface: 'api', text: 'api work', dependsOn: ['t1'], files: [], keepWorktree: false })

  expect(t1.text).toContain('task_id: t1')
  expect(t1.text).toContain('feat/core')
  expect(t2.text).toContain('task_id: t2')
  expect(t2.text).toContain('queued: waiting on t1')
  expect(t2.text).not.toContain('api work')
})

test('task rejects a dependency cycle', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const run = await activeRunForRepo(dir, 'personal', 'k')
  run!.phase = 'dispatch'
  await saveRun(dir, run!)

  await cmdTask(c, { branch: 'a', issue: 1, surface: 'core', text: 'x', dependsOn: [], files: [], keepWorktree: false })
  const bad = await cmdTask(c, { branch: 'b', issue: 2, surface: 'core', text: 'y', dependsOn: ['t1', 't2'], files: [], keepWorktree: false })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('cycle')
})

test('task rejects a surface with no agent definition', async () => {
  const c = ctx()
  await cmdStart(c, { title: 'a', repoKey: 'k', repoRoot: repoDir, socketPath: '/s', paneId: 'w1:p1', workspaceId: 'w1' })
  const run = await activeRunForRepo(dir, 'personal', 'k')
  run!.phase = 'dispatch'
  await saveRun(dir, run!)

  // A typo in --surface would otherwise render a plausible dead path into the
  // worker prompt and fail only once the worker went looking for it.
  const bad = await cmdTask(c, { branch: 'x', issue: 9, surface: 'kore', text: 'y', dependsOn: [], files: [], keepWorktree: false })
  expect(bad.ok).toBe(false)
  expect(bad.text).toContain('kore-dev.md')
})

test('rewind resets the pass count for the phase it rewinds to', async () => {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: repoDir, title: 'a' })
  run.phase = 'escalated'
  run.escalated_from = 'spec-review'
  run.pass = 2
  await saveRun(dir, run)

  const out = await cmdRewind(ctx(), { runId: run.run_id, phase: 'spec', taskId: null })
  expect(out.ok).toBe(true)
  const after = await activeRunForRepo(dir, 'personal', 'k')
  expect(after?.phase).toBe('spec')
  expect(after?.pass).toBe(1)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/cli.test.ts`
Expected: FAIL — cannot resolve `../src/cli`.

- [ ] **Step 3: Implement**

```ts
#!/usr/bin/env bun
// src/cli.ts
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { detectCycle, gateStatus } from './lib/gating'
import {
  activeRunForRepo, listRuns, newRun, saveRun, writeOrchestrator,
} from './lib/ledger'
import { enterRunPhase } from './lib/machine'
import { renderPrompt } from './lib/render'
import { sessionKey } from './lib/session'
import type { Run, RunPhase, Task, TaskPhase } from './lib/types'

export interface Ctx { stateDir: string; pluginRoot: string; session: string }
export interface CmdResult { ok: boolean; text: string; json?: string }

const ok = (text: string, json?: string): CmdResult => ({ ok: true, text, json })
const fail = (text: string): CmdResult => ({ ok: false, text })

export async function cmdStart(ctx: Ctx, input: {
  title: string; repoKey: string; repoRoot: string
  socketPath: string; paneId: string; workspaceId: string
}): Promise<CmdResult> {
  const existing = await activeRunForRepo(ctx.stateDir, ctx.session, input.repoKey)
  if (existing) {
    return fail(`a run is already active for this repo: ${existing.run_id} (phase ${existing.phase}). ` +
      `Finish it, or run: hpipe abort ${existing.run_id}`)
  }

  const run = newRun({
    session: ctx.session, socketPath: input.socketPath,
    repoKey: input.repoKey, repoRoot: input.repoRoot, title: input.title,
  })
  run.orchestrator_pane = input.paneId
  run.artifacts.spec = join(
    'docs/superpowers/specs',
    `${new Date().toISOString().slice(0, 10)}-${run.run_id.split('-').slice(-2, -1)[0] ?? 'design'}-design.md`,
  )
  await saveRun(ctx.stateDir, run)
  await writeOrchestrator(ctx.stateDir, ctx.session, input.repoKey, {
    pane_id: input.paneId, workspace_id: input.workspaceId,
    socket_path: input.socketPath, claimed_at: Date.now(),
  })

  const text = await renderPrompt(ctx.pluginRoot, 'spec', {
    run_id: run.run_id, title: run.title, spec_path: join(run.repo_root, run.artifacts.spec),
  })
  return ok(text, JSON.stringify({ run_id: run.run_id }))
}

export async function cmdTask(ctx: Ctx, input: {
  branch: string; issue: number; surface: string; text: string
  dependsOn: string[]; files: string[]; keepWorktree: boolean
}): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const run = runs.find((r) => r.phase === 'dispatch' || r.phase === 'execute')
  if (!run) return fail('no run is in the dispatch or execute phase')

  const agentFile = join(run.repo_root, '.claude', 'agents', `${input.surface}-dev.md`)
  if (!existsSync(agentFile)) {
    return fail(`no agent definition at ${agentFile} — check --surface`)
  }

  const task: Task = {
    task_id: `t${run.tasks.length + 1}`,
    branch: input.branch, issue: input.issue, surface: input.surface,
    depends_on: input.dependsOn, files: input.files,
    keep_worktree: input.keepWorktree, text: input.text,
    workspace_id: null, pane_id: null, agent_status: 'unknown',
    phase: 'queued', pass: 1, phase_entered_at: Date.now(),
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  }

  const cycle = detectCycle([...run.tasks, task])
  if (cycle) return fail(`--depends-on forms a cycle: ${cycle.join(' → ')}`)

  run.tasks.push(task)
  if (run.phase === 'dispatch') enterRunPhase(run, 'execute', 'first task registered')
  await saveRun(ctx.stateDir, run)

  const gate = gateStatus(task, run.tasks)
  if (gate.state !== 'ready') {
    return ok(`task_id: ${task.task_id}\nqueued: waiting on ${gate.on.join(', ')}`)
  }

  const prompt = await renderWorkerPrompt(ctx, run, task)
  return ok(`task_id: ${task.task_id}\n\n${prompt}`)
}

export async function renderWorkerPrompt(ctx: Ctx, run: Run, task: Task): Promise<string> {
  const dependsOnCore = task.depends_on.some(
    (id) => run.tasks.find((t) => t.task_id === id)?.surface === 'core',
  )
  return renderPrompt(ctx.pluginRoot, 'task', {
    branch: task.branch,
    issue: String(task.issue),
    surface: task.surface,
    agent_file: join('.claude', 'agents', `${task.surface}-dev.md`),
    task_text: task.text,
    dist_note: dependsOnCore
      ? '> `@repo/core` changed on `main` since this branch was cut. Run ' +
        '`pnpm install && pnpm turbo build --filter=@repo/core` before your first edit and again ' +
        'before opening the PR — the apps consume the built `dist`, not the source.'
      : '',
  })
}

export async function cmdRewind(ctx: Ctx, input: {
  runId: string; phase: string; taskId: string | null
}): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  if (input.taskId) {
    const task = run.tasks.find((t) => t.task_id === input.taskId)
    if (!task) return fail(`no such task: ${input.taskId}`)
    task.phase = input.phase as TaskPhase
    task.pass = 1
    task.phase_entered_at = Date.now()
    task.escalated_from = null
    run.history.push({ at: Date.now(), task_id: task.task_id, from: 'rewind', to: input.phase, why: 'manual rewind' })
  } else {
    run.phase = input.phase as RunPhase
    run.pass = 1
    run.phase_entered_at = Date.now()
    run.escalated_from = null
    run.history.push({ at: Date.now(), from: 'rewind', to: input.phase, why: 'manual rewind' })
  }

  await saveRun(ctx.stateDir, run)
  return ok(`rewound ${input.taskId ?? input.runId} to ${input.phase}; pass reset to 1`)
}
```

> The argv dispatcher for `start`/`task`/`rewind` is Task 25; the remaining commands
> (`status`/`drain`/`resume`/`abort`/`forget`) are Task 28, once the `status` action's formatter exists and can be
> shared. Keep the command functions pure and argv-free so both callers can use them.

- [ ] **Step 4: Run the tests**

Run: `bun test test/cli.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: hpipe start/task/rewind with gate-aware prompt withholding"
```

---

## Task 19: Supervisor tick

The tick is where at-least-once is restored: the ledger is written before any delivery, and dedup
makes a replay harmless. Also where **at most one orchestrator-owned phase advances per orchestrator
per tick** — without that rule, several tasks entering phases together have no defined winner for the
single rendered prompt slot.

**Files:**
- Create: `src/supervisor/tick.ts`, `test/tick.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/tick.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyEvents, pickOneAdvance } from '../src/supervisor/tick'
import { newRun, saveRun } from '../src/lib/ledger'
import type { QueuedEvent, Run, Task } from '../src/lib/types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tick-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'working',
  phase: 'execute', pass: 1, phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null, ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

test('an agent_status event updates the matching task', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'idle' },
  ]
  const { changed } = applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.agent_status).toBe('idle')
  expect(changed).toBe(true)
})

test('events for another session are ignored', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'default', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'idle' },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.agent_status).toBe('working')
})

test('an orchestrator pane event never wakes anything', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' },
  ]
  const { wake } = applyEvents([run], events, 'personal', new Set(['w1:p1']))
  expect(wake).toHaveLength(0)
})

test('a repeated status is deduped', () => {
  const run = mkRun([mkTask({ agent_status: 'idle' })])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_status_changed', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', agent_status: 'idle' },
  ]
  const { wake } = applyEvents([run], events, 'personal', new Set())
  expect(wake).toHaveLength(0)
})

test('pane.exited marks the task failed when it has no PR', () => {
  const run = mkRun([mkTask({ pr: null })])
  const events: QueuedEvent[] = [
    { kind: 'pane.exited', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7' },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.phase).toBe('failed')
})

test('an agent release also fails the task', () => {
  const run = mkRun([mkTask({})])
  const events: QueuedEvent[] = [
    { kind: 'pane.agent_detected', session: 'personal', at: 1, pane_id: 'w7:p1', workspace_id: 'w7', released: true },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.phase).toBe('failed')
})

test('worktree.created binds a workspace to the matching branch', () => {
  const run = mkRun([mkTask({ workspace_id: null, branch: 'feat/x' })])
  const events: QueuedEvent[] = [
    { kind: 'worktree.created', session: 'personal', at: 1, workspace_id: 'w9', branch: 'feat/x', repo_key: 'k', repo_root: '/r', is_linked_worktree: true },
  ]
  applyEvents([run], events, 'personal', new Set())
  expect(run.tasks[0]?.workspace_id).toBe('w9')
})

test('pickOneAdvance returns at most one candidate per orchestrator', () => {
  const run = mkRun([
    mkTask({ task_id: 't1', phase: 'task-review-spec' }),
    mkTask({ task_id: 't2', phase: 'task-review-quality' }),
  ])
  run.orchestrator_pane = 'w1:p1'
  const picked = pickOneAdvance([run])
  expect(picked).toHaveLength(1)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/tick.test.ts`
Expected: FAIL — cannot resolve `../src/supervisor/tick`.

- [ ] **Step 3: Implement**

```ts
// src/supervisor/tick.ts
import { enterTaskPhase } from '../lib/machine'
import type { QueuedEvent, Run, SessionKey, Task } from '../lib/types'

export interface WakeLine {
  run: Run
  task: Task | null
  text: string
}

export interface ApplyResult {
  changed: boolean
  wake: WakeLine[]
}

function findTask(runs: Run[], predicate: (t: Task) => boolean): { run: Run; task: Task } | null {
  for (const run of runs) {
    const task = run.tasks.find(predicate)
    if (task) return { run, task }
  }
  return null
}

export function applyEvents(
  runs: Run[], events: QueuedEvent[], session: SessionKey, orchestratorPanes: Set<string>,
): ApplyResult {
  let changed = false
  const wake: WakeLine[] = []

  for (const event of events) {
    if (event.session !== session) continue
    if (event.pane_id && orchestratorPanes.has(event.pane_id)) continue

    if (event.kind === 'worktree.created' && event.branch && event.workspace_id) {
      const found = findTask(runs, (t) => t.branch === event.branch && t.workspace_id === null)
      if (found) {
        found.task.workspace_id = event.workspace_id
        changed = true
      }
      continue
    }

    if (!event.pane_id && !event.workspace_id) continue

    const found = findTask(
      runs,
      (t) =>
        (event.pane_id !== undefined && t.pane_id === event.pane_id) ||
        (event.workspace_id !== undefined && t.workspace_id === event.workspace_id),
    )
    if (!found) continue
    const { run, task } = found

    if (event.kind === 'pane.agent_detected') {
      if (event.released === true) {
        enterTaskPhase(run, task, 'failed', 'agent released')
        wake.push({ run, task, text: `${task.branch} (#${task.issue}, ${task.task_id}) agent released` })
      } else if (event.pane_id) {
        task.pane_id = event.pane_id
      }
      changed = true
      continue
    }

    if (event.kind === 'pane.exited') {
      enterTaskPhase(run, task, 'failed', task.pr ? 'pane exited after PR' : 'pane exited with no PR')
      wake.push({
        run, task,
        text: `${task.branch} (#${task.issue}, ${task.task_id}) exited${task.pr ? '' : ', no PR'}`,
      })
      changed = true
      continue
    }

    if (event.kind === 'pane.agent_status_changed' && event.agent_status) {
      if (task.agent_status === event.agent_status) continue
      task.agent_status = event.agent_status
      changed = true
      if (event.agent_status === 'blocked' || event.agent_status === 'done' || event.agent_status === 'idle') {
        wake.push({
          run, task,
          text: `${task.branch} (#${task.issue}, ${task.task_id}) ${event.agent_status}`,
        })
      }
    }
  }

  return { changed, wake }
}

/**
 * At most one orchestrator-owned advance per orchestrator per tick. Every
 * orchestrator-owned row gates on the same pane reading idle, so without this
 * several phases enter together and the digest's single prompt slot has no winner.
 */
export function pickOneAdvance(runs: Run[]): Run[] {
  const seen = new Set<string>()
  const picked: Run[] = []
  for (const run of runs) {
    const pane = run.orchestrator_pane
    if (!pane || seen.has(pane)) continue
    seen.add(pane)
    picked.push(run)
  }
  return picked
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/tick.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/tick.ts test/tick.test.ts
git commit -m "feat: supervisor tick event application and single-advance rule"
```

---

## Task 20: Supervisor main — singleton guard and loop

**Files:**
- Create: `src/supervisor/main.ts`, `src/lib/pidfile.ts`, `test/pidfile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/pidfile.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processStartedAtMs, readPid, supervisorState, writePid } from '../src/lib/pidfile'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pid-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('reports none when no pid file exists', async () => {
  expect((await supervisorState(dir, 'personal')).state).toBe('none')
})

test('reports live for our own running process with a matching start time', async () => {
  await writePid(dir, {
    pid: process.pid, pane_pid: process.ppid, started_at_ms: await processStartedAtMs(process.pid) ?? 0,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'personal')).state).toBe('live')
})

test('reports stale when the recorded start time does not match the live pid', async () => {
  await writePid(dir, {
    pid: process.pid, pane_pid: process.ppid, started_at_ms: 1,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'personal')).state).toBe('stale')
})

test('reports stale for a pid that does not exist', async () => {
  await writePid(dir, {
    pid: 999_999, pane_pid: 1, started_at_ms: 1,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'personal')).state).toBe('stale')
})

test('another session owns its own file and does not collide', async () => {
  await writePid(dir, {
    pid: process.pid, pane_pid: process.ppid, started_at_ms: await processStartedAtMs(process.pid) ?? 0,
    session: 'personal', socket_path: '/s', pane_id: 'w1:p2',
  })
  expect((await supervisorState(dir, 'default')).state).toBe('none')
  expect((await readPid(dir, 'personal'))?.pane_id).toBe('w1:p2')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/pidfile.test.ts`
Expected: FAIL — cannot resolve `../src/lib/pidfile`.

- [ ] **Step 3: Implement the pid file**

```ts
// src/lib/pidfile.ts
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, writeJson } from './store'
import type { SessionKey, SupervisorPid } from './types'

const pidPath = (stateDir: string, session: SessionKey) =>
  join(stateDir, `supervisor.${session}.pid`)

export type SupervisorState =
  | { state: 'none' }
  | { state: 'live'; info: SupervisorPid }
  | { state: 'stale'; info: SupervisorPid }

/** Process start time, used to defeat pid reuse. macOS and Linux both support `ps -o lstart=`. */
export async function processStartedAtMs(pid: number): Promise<number | null> {
  const proc = Bun.spawn(['ps', '-p', String(pid), '-o', 'lstart='], { stdout: 'pipe', stderr: 'ignore' })
  const text = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (text.length === 0) return null
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? null : parsed
}

export async function writePid(stateDir: string, info: SupervisorPid): Promise<void> {
  await writeJson(pidPath(stateDir, info.session), info)
}

export async function readPid(
  stateDir: string, session: SessionKey,
): Promise<SupervisorPid | null> {
  return readJson<SupervisorPid>(pidPath(stateDir, session))
}

export function clearPid(stateDir: string, session: SessionKey): void {
  try {
    unlinkSync(pidPath(stateDir, session))
  } catch {
    // Already gone.
  }
}

export async function supervisorState(
  stateDir: string, session: SessionKey,
): Promise<SupervisorState> {
  const info = await readPid(stateDir, session)
  if (!info) return { state: 'none' }

  const startedAt = await processStartedAtMs(info.pid)
  if (startedAt === null) return { state: 'stale', info }

  // Allow a second of slop: `ps` reports whole seconds.
  if (Math.abs(startedAt - info.started_at_ms) > 1_000) return { state: 'stale', info }
  return { state: 'live', info }
}
```

- [ ] **Step 4: Implement the loop**

```ts
// src/supervisor/main.ts
import { join } from 'node:path'
import { loadConfig } from '../lib/config'
import { Herdr } from '../lib/herdr'
import { clearPid, processStartedAtMs, supervisorState, writePid } from '../lib/pidfile'
import { drain } from '../lib/queue'
import { allOrchestratorPanes, listRuns, saveRun } from '../lib/ledger'
import { sessionKey } from '../lib/session'
import { applyEvents, pickOneAdvance } from './tick'

const EXIT_DUPLICATE = 3

async function main(): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  if (!stateDir || !configDir) {
    console.error('[pipeline] missing HERDR_PLUGIN_STATE_DIR or HERDR_PLUGIN_CONFIG_DIR')
    process.exit(1)
  }

  const session = sessionKey()
  const existing = await supervisorState(stateDir, session)
  if (existing.state === 'live') {
    console.log(`[pipeline] another supervisor is live (pid ${existing.info.pid}, session ${session})`)
    process.exit(EXIT_DUPLICATE)
  }
  if (existing.state === 'stale') {
    console.log(`[pipeline] reclaiming stale pid file (pid ${existing.info.pid})`)
    clearPid(stateDir, session)
  }

  await writePid(stateDir, {
    pid: process.pid,
    pane_pid: process.ppid,
    started_at_ms: (await processStartedAtMs(process.pid)) ?? Date.now(),
    session,
    socket_path: process.env.HERDR_SOCKET_PATH ?? '',
    pane_id: process.env.HERDR_PANE_ID ?? '',
  })

  const config = await loadConfig(configDir)
  const herdr = new Herdr()
  const queueDir = join(stateDir, 'queue')

  console.log(`[pipeline] supervisor up — session ${session}, tick ${config.TICK_MS}ms`)

  const shutdown = () => { clearPid(stateDir, session); process.exit(0) }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  for (;;) {
    try {
      const events = await drain(queueDir)
      const runs = await listRuns(stateDir, session)
      const panes = await allOrchestratorPanes(stateDir, session)

      const { changed } = applyEvents(runs, events, session, panes)

      // Ledger first, delivery second: a crash here replays harmlessly through dedup.
      if (changed) for (const run of runs) await saveRun(stateDir, run)

      for (const run of pickOneAdvance(runs)) {
        void run // Task 26 wires evaluation, badges, and delivery onto this loop.
      }
    } catch (error) {
      console.error('[pipeline] tick error:', error)
    }
    await Bun.sleep(config.TICK_MS)
  }
}

await main()
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/pidfile.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 6: Verify the duplicate guard exits 3**

Run:
```bash
HERDR_PLUGIN_STATE_DIR=/tmp/sup-test HERDR_PLUGIN_CONFIG_DIR=/tmp/sup-test \
  bun run src/supervisor/main.ts & sleep 2
HERDR_PLUGIN_STATE_DIR=/tmp/sup-test HERDR_PLUGIN_CONFIG_DIR=/tmp/sup-test \
  bun run src/supervisor/main.ts; echo "exit=$?"
kill %1
```
Expected: the second prints `another supervisor is live` and `exit=3`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pidfile.ts src/supervisor/main.ts test/pidfile.test.ts
git commit -m "feat: supervisor loop with start-time-verified singleton guard"
```

---

## Task 21: Startup reconciliation

**Files:**
- Create: `src/startup.ts`, `test/startup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/startup.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Herdr } from '../src/lib/herdr'
import { ensureWorkspace, linkHpipe, reapGhostPanes } from '../src/startup'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'startup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('creates the pipeline workspace when none exists', async () => {
  const bin = await makeFakeBin(dir, {
    'workspace list': { result: { workspaces: [] } },
    'workspace create': { result: { workspace: { workspace_id: 'w3', label: 'pipeline' } } },
  })
  expect(await ensureWorkspace(new Herdr(bin), dir, 'personal', 'pipeline')).toBe('w3')
})

test('reuses a recorded workspace id over a label match', async () => {
  await Bun.write(join(dir, 'workspace.personal.id'), 'w5')
  const bin = await makeFakeBin(dir, {
    'workspace list': { result: { workspaces: [
      { workspace_id: 'w5', label: 'renamed' },
      { workspace_id: 'w8', label: 'pipeline' },
    ] } },
  })
  expect(await ensureWorkspace(new Herdr(bin), dir, 'personal', 'pipeline')).toBe('w5')
})

test('closes a ghost supervisor pane whose shell_pid is not the live pane_pid', async () => {
  const bin = await makeFakeBin(dir, {
    'pane list': { result: { panes: [
      { pane_id: 'w3:p1', label: 'Pipeline supervisor' },
      { pane_id: 'w3:p2', label: 'Pipeline supervisor' },
    ] } },
    'pane process-info --pane w3:p1': { result: { process_info: { shell_pid: 111 } } },
    'pane process-info --pane w3:p2': { result: { process_info: { shell_pid: 222 } } },
    'pane close': { result: {} },
  })
  const closed = await reapGhostPanes(new Herdr(bin), 'w3', 222)
  expect(closed).toEqual(['w3:p1'])
})

test('linkHpipe creates the symlink and replaces a stale one', async () => {
  const target = join(dir, 'cli.ts')
  await Bun.write(target, '#!/usr/bin/env bun\n')
  const link = join(dir, 'bin', 'hpipe')

  await linkHpipe(target, link)
  expect(existsSync(link)).toBe(true)

  rmSync(link)
  symlinkSync(join(dir, 'gone.ts'), link)
  await linkHpipe(target, link)
  expect(await Bun.file(link).text()).toContain('#!/usr/bin/env bun')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/startup.test.ts`
Expected: FAIL — cannot resolve `../src/startup`.

- [ ] **Step 3: Implement**

```ts
// src/startup.ts
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from './lib/config'
import { Herdr } from './lib/herdr'
import { readPid } from './lib/pidfile'
import { gcStaleTmp } from './lib/queue'
import { sessionKey } from './lib/session'
import { readJson, writeJson } from './lib/store'

const SUPERVISOR_LABEL = 'Pipeline supervisor'
const ONE_HOUR_MS = 60 * 60 * 1000

const workspaceIdPath = (stateDir: string, session: string) =>
  join(stateDir, `workspace.${session}.id`)

export async function ensureWorkspace(
  herdr: Herdr, stateDir: string, session: string, label: string,
): Promise<string | null> {
  const workspaces = await herdr.workspaceList()

  const recorded = (await Bun.file(workspaceIdPath(stateDir, session)).exists())
    ? (await Bun.file(workspaceIdPath(stateDir, session)).text()).trim()
    : null
  if (recorded && workspaces.some((w) => w.workspace_id === recorded)) return recorded

  // Labels are not unique — herdr enforces nothing and the user can rename any workspace.
  const matching = workspaces.filter((w) => w.label === label)
  if (matching.length === 1 && matching[0]) {
    await Bun.write(workspaceIdPath(stateDir, session), matching[0].workspace_id)
    return matching[0].workspace_id
  }
  if (matching.length > 1) {
    console.error(`[pipeline] ${matching.length} workspaces labelled "${label}" — reporting ambiguity`)
  }

  const created = await herdr.workspaceCreate(label)
  const id = created.result?.workspace.workspace_id
  if (!id) {
    console.error(`[pipeline] could not create workspace: ${created.code ?? 'unknown'}`)
    return null
  }
  await Bun.write(workspaceIdPath(stateDir, session), id)
  return id
}

export async function reapGhostPanes(
  herdr: Herdr, workspaceId: string, livePanePid: number | null,
): Promise<string[]> {
  const panes = await herdr.paneList(workspaceId)
  const closed: string[] = []

  for (const pane of panes) {
    if (pane.label !== SUPERVISOR_LABEL) continue

    const shellPid = await herdr.paneShellPid(pane.pane_id)
    // undefined means the pid lookup failed. Closing a pane we cannot identify
    // risks killing the live supervisor, so uncertainty means leave it alone.
    if (shellPid === undefined) continue
    if (livePanePid !== null && shellPid === livePanePid) continue

    await herdr.paneClose(pane.pane_id)
    closed.push(pane.pane_id)
  }

  return closed
}

export async function linkHpipe(target: string, linkPath: string): Promise<void> {
  mkdirSync(dirname(linkPath), { recursive: true })
  chmodSync(target, 0o755)
  try {
    lstatSync(linkPath)
    unlinkSync(linkPath)
  } catch {
    // Nothing there yet.
  }
  symlinkSync(target, linkPath)
}

async function main(): Promise<void> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
  const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? process.cwd()
  const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
  if (!stateDir || !configDir) process.exit(0)

  const session = sessionKey()
  const config = await loadConfig(configDir)
  const herdr = new Herdr()

  await gcStaleTmp(join(stateDir, 'queue'), ONE_HOUR_MS)

  if (config.HPIPE_LINK) {
    await linkHpipe(join(pluginRoot, 'src', 'cli.ts'), config.HPIPE_LINK_PATH)
  }

  const workspaceId = await ensureWorkspace(herdr, stateDir, session, config.PIPELINE_WORKSPACE_LABEL)
  if (!workspaceId) return

  const live = await readPid(stateDir, session)
  const ghosts = await reapGhostPanes(herdr, workspaceId, live?.pane_pid ?? null)
  if (ghosts.length > 0) console.log(`[pipeline] closed ghost panes: ${ghosts.join(', ')}`)

  const opened = await herdr.pluginPaneOpen(pluginId, 'supervisor', workspaceId)
  if (!opened.ok) {
    // herdr reports this in the body while exiting 0 — checking the exit code would miss it.
    console.error(`[pipeline] could not open supervisor pane: ${opened.code} ${opened.message}`)
  }
}

if (import.meta.main) await main()
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/startup.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Run the whole suite**

Run: `bun test && bun run typecheck`
Expected: all green. **This closes Milestone 2.**

- [ ] **Step 6: Commit**

```bash
git add src/startup.ts test/startup.test.ts
git commit -m "feat: startup reconciliation of workspace, ghost panes, and hpipe link"
```

---

# Milestone 3 — Integration

## Task 22: `gh` wrapper

Two field-name traps verified against gh 2.96.0: `gh pr checks --json` has **no `conclusion`** (use
`bucket`), and `gh pr view --json` has **no `merged`** (use `state` / `mergedAt`). Exit code 8 from
`pr checks` means *pending*, not failure.

**Files:**
- Create: `src/lib/gh.ts`, `test/gh.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/gh.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFakeBin } from './helpers/fake-bin'
import { Gh, rollUpBucket } from '../src/lib/gh'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gh-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('any fail makes the roll-up fail', () => {
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'fail' }, { bucket: 'pending' }])).toBe('fail')
})

test('any pending with no fail makes the roll-up pending', () => {
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'pending' }])).toBe('pending')
})

test('all pass makes the roll-up pass, and skipping does not block it', () => {
  expect(rollUpBucket([{ bucket: 'pass' }, { bucket: 'skipping' }])).toBe('pass')
})

test('an empty check list is pending, never pass', () => {
  expect(rollUpBucket([])).toBe('pending')
})

test('exit code 8 is read as pending rather than an error', async () => {
  const bin = await makeFakeBin(dir, { 'pr checks': [{ bucket: 'pending', name: 'ci' }] }, { 'pr checks': 8 })
  expect(await new Gh(bin, '/r').prChecks(5)).toBe('pending')
})

test('a gh failure maps to unknown, which is not terminal', async () => {
  const bin = await makeFakeBin(dir, { 'pr checks': { message: 'gh auth required' } }, { 'pr checks': 1 })
  expect(await new Gh(bin, '/r').prChecks(5)).toBe('unknown')
})

test('prView reads merged from state and mergedAt, not a merged field', async () => {
  const bin = await makeFakeBin(dir, {
    'pr view': { state: 'MERGED', mergedAt: '2026-09-13T10:00:00Z', headRefOid: 'abc123' },
  })
  const view = await new Gh(bin, '/r').prView(5)
  expect(view).toEqual({ merged: true, mergedAtMs: Date.parse('2026-09-13T10:00:00Z'), headSha: 'abc123' })
})

test('an open PR is not merged and has no mergedAt', async () => {
  const bin = await makeFakeBin(dir, { 'pr view': { state: 'OPEN', mergedAt: null, headRefOid: 'abc' } })
  expect(await new Gh(bin, '/r').prView(5)).toMatchObject({ merged: false, mergedAtMs: null })
})

test('issueView reads closed and closedAt', async () => {
  const bin = await makeFakeBin(dir, { 'issue view': { closed: true, closedAt: '2026-09-13T11:00:00Z' } })
  expect(await new Gh(bin, '/r').issueView(210))
    .toEqual({ closed: true, closedAtMs: Date.parse('2026-09-13T11:00:00Z') })
})

test('prForBranch returns the first PR number or null', async () => {
  const bin = await makeFakeBin(dir, { 'pr list': [{ number: 412 }] })
  expect(await new Gh(bin, '/r').prForBranch('feat/x')).toBe(412)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/gh.test.ts`
Expected: FAIL — cannot resolve `../src/lib/gh`.

- [ ] **Step 3: Implement**

```ts
// src/lib/gh.ts
import type { CiBucket } from './types'

export interface CheckRow { bucket: string }

export interface PrView {
  merged: boolean
  mergedAtMs: number | null
  headSha: string | null
}

export interface IssueView {
  closed: boolean
  closedAtMs: number | null
}

export function rollUpBucket(rows: CheckRow[]): CiBucket {
  if (rows.length === 0) return 'pending'
  if (rows.some((r) => r.bucket === 'fail')) return 'fail'
  if (rows.some((r) => r.bucket === 'cancel')) return 'fail'
  if (rows.some((r) => r.bucket === 'pending')) return 'pending'
  return 'pass'
}

export class Gh {
  constructor(
    private readonly bin: string = process.env.GH_BIN ?? 'gh',
    private readonly cwd: string = process.cwd(),
  ) {}

  private async run(args: string[]): Promise<{ code: number; text: string }> {
    const proc = Bun.spawn([this.bin, ...args], { cwd: this.cwd, stdout: 'pipe', stderr: 'pipe' })
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    return { code, text }
  }

  private async json<T>(args: string[], okCodes: number[] = [0]): Promise<T | null> {
    const { code, text } = await this.run(args)
    if (!okCodes.includes(code)) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  async prForBranch(branch: string): Promise<number | null> {
    const rows = await this.json<{ number: number }[]>(
      ['pr', 'list', '--head', branch, '--json', 'number', '--limit', '1'],
    )
    return rows?.[0]?.number ?? null
  }

  /** Exit 8 means "checks pending" — a normal state, not an error. */
  async prChecks(pr: number): Promise<CiBucket> {
    const rows = await this.json<CheckRow[]>(
      ['pr', 'checks', String(pr), '--json', 'bucket,name,state,link'],
      [0, 8],
    )
    if (rows === null) return 'unknown'
    return rollUpBucket(rows)
  }

  async prChecksDetail(pr: number): Promise<string> {
    const rows = await this.json<{ bucket: string; name: string; link?: string }[]>(
      ['pr', 'checks', String(pr), '--json', 'bucket,name,state,link'],
      [0, 8],
    )
    return (rows ?? [])
      .filter((r) => r.bucket === 'fail' || r.bucket === 'cancel')
      .map((r) => `- ${r.name} (${r.bucket})${r.link ? ` ${r.link}` : ''}`)
      .join('\n')
  }

  async prView(pr: number): Promise<PrView | null> {
    const view = await this.json<{ state: string; mergedAt: string | null; headRefOid: string | null }>(
      ['pr', 'view', String(pr), '--json', 'state,mergedAt,headRefOid'],
    )
    if (!view) return null
    return {
      merged: view.state === 'MERGED',
      mergedAtMs: view.mergedAt ? Date.parse(view.mergedAt) : null,
      headSha: view.headRefOid,
    }
  }

  async issueView(issue: number): Promise<IssueView | null> {
    const view = await this.json<{ closed: boolean; closedAt: string | null }>(
      ['issue', 'view', String(issue), '--json', 'closed,closedAt'],
    )
    if (!view) return null
    return { closed: view.closed, closedAtMs: view.closedAt ? Date.parse(view.closedAt) : null }
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/gh.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Verify the field names against the real gh**

Run:
```bash
gh pr checks --help | grep -A2 'JSON FIELDS'
gh pr view --json merged 2>&1 | head -1
```
Expected: the checks field list contains `bucket` and no `conclusion`; `pr view --json merged`
prints `Unknown JSON field: "merged"`. If either differs, this task's assumptions changed — stop and
re-verify before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gh.ts test/gh.test.ts
git commit -m "feat: gh wrapper with bucket roll-up and exit-8 pending handling"
```

---

## Task 23: CI polling

**Files:**
- Create: `src/supervisor/ci.ts`, `test/ci.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/ci.test.ts
import { expect, test } from 'bun:test'
import { ciTransitions } from '../src/supervisor/ci'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'ci', pass: 1, phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: 5, ci: null, ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

test('records a bucket change and reports it', async () => {
  const run = mkRun([mkTask({ ci: null })])
  const changes = await ciTransitions([run], async () => 'pass')
  expect(run.tasks[0]?.ci).toBe('pass')
  expect(changes).toHaveLength(1)
})

test('an unchanged bucket is not a transition', async () => {
  const run = mkRun([mkTask({ ci: 'pending' })])
  expect(await ciTransitions([run], async () => 'pending')).toHaveLength(0)
})

test('unknown never overwrites a known bucket', async () => {
  const run = mkRun([mkTask({ ci: 'pass' })])
  await ciTransitions([run], async () => 'unknown')
  expect(run.tasks[0]?.ci).toBe('pass')
})

test('only tasks in the ci phase with a PR are polled', async () => {
  const run = mkRun([mkTask({ phase: 'execute' }), mkTask({ task_id: 't2', pr: null })])
  let polls = 0
  await ciTransitions([run], async () => { polls++; return 'pass' })
  expect(polls).toBe(0)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/ci.test.ts`
Expected: FAIL — cannot resolve `../src/supervisor/ci`.

- [ ] **Step 3: Implement**

```ts
// src/supervisor/ci.ts
import type { CiBucket, Run, Task } from '../lib/types'

export interface CiChange { run: Run; task: Task; bucket: CiBucket }

export async function ciTransitions(
  runs: Run[], poll: (pr: number, repoRoot: string) => Promise<CiBucket>,
): Promise<CiChange[]> {
  const changes: CiChange[] = []

  for (const run of runs) {
    for (const task of run.tasks) {
      if (task.phase !== 'ci' || task.pr === null) continue

      const bucket = await poll(task.pr, run.repo_root)
      // A gh failure must not look like a verdict.
      if (bucket === 'unknown') continue
      if (bucket === task.ci) continue

      task.ci = bucket
      changes.push({ run, task, bucket })
    }
  }

  return changes
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/ci.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/ci.ts test/ci.test.ts
git commit -m "feat: CI polling that emits only on bucket change"
```

---

## Task 24: Teardown

Unattended, and the only unattended destructive action in the plugin — so it runs **only** after
`gh issue view` confirms closure, and never for a `--keep-worktree` task.

**Files:**
- Create: `src/supervisor/teardown.ts`, `test/teardown.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/teardown.test.ts
import { expect, test } from 'bun:test'
import { runTeardown } from '../src/supervisor/teardown'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'teardown', pass: 1, phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: 5, ci: 'pass', ...over,
})

function mkRun(tasks: Task[]): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = 'execute'
  run.tasks = tasks
  return run
}

test('removes the worktree and marks the task done', async () => {
  const run = mkRun([mkTask({})])
  const removed: string[] = []
  await runTeardown([run], async (ws) => { removed.push(ws); return true })
  expect(removed).toEqual(['w7'])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('keep_worktree skips removal but still completes the task', async () => {
  const run = mkRun([mkTask({ keep_worktree: true })])
  const removed: string[] = []
  await runTeardown([run], async (ws) => { removed.push(ws); return true })
  expect(removed).toEqual([])
  expect(run.tasks[0]?.phase).toBe('done')
})

test('a failed removal marks the task orphaned rather than done', async () => {
  const run = mkRun([mkTask({})])
  await runTeardown([run], async () => false)
  expect(run.tasks[0]?.phase).toBe('orphaned')
})

test('is idempotent — an already-done task is not torn down twice', async () => {
  const run = mkRun([mkTask({ phase: 'done' })])
  let calls = 0
  await runTeardown([run], async () => { calls++; return true })
  expect(calls).toBe(0)
})

test('the last task done moves the run to branch-review', async () => {
  const run = mkRun([mkTask({ task_id: 't1', phase: 'done' }), mkTask({ task_id: 't2' })])
  await runTeardown([run], async () => true)
  expect(run.phase).toBe('branch-review')
})

test('a still-running sibling keeps the run in execute', async () => {
  const run = mkRun([mkTask({ task_id: 't1', phase: 'execute' }), mkTask({ task_id: 't2' })])
  await runTeardown([run], async () => true)
  expect(run.phase).toBe('execute')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/teardown.test.ts`
Expected: FAIL — cannot resolve `../src/supervisor/teardown`.

- [ ] **Step 3: Implement**

```ts
// src/supervisor/teardown.ts
import { enterRunPhase, enterTaskPhase } from '../lib/machine'
import type { Run, Task, TaskPhase } from '../lib/types'

const SETTLED: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  'done', 'failed', 'orphaned', 'blocked-on-failure', 'escalated',
])

export async function runTeardown(
  runs: Run[], removeWorktree: (workspaceId: string) => Promise<boolean>,
): Promise<Task[]> {
  const completed: Task[] = []

  for (const run of runs) {
    for (const task of run.tasks) {
      // Idempotent: teardown emits worktree.removed, which is one of our own hooks.
      if (task.phase !== 'teardown') continue

      if (task.keep_worktree || task.workspace_id === null) {
        enterTaskPhase(run, task, 'done', 'worktree kept by request')
        completed.push(task)
        continue
      }

      const removed = await removeWorktree(task.workspace_id)
      enterTaskPhase(run, task, removed ? 'done' : 'orphaned',
        removed ? 'worktree removed' : 'worktree removal failed')
      completed.push(task)
    }

    if (run.phase === 'execute' && run.tasks.length > 0 && run.tasks.every((t) => SETTLED.has(t.phase))) {
      enterRunPhase(run, 'branch-review', 'all tasks settled')
    }
  }

  return completed
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/teardown.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/supervisor/teardown.ts test/teardown.test.ts
git commit -m "feat: teardown gated on confirmed issue closure, idempotent"
```

---

## Task 25: Actions and the `hpipe` argv dispatcher

**Files:**
- Create: `src/lib/status.ts`, `src/actions/status.ts`, `src/actions/claim.ts`, `src/actions/drain.ts`, `src/actions/supervisor.ts`
- Modify: `src/cli.ts` (append the dispatcher)
- Create: `test/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/status.test.ts
import { expect, test } from 'bun:test'
import { formatStatus } from '../src/lib/status'
import { newRun } from '../src/lib/ledger'
import type { Run } from '../src/lib/types'

const mkRun = (): Run =>
  newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'chat meter' })

test('names all four supervisor states', () => {
  for (const state of ['live', 'stale', 'none', 'other-session'] as const) {
    expect(formatStatus([], { state }, 'personal')).toContain(state)
  }
})

test('lists a run with its phase', () => {
  expect(formatStatus([mkRun()], { state: 'live' }, 'personal')).toContain('spec')
})

test('says so plainly when there are no runs', () => {
  expect(formatStatus([], { state: 'live' }, 'personal')).toContain('no active runs')
})

test('warns when the supervisor is not live, because nothing advances then', () => {
  expect(formatStatus([mkRun()], { state: 'none' }, 'personal')).toContain('nothing will advance')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/status.test.ts`
Expected: FAIL — cannot resolve `../src/lib/status`.

- [ ] **Step 3: Implement the formatter**

```ts
// src/lib/status.ts
import type { Run, SessionKey } from './types'

export interface StatusSupervisor {
  state: 'live' | 'stale' | 'none' | 'other-session'
  pid?: number
}

export function formatStatus(
  runs: Run[], supervisor: StatusSupervisor, session: SessionKey,
): string {
  const lines: string[] = []
  lines.push(`session: ${session}`)
  lines.push(
    `supervisor: ${supervisor.state}${supervisor.pid ? ` (pid ${supervisor.pid})` : ''}`,
  )
  if (supervisor.state !== 'live') {
    lines.push('  → nothing will advance until a supervisor is running:')
    lines.push('    herdr plugin action invoke stein.pipeline.supervisor')
  }

  if (runs.length === 0) {
    lines.push('no active runs')
    return lines.join('\n')
  }

  for (const run of runs) {
    lines.push('')
    lines.push(`${run.run_id}  [${run.phase}] pass ${run.pass}  ${run.title}`)
    if (run.orchestrator_pane) lines.push(`  orchestrator: ${run.orchestrator_pane}`)
    for (const task of run.tasks) {
      const bits = [
        `  ${task.task_id}`,
        task.branch,
        `#${task.issue}`,
        `[${task.phase}]`,
        task.agent_status,
      ]
      if (task.pr !== null) bits.push(`PR #${task.pr}`)
      if (task.ci !== null) bits.push(`ci:${task.ci}`)
      lines.push(bits.join(' '))
    }
  }

  return lines.join('\n')
}
```

- [ ] **Step 4: Implement the four actions**

```ts
// src/actions/status.ts
import { listRuns } from '../lib/ledger'
import { supervisorState } from '../lib/pidfile'
import { sessionKey } from '../lib/session'
import { formatStatus } from '../lib/status'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
if (!stateDir) process.exit(0)

const session = sessionKey()
const state = await supervisorState(stateDir, session)
console.log(formatStatus(
  await listRuns(stateDir, session),
  { state: state.state === 'live' ? 'live' : state.state, pid: 'info' in state ? state.info.pid : undefined },
  session,
))
```

```ts
// src/actions/claim.ts
import { Herdr } from '../lib/herdr'
import { writeOrchestrator } from '../lib/ledger'
import { sessionKey } from '../lib/session'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const paneId = process.env.HERDR_PANE_ID
const workspaceId = process.env.HERDR_WORKSPACE_ID
if (!stateDir || !paneId || !workspaceId) {
  console.error('[pipeline] claim must be invoked from inside a pane')
  process.exit(1)
}

const herdr = new Herdr()
const workspaces = await herdr.workspaceList()
const repoKey = workspaces.find((w) => w.workspace_id === workspaceId)?.worktree?.repo_key
if (!repoKey) {
  console.error('[pipeline] this workspace has no repo provenance — open it as a repo workspace first')
  process.exit(1)
}

await writeOrchestrator(stateDir, sessionKey(), repoKey, {
  pane_id: paneId,
  workspace_id: workspaceId,
  socket_path: process.env.HERDR_SOCKET_PATH ?? '',
  claimed_at: Date.now(),
})
console.log(`[pipeline] claimed ${paneId} as orchestrator for ${repoKey}`)
```

```ts
// src/actions/drain.ts
import { join } from 'node:path'
import { drain } from '../lib/queue'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
if (!stateDir) process.exit(0)

const events = await drain(join(stateDir, 'queue'))
if (events.length === 0) console.log('[pipeline] queue empty')
else console.log(JSON.stringify(events, null, 2))
```

```ts
// src/actions/supervisor.ts
import { Herdr } from '../lib/herdr'
import { loadConfig } from '../lib/config'
import { sessionKey } from '../lib/session'
import { ensureWorkspace } from '../startup'

const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
const configDir = process.env.HERDR_PLUGIN_CONFIG_DIR
const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'
if (!stateDir || !configDir) process.exit(0)

const config = await loadConfig(configDir)
const herdr = new Herdr()
const workspaceId = await ensureWorkspace(herdr, stateDir, sessionKey(), config.PIPELINE_WORKSPACE_LABEL)
if (!workspaceId) {
  console.error('[pipeline] could not resolve the pipeline workspace')
  process.exit(1)
}

const opened = await herdr.pluginPaneOpen(pluginId, 'supervisor', workspaceId)
console.log(opened.ok ? '[pipeline] supervisor pane opened' : `[pipeline] ${opened.code}: ${opened.message}`)
```

- [ ] **Step 5: Append the argv dispatcher to `src/cli.ts`**

```ts
// ——— argv dispatcher ———

function flag(argv: string[], name: string): string | null {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? null : (argv[i + 1] ?? null)
}

function listFlag(argv: string[], name: string): string[] {
  const raw = flag(argv, name)
  return raw ? raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : []
}

async function repoContext(): Promise<{ repoKey: string; repoRoot: string } | null> {
  const proc = Bun.spawn(['git', 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'ignore' })
  const root = (await new Response(proc.stdout).text()).trim()
  await proc.exited
  if (root.length === 0) return null
  return { repoKey: root, repoRoot: root }
}

async function dispatch(argv: string[]): Promise<number> {
  const stateDir = process.env.HERDR_PLUGIN_STATE_DIR
    ?? join(process.env.HOME ?? '', '.local/state/herdr/plugins/stein.pipeline')
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, '..')
  const ctx: Ctx = { stateDir, pluginRoot, session: sessionKey() }
  const [command, ...rest] = argv

  const repo = await repoContext()
  if (!repo && command !== 'status') {
    console.error('hpipe: not inside a git repository')
    return 1
  }

  let out: CmdResult
  switch (command) {
    case 'start':
      out = await cmdStart(ctx, {
        title: rest.join(' ').trim(),
        repoKey: repo!.repoKey, repoRoot: repo!.repoRoot,
        socketPath: process.env.HERDR_SOCKET_PATH ?? '',
        paneId: process.env.HERDR_PANE_ID ?? '',
        workspaceId: process.env.HERDR_WORKSPACE_ID ?? '',
      })
      break

    case 'task':
      out = await cmdTask(ctx, {
        branch: flag(rest, 'branch') ?? '',
        issue: Number(flag(rest, 'issue') ?? '0'),
        surface: flag(rest, 'surface') ?? '',
        text: flag(rest, 'text') ?? '',
        dependsOn: listFlag(rest, 'depends-on'),
        files: listFlag(rest, 'files'),
        keepWorktree: rest.includes('--keep-worktree'),
      })
      break

    case 'rewind':
      out = await cmdRewind(ctx, {
        runId: rest[0] ?? '', phase: rest[1] ?? '', taskId: flag(rest, 'task'),
      })
      break

    default:
      console.error('usage: hpipe <start|task|status|drain|rewind|resume|abort|forget> …')
      return 1
  }

  console.log(out.text)
  return out.ok ? 0 : 1
}

if (import.meta.main) process.exit(await dispatch(process.argv.slice(2)))
```

Add the import the dispatcher needs at the top of `src/cli.ts`:

```ts
import { sessionKey } from './lib/session'
```

- [ ] **Step 6: Run the tests**

Run: `bun test test/status.test.ts && bun test`
Expected: all green.

- [ ] **Step 7: Verify the CLI is executable and self-describing**

Run: `chmod +x src/cli.ts && ./src/cli.ts`
Expected: the usage line. The shebang plus mode `0755` matter — the startup hook symlinks this file
onto `PATH`, and a symlink to a non-executable file is not runnable.

- [ ] **Step 8: Commit**

```bash
git add src/lib/status.ts src/actions src/cli.ts test/status.test.ts
git commit -m "feat: status formatter, four plugin actions, and the hpipe dispatcher"
```

---

## Task 26: Delivery — evaluate, render the digest, prompt, retry, badge

This closes the stub left in `src/supervisor/main.ts`. It is the piece that makes the plugin do
anything: predicates are evaluated, one phase advances per orchestrator, the digest renders, and
`herdr agent prompt` delivers with retry across ticks.

**Files:**
- Create: `src/supervisor/deliver.ts`, `test/deliver.test.ts`
- Modify: `src/supervisor/main.ts` (replace the `void run` stub)

- [ ] **Step 1: Write the failing test**

```ts
// test/deliver.test.ts
import { expect, test } from 'bun:test'
import { buildDigest, nextDelivery, shouldRetry } from '../src/supervisor/deliver'
import { newRun } from '../src/lib/ledger'
import type { Run, Task } from '../src/lib/types'

const mkTask = (over: Partial<Task>): Task => ({
  task_id: 't1', branch: 'feat/x', issue: 1, surface: 'core',
  depends_on: [], files: [], keep_worktree: false, text: '',
  workspace_id: 'w7', pane_id: 'w7:p1', agent_status: 'idle',
  phase: 'execute', pass: 1, phase_entered_at: 0, escalated_from: null,
  head_sha_at_entry: null, pr: null, ci: null, ...over,
})

function mkRun(): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.orchestrator_pane = 'w1:p1'
  return run
}

test('the digest carries the run id, the event lines, and the next prompt', () => {
  const text = buildDigest({
    run: mkRun(),
    eventLines: ['- feat/x (#1, t1) done, PR #412 open'],
    phaseNote: ' → task-review-spec',
    nextPrompt: 'REVIEW THIS',
  })
  expect(text).toContain('[pipeline] run')
  expect(text).toContain('1 events')
  expect(text).toContain('feat/x (#1, t1) done')
  expect(text).toContain('REVIEW THIS')
})

test('a digest with no phase change still delivers the events', () => {
  const text = buildDigest({
    run: mkRun(), eventLines: ['- feat/x (#1, t1) blocked'], phaseNote: '', nextPrompt: '',
  })
  expect(text).toContain('blocked')
})

test('nextDelivery skips a run with no orchestrator pane', () => {
  const run = mkRun()
  run.orchestrator_pane = null
  expect(nextDelivery([{ run, eventLines: ['x'], phaseNote: '', nextPrompt: '' }])).toBeNull()
})

test('nextDelivery returns the first deliverable payload', () => {
  const run = mkRun()
  const picked = nextDelivery([{ run, eventLines: ['x'], phaseNote: '', nextPrompt: '' }])
  expect(picked?.paneId).toBe('w1:p1')
})

test('agent_blocked is retryable below the cap', () => {
  expect(shouldRetry('agent_blocked', 1, 5)).toBe(true)
})

test('retries stop at the cap', () => {
  expect(shouldRetry('agent_blocked', 5, 5)).toBe(false)
})

test('an unknown pane is retryable — it may be restoring', () => {
  expect(shouldRetry('pane_not_found', 1, 5)).toBe(true)
})

test('a blocked worker line inlines its pane tail', () => {
  const run = mkRun()
  run.tasks.push(mkTask({ agent_status: 'blocked' }))
  const text = buildDigest({
    run,
    eventLines: ['- feat/x (#1, t1) blocked', '    "Do you want to proceed?"'],
    phaseNote: '', nextPrompt: '',
  })
  expect(text).toContain('Do you want to proceed?')
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/deliver.test.ts`
Expected: FAIL — cannot resolve `../src/supervisor/deliver`.

- [ ] **Step 3: Implement**

```ts
// src/supervisor/deliver.ts
import { join } from 'node:path'
import type { Gh } from '../lib/gh'
import type { Herdr } from '../lib/herdr'
import { ARTIFACT_RUN_PHASES, advanceRun, advanceTask } from '../lib/machine'
import { isFresh, isSettled, parseVerdict } from '../lib/predicates'
import { renderPrompt } from '../lib/render'
import { buildBadges, badgeSource } from '../lib/badges'
import type { Config } from '../lib/config'
import type { Run, Task } from '../lib/types'

export interface DigestInput {
  run: Run
  eventLines: string[]
  phaseNote: string
  nextPrompt: string
}

export interface Delivery { paneId: string; text: string; run: Run }

export function buildDigest(input: DigestInput): string {
  return [
    `[pipeline] run ${input.run.run_id}${input.phaseNote}`,
    '',
    `${input.eventLines.length} events:`,
    ...input.eventLines,
    '',
    input.nextPrompt,
  ].join('\n').trimEnd()
}

export function nextDelivery(inputs: DigestInput[]): Delivery | null {
  for (const input of inputs) {
    if (!input.run.orchestrator_pane) continue
    if (input.eventLines.length === 0 && input.nextPrompt.length === 0) continue
    return { paneId: input.run.orchestrator_pane, text: buildDigest(input), run: input.run }
  }
  return null
}

const RETRYABLE = new Set(['agent_blocked', 'pane_not_found', 'not_found', 'unparseable'])

export function shouldRetry(code: string | undefined, attempts: number, max: number): boolean {
  if (attempts >= max) return false
  return code !== undefined && RETRYABLE.has(code)
}

/** Artifact path for the phase the run or task is currently in. */
export function artifactPathFor(run: Run, task: Task | null): string | null {
  if (task) {
    const key = `${task.task_id}-${task.phase}-${task.pass}`
    return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', `${key}.md`)
  }
  if (run.phase === 'spec') return run.artifacts.spec
  if (run.phase === 'plan') return run.artifacts.plan
  const key = `${run.phase}-${run.pass}`
  return run.artifacts.verdicts[key] ?? join('docs/superpowers/reviews', `${run.run_id}-${key}.md`)
}

/**
 * Evaluates one run. The actor must read idle both now and again after
 * ACTOR_SETTLE_MS — a momentary screen-detection misclassification will have
 * flipped back to working or blocked by then.
 */
export async function evaluateRun(
  run: Run, herdr: Herdr, gh: Gh, config: Config,
): Promise<{ advanced: boolean; nextPrompt: string; phaseNote: string }> {
  const pane = run.orchestrator_pane
  if (!pane) return { advanced: false, nextPrompt: '', phaseNote: '' }

  if (!ARTIFACT_RUN_PHASES.has(run.phase)) return { advanced: false, nextPrompt: '', phaseNote: '' }

  if ((await herdr.agentStatus(pane)) !== 'idle') {
    return { advanced: false, nextPrompt: '', phaseNote: '' }
  }

  const relative = artifactPathFor(run, null)
  if (!relative) return { advanced: false, nextPrompt: '', phaseNote: '' }
  const absolute = join(run.repo_root, relative)

  const fresh = await isFresh(absolute, run.phase_entered_at)
  if (!fresh) return { advanced: false, nextPrompt: '', phaseNote: '' }
  if (!(await isSettled(absolute, config.FILE_SETTLE_MS))) {
    return { advanced: false, nextPrompt: '', phaseNote: '' }
  }
  if ((await herdr.agentStatus(pane)) !== 'idle') {
    return { advanced: false, nextPrompt: '', phaseNote: '' }
  }

  const verdict = await parseVerdict(absolute)
  const before = run.phase
  const advanced = advanceRun(run, {
    actorIdle: true, artifactFresh: true, verdict, maxPasses: config.MAX_PASSES,
  })
  if (!advanced) return { advanced: false, nextPrompt: '', phaseNote: '' }

  const nextPrompt = await promptForRunPhase(run, config)
  return { advanced: true, nextPrompt, phaseNote: ` → ${run.phase} (from ${before})` }
}

async function promptForRunPhase(run: Run, config: Config): Promise<string> {
  const pluginRoot = process.env.HERDR_PLUGIN_ROOT ?? process.cwd()
  const specPath = join(run.repo_root, run.artifacts.spec ?? 'docs/superpowers/specs/design.md')
  const planPath = join(run.repo_root, run.artifacts.plan ?? 'docs/superpowers/plans/plan.md')
  const verdictPath = join(run.repo_root, artifactPathFor(run, null) ?? 'review.md')

  const common = {
    run_id: run.run_id, title: run.title, pass: String(run.pass),
    spec_path: specPath, plan_path: planPath, verdict_path: verdictPath,
  }

  switch (run.phase) {
    case 'spec': return renderPrompt(pluginRoot, 'spec', common)
    case 'spec-review': return renderPrompt(pluginRoot, 'spec-review', common)
    case 'plan': return renderPrompt(pluginRoot, 'plan', common)
    case 'plan-review': return renderPrompt(pluginRoot, 'plan-review', common)
    case 'dispatch': return renderPrompt(pluginRoot, 'dispatch', common)
    case 'branch-review': return renderPrompt(pluginRoot, 'branch-review', common)
    case 'escalated':
      return renderPrompt(pluginRoot, 'escalate', {
        run_id: run.run_id, phase: run.escalated_from ?? run.phase,
        pass: String(run.pass), task_flag: '',
      })
    default: return ''
  }
}

export async function refreshBadges(run: Run, herdr: Herdr, pluginId: string): Promise<void> {
  for (const task of run.tasks) {
    if (!task.workspace_id) continue
    await herdr.workspaceReportTokens(
      task.workspace_id,
      badgeSource(pluginId),
      buildBadges({ agent_status: task.agent_status, branch: task.branch, phase: task.phase }),
    )
  }
}
```

- [ ] **Step 4: Wire it into the loop**

In `src/supervisor/main.ts`, replace the stub block:

```ts
      for (const run of pickOneAdvance(runs)) {
        void run // Task 26 wires evaluation, badges, and delivery onto this loop.
      }
```

with:

```ts
      const digests: DigestInput[] = []
      for (const run of pickOneAdvance(runs)) {
        const { nextPrompt, phaseNote } = await evaluateRun(run, herdr, gh, config)
        await refreshBadges(run, herdr, pluginId)
        const lines = wake.filter((w) => w.run.run_id === run.run_id).map((w) => `- ${w.text}`)
        if (lines.length > 0 || nextPrompt.length > 0) {
          digests.push({ run, eventLines: lines, phaseNote, nextPrompt })
        }
        await saveRun(stateDir, run)
      }

      const delivery = nextDelivery(digests)
      if (delivery) {
        const sent = await herdr.agentPrompt(delivery.paneId, delivery.text)
        if (!sent.ok) {
          attempts += 1
          if (!shouldRetry(sent.code, attempts, config.PROMPT_RETRY_MAX)) {
            console.error(`[pipeline] giving up on delivery: ${sent.code}`)
            attempts = 0
          }
        } else {
          attempts = 0
        }
      }
```

Capture `wake` from `applyEvents` (change `const { changed }` to `const { changed, wake }`), declare
`let attempts = 0` above the loop, construct `const gh = new Gh(config.GH_BIN)` and
`const pluginId = process.env.HERDR_PLUGIN_ID ?? 'stein.pipeline'` next to `herdr`, and add:

```ts
import { Gh } from '../lib/gh'
import { type DigestInput, evaluateRun, nextDelivery, refreshBadges, shouldRetry } from './deliver'
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/deliver.test.ts && bun run typecheck`
Expected: PASS, 8 tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/deliver.ts src/supervisor/main.ts test/deliver.test.ts
git commit -m "feat: evaluate, render, badge, and deliver with bounded retry"
```

---

## Task 27: Stall probe

Fires **only** for phases whose completion signal is a file. `dispatch`, `queued`, `execute`, `ci`,
`merge`, `close` and `teardown` have no artifact by design — probing them would interrupt the
orchestrator 15 minutes into every healthy run, in the phase where it is busiest.

**Files:**
- Create: `src/supervisor/stall.ts`, `test/stall.test.ts`
- Modify: `src/supervisor/main.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/stall.test.ts
import { expect, test } from 'bun:test'
import { stallCandidates } from '../src/supervisor/stall'
import { newRun } from '../src/lib/ledger'
import type { Run, RunPhase } from '../src/lib/types'

function runAt(phase: RunPhase, enteredAt: number): Run {
  const run = newRun({ session: 'p', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  run.phase = phase
  run.phase_entered_at = enteredAt
  run.orchestrator_pane = 'w1:p1'
  return run
}

const NOW = 1_000_000
const LONG_AGO = NOW - 30 * 60 * 1000

test('an artifact phase open past the threshold is a candidate', () => {
  expect(stallCandidates([runAt('spec', LONG_AGO)], NOW, 15, new Set())).toHaveLength(1)
})

test('execute is NEVER a stall candidate — it has no artifact by design', () => {
  expect(stallCandidates([runAt('execute', LONG_AGO)], NOW, 15, new Set())).toHaveLength(0)
})

test('dispatch is not a candidate either', () => {
  expect(stallCandidates([runAt('dispatch', LONG_AGO)], NOW, 15, new Set())).toHaveLength(0)
})

test('a phase within the threshold is not a candidate', () => {
  expect(stallCandidates([runAt('spec', NOW - 60_000)], NOW, 15, new Set())).toHaveLength(0)
})

test('a phase already probed is not probed again', () => {
  const run = runAt('spec', LONG_AGO)
  const probed = new Set([`${run.run_id}:spec:${run.phase_entered_at}`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(0)
})

test('re-entering the same phase makes it probeable again', () => {
  const run = runAt('spec', LONG_AGO)
  const probed = new Set([`${run.run_id}:spec:12345`])
  expect(stallCandidates([run], NOW, 15, probed)).toHaveLength(1)
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/stall.test.ts`
Expected: FAIL — cannot resolve `../src/supervisor/stall`.

- [ ] **Step 3: Implement**

```ts
// src/supervisor/stall.ts
import { ARTIFACT_RUN_PHASES } from '../lib/machine'
import type { Run } from '../lib/types'

export interface StallCandidate { run: Run; key: string; minutes: number }

export function stallKey(run: Run): string {
  return `${run.run_id}:${run.phase}:${run.phase_entered_at}`
}

export function stallCandidates(
  runs: Run[], now: number, thresholdMinutes: number, alreadyProbed: Set<string>,
): StallCandidate[] {
  const out: StallCandidate[] = []

  for (const run of runs) {
    if (!ARTIFACT_RUN_PHASES.has(run.phase)) continue
    if (!run.orchestrator_pane) continue

    const minutes = (now - run.phase_entered_at) / 60_000
    if (minutes < thresholdMinutes) continue

    const key = stallKey(run)
    if (alreadyProbed.has(key)) continue

    out.push({ run, key, minutes: Math.floor(minutes) })
  }

  return out
}
```

- [ ] **Step 4: Wire it into the loop**

In `src/supervisor/main.ts`, add `const probed = new Set<string>()` above the loop and, inside the
loop after the delivery block:

```ts
      for (const candidate of stallCandidates(runs, Date.now(), config.STALL_MINUTES, probed)) {
        probed.add(candidate.key)
        const path = artifactPathFor(candidate.run, null)
        const text = await renderPrompt(
          process.env.HERDR_PLUGIN_ROOT ?? process.cwd(), 'stall-probe', {
            run_id: candidate.run.run_id,
            phase: candidate.run.phase,
            minutes: String(candidate.minutes),
            artifact_path: join(candidate.run.repo_root, path ?? 'the expected artifact'),
          },
        )
        if (candidate.run.orchestrator_pane) {
          await herdr.agentPrompt(candidate.run.orchestrator_pane, text)
        }
      }
```

with these imports added:

```ts
import { renderPrompt } from '../lib/render'
import { artifactPathFor } from './deliver'
import { stallCandidates } from './stall'
```

- [ ] **Step 5: Run the tests**

Run: `bun test test/stall.test.ts && bun run typecheck`
Expected: PASS, 6 tests; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/supervisor/stall.ts src/supervisor/main.ts test/stall.test.ts
git commit -m "feat: stall probe restricted to artifact phases, once per phase entry"
```

---

## Task 28: The remaining `hpipe` commands

`status`, `drain`, `abort`, `resume`, and `forget` are in the CLI table but fall through to the usage
error after Task 25.

**Files:**
- Modify: `src/cli.ts`
- Create: `test/cli-commands.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/cli-commands.test.ts
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmdAbort, cmdForget, cmdResume, cmdStatus } from '../src/cli'
import { listRuns, newRun, saveRun } from '../src/lib/ledger'

let dir: string
const ctx = () => ({ stateDir: dir, pluginRoot: join(import.meta.dir, '..'), session: 'personal' })

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'clicmd-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function seed() {
  const run = newRun({ session: 'personal', socketPath: '/s', repoKey: 'k', repoRoot: '/r', title: 'a' })
  await saveRun(dir, run)
  return run
}

test('status reports no active runs on an empty ledger', async () => {
  expect((await cmdStatus(ctx())).text).toContain('no active runs')
})

test('abort marks the run aborted and it stops being active', async () => {
  const run = await seed()
  expect((await cmdAbort(ctx(), { runId: run.run_id })).ok).toBe(true)
  const after = (await listRuns(dir, 'personal'))[0]
  expect(after?.phase).toBe('done')
  expect(after?.history.at(-1)?.why).toContain('aborted')
})

test('resume undoes an abort back to the phase it was in', async () => {
  const run = await seed()
  await cmdAbort(ctx(), { runId: run.run_id })
  expect((await cmdResume(ctx(), { runId: run.run_id })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]?.phase).toBe('spec')
})

test('resume on a run that was never aborted is refused', async () => {
  const run = await seed()
  expect((await cmdResume(ctx(), { runId: run.run_id })).ok).toBe(false)
})

test('forget unbinds a workspace from its task', async () => {
  const run = await seed()
  run.tasks.push({
    task_id: 't1', branch: 'b', issue: 1, surface: 'core', depends_on: [], files: [],
    keep_worktree: false, text: '', workspace_id: 'w7', pane_id: 'w7:p1',
    agent_status: 'idle', phase: 'execute', pass: 1, phase_entered_at: 0,
    escalated_from: null, head_sha_at_entry: null, pr: null, ci: null,
  })
  await saveRun(dir, run)

  expect((await cmdForget(ctx(), { workspaceId: 'w7' })).ok).toBe(true)
  expect((await listRuns(dir, 'personal'))[0]?.tasks[0]?.workspace_id).toBeNull()
})
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test test/cli-commands.test.ts`
Expected: FAIL — `cmdStatus` is not exported.

- [ ] **Step 3: Implement — append to `src/cli.ts`**

```ts
import { join as joinPath } from 'node:path'
import { drain } from './lib/queue'
import { supervisorState } from './lib/pidfile'
import { formatStatus } from './lib/status'

export async function cmdStatus(ctx: Ctx): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  const state = await supervisorState(ctx.stateDir, ctx.session)
  return ok(formatStatus(
    runs,
    { state: state.state, pid: 'info' in state ? state.info.pid : undefined },
    ctx.session,
  ))
}

export async function cmdDrain(ctx: Ctx): Promise<CmdResult> {
  const events = await drain(joinPath(ctx.stateDir, 'queue'))
  return ok(events.length === 0 ? 'queue empty' : JSON.stringify(events, null, 2))
}

export async function cmdAbort(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  // Record where it was so resume can put it back. Worktrees and branches are untouched.
  run.history.push({ at: Date.now(), from: run.phase, to: 'done', why: `aborted from ${run.phase}` })
  run.escalated_from = run.phase
  run.phase = 'done'
  await saveRun(ctx.stateDir, run)
  return ok(`aborted ${run.run_id}; worktrees and branches left alone. Undo: hpipe resume ${run.run_id}`)
}

export async function cmdResume(ctx: Ctx, input: { runId: string }): Promise<CmdResult> {
  const run = (await listRuns(ctx.stateDir, ctx.session)).find((r) => r.run_id === input.runId)
  if (!run) return fail(`no such run: ${input.runId}`)

  const aborted = run.history.at(-1)?.why?.startsWith('aborted from')
  if (run.phase !== 'done' || !aborted || !run.escalated_from) {
    return fail(`${run.run_id} was not aborted — nothing to resume`)
  }

  const back = run.escalated_from
  run.history.push({ at: Date.now(), from: 'done', to: back, why: 'resumed' })
  run.phase = back
  run.escalated_from = null
  run.phase_entered_at = Date.now()
  await saveRun(ctx.stateDir, run)
  return ok(`resumed ${run.run_id} at ${back}`)
}

export async function cmdForget(ctx: Ctx, input: { workspaceId: string }): Promise<CmdResult> {
  const runs = await listRuns(ctx.stateDir, ctx.session)
  for (const run of runs) {
    const task = run.tasks.find((t) => t.workspace_id === input.workspaceId)
    if (!task) continue
    task.workspace_id = null
    task.pane_id = null
    await saveRun(ctx.stateDir, run)
    return ok(`unbound ${input.workspaceId} from ${task.task_id}`)
  }
  return fail(`no task is bound to ${input.workspaceId}`)
}
```

- [ ] **Step 4: Extend the dispatcher's switch**

Add these cases before `default:`:

```ts
    case 'status': out = await cmdStatus(ctx); break
    case 'drain': out = await cmdDrain(ctx); break
    case 'abort': out = await cmdAbort(ctx, { runId: rest[0] ?? '' }); break
    case 'resume': out = await cmdResume(ctx, { runId: rest[0] ?? '' }); break
    case 'forget': out = await cmdForget(ctx, { workspaceId: rest[0] ?? '' }); break
```

Change the `repoContext()` guard so `status`, `drain`, `abort`, `resume` and `forget` work outside a
repo:

```ts
  const needsRepo = command === 'start' || command === 'task'
  const repo = needsRepo ? await repoContext() : null
  if (needsRepo && !repo) {
    console.error('hpipe: not inside a git repository')
    return 1
  }
```

- [ ] **Step 5: Run the tests**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 6: Verify every documented command responds**

Run: `for c in status drain; do ./src/cli.ts $c; done`
Expected: `status` prints the session and supervisor state; `drain` prints `queue empty`. Neither
prints the usage error.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts test/cli-commands.test.ts
git commit -m "feat: hpipe status, drain, abort, resume, and forget"
```

---

## Task 29: Live integration smoke test and README

One live test, against a throwaway session, that restores the environment exactly. **Do not run it
against the `default` or `personal` sessions** — those are the user's live work.

**Files:**
- Create: `test/integration/smoke.md`, `README.md`

- [ ] **Step 1: Write the smoke runbook**

````markdown
<!-- test/integration/smoke.md -->
# Live smoke test

Manual, ~5 minutes. Uses a throwaway session so it cannot disturb `default` or `personal`.

## Setup

```bash
export SMOKE=pipesmoke
herdr --session "$SMOKE" server &
sleep 2
herdr plugin link "$PWD"
herdr plugin list          # assert: stein.pipeline present, warnings empty
```

## Assertions

1. **Startup reconciliation ran.**
   ```bash
   herdr --session "$SMOKE" workspace list   # assert: a workspace labelled "pipeline"
   herdr --session "$SMOKE" pane list        # assert: exactly ONE "Pipeline supervisor" pane
   ```

2. **The supervisor is live and knows it.**
   ```bash
   hpipe status              # assert: "supervisor: live"
   ```

3. **Hooks enqueue on a real worktree event.**
   ```bash
   herdr --session "$SMOKE" worktree create --branch smoke/x --base main
   # assert: a file appeared under $HERDR_PLUGIN_STATE_DIR/queue/ within a second,
   # then vanished as the supervisor drained it.
   ```

4. **`agent start` adopts the root pane.** Capture `.result.root_pane.pane_id` from the
   `worktree create` response above, then:
   ```bash
   herdr --session "$SMOKE" agent start smoke --kind claude --pane <root_pane_id> -- --version
   ```
   assert: succeeds, and `pane list` for that workspace still shows exactly ONE pane. There is no
   orphan to close.

5. **No plugin commands were dropped.**
   ```bash
   herdr plugin log list --plugin stein.pipeline | grep -c plugin_command_limit_reached
   ```
   assert: `0`. This is the assertion that would catch a regression back into blocking hooks.

6. **A dead supervisor leaves a readable pane.**
   ```bash
   kill $(jq -r .pid "$HERDR_PLUGIN_STATE_DIR/supervisor.$SMOKE.pid")
   herdr --session "$SMOKE" pane read <supervisor_pane_id> --source visible --lines 5
   ```
   assert: contains "supervisor exited", and the pane still exists.

## Teardown — mandatory

```bash
herdr plugin unlink stein.pipeline
herdr --session "$SMOKE" worktree remove --workspace <ws> --force
herdr --session "$SMOKE" server stop
herdr session delete "$SMOKE"
rm -f ~/.local/bin/hpipe
herdr plugin list          # assert: back to empty
herdr session list         # assert: only the sessions that were there before
```
````

- [ ] **Step 2: Write the README**

```markdown
# herdr-plugin-pipeline

Drives the superpowers pipeline across herdr worktrees: spec → adversarial review → plan →
adversarial review → dispatch → per-task two-stage review → CI → merge → close → teardown →
whole-branch review.

Event hooks only enqueue. One supervisor pane per herdr session owns all timing, evaluation, and
delivery, and prompts a single orchestrator agent with the next phase's instructions just in time —
so the pipeline never has to live in that agent's context.

## Install

    herdr plugin link /path/to/herdr-plugin-pipeline

Requires herdr 0.9.0+, bun, and gh. No build step.

## Use

From the orchestrator's pane, after brainstorming a design with the human:

    hpipe start "chat meter"

Everything after that is injected. `hpipe status` shows the fleet; `hpipe rewind <run> <phase>` is
the escape hatch if a phase advanced early.

## Getting out

| | |
|---|---|
| Advanced early | `hpipe rewind <run> <phase> [--task <id>]` |
| Stop driving a run | `hpipe abort <run>` (undo with `hpipe resume`) |
| Supervisor dead | `hpipe status`, then the `supervisor` action |
| Plugin misbehaving | `herdr plugin disable stein.pipeline` |
| Out permanently | `herdr plugin unlink stein.pipeline`, then `rm ~/.local/bin/hpipe` |

Nothing the plugin owns is load-bearing for the work: runs are bookkeeping, and the artifacts are
files in your repo and objects on GitHub.

## Design

`docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md`, with three adversarial reviews
in `docs/superpowers/reviews/`. Read the "Verified herdr facts" table before changing anything that
touches the herdr or gh CLIs — every row was measured, and several correct-looking assumptions in
earlier drafts were wrong.
```

- [ ] **Step 3: Run the full suite one last time**

Run: `bun test && bun run typecheck`
Expected: all green.

- [ ] **Step 4: Execute the smoke runbook**

Follow `test/integration/smoke.md` end to end, including teardown. Every assertion must pass. If
assertion 5 fails, a hook has started blocking — stop and fix it before merging.

- [ ] **Step 5: Commit**

```bash
git add README.md test/integration/smoke.md
git commit -m "docs: README and live smoke runbook"
```

---

## Done

At this point the plugin runs end to end. Before merging the final milestone, re-read the spec's
"Limits of inference" section: the plugin can still advance a phase early if an agent writes a
complete artifact and keeps working. That is accepted, documented, and `hpipe rewind` is the escape —
it is not a bug to fix in this plan.

Deferred, tracked separately, deliberately not in scope here: `bun build --compile`, link handlers,
marketplace publication, and correcting the stale `agent start` signature in
`nicaraguan-laws/CLAUDE.md` and `~/.claude/skills/herdr`.
