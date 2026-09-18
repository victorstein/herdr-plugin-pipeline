# Issue #13 — what the digest is today

Research phase. Everything below was read or run in this worktree at
`343dde4` (`fix/13-digest-content`, clean) on 2026-09-17.

## Baseline

```
$ bun test
 414 pass / 0 fail / 903 expect() calls — 33 files [8.79s]
$ bun run typecheck   # tsc --noEmit
(no output, exit 0)
```

Installed: `bun 1.3.14`, `herdr 0.9.0`, `typescript@5.9.3` (`bun.lock`),
`@types/bun@1.4.2` / `bun-types@1.4.2` / `@types/node@26.5.1`. No runtime deps
(`package.json` has `devDependencies` only), no build step. Plugin version
`1.2.4` (`version.txt`).

## Who owns the behaviour

Three files, in delivery order. None is held by the sibling task (#10 holds
`src/cli.ts`, `prompts/intake.md`, `prompts/dispatch.md`, `README.md`).

| File | Role |
|---|---|
| `src/supervisor/tick.ts:83-93` | builds the event line — the text issue #13 quotes |
| `src/supervisor/main.ts:124-131`, `:212` | decorates a `blocked` line with a pane tail, prefixes `- `, filters by run |
| `src/supervisor/deliver.ts:22-31`, `:50-74` | `buildDigest` assembles the message; `deliveriesFor` groups by pane |

`src/lib/status.ts` (issue #14) is **not** touched by anything above and is not
read by the delivery path.

## Control flow, one tick

`main.ts:114` `drain(queueDir)` → `main.ts:122` `applyEvents(...)`, which is the
only producer of wake lines. Three `wake.push` sites exist:

- `tick.ts:64` — `agent released` (phase forced to `failed`)
- `tick.ts:72-78` — `exited` / `exited, no PR` (phase forced to `failed`)
- `tick.ts:83-93` — `pane.agent_status_changed`, gated on `config.WAKE_ON`

Only the third fires in bulk, and its text is

```ts
text: `${task.branch} (#${task.issue}, ${task.task_id}) ${event.agent_status}`,
```

`event.agent_status` is herdr's screen-scraped pane state (`AgentStatus =
'idle' | 'working' | 'blocked' | 'done' | 'unknown'`, `src/lib/types.ts:5`). It
is written to `task.agent_status` at `tick.ts:85` and **never consulted by any
phase predicate** — `advanceTask`/`advanceRun` read `liveIdle`, not this field
(`src/supervisor/tasks.ts:17-22` says so explicitly: "NOT task.agent_status,
which is the badge and wake cache and can be stale by a whole turn").

Default `WAKE_ON` is `['blocked','done','idle','unknown','exited','released']`
(`src/lib/config.ts:25`), so a worker crossing `working → idle → done` emits two
wake lines per turn with no phase change behind either. (`applyEvents`' own
default parameter is the narrower `['blocked','done','idle']`,
`tick.ts:27` — `main.ts:122` overrides it with the config value, so the config
list is what runs.)

Then `main.ts:212`:

```ts
const lines = wake.filter((w) => w.run.run_id === run.run_id).map((w) => `- ${w.text}`)
addPending(run.orchestrator_pane, nextPrompt, lines, `run phase${phaseNote}`, phaseNote)
```

and `deliver.ts:22-31`:

```ts
`[pipeline] run ${input.run.run_id}${input.phaseNote}`, '', `${n} events:`, ...lines, '', nextPrompt
```

`phaseNote` is `` ` → ${first.run.phase}` `` unless `evaluateRun` advanced the
**run** this tick (`deliver.ts:67`, `deliver.ts:236`). `nextPrompt` is `''`
unless a run-level phase was entered (`deliver.ts:205`, `main.ts:207-209`);
worker prompts go to worker panes, not into the digest (`main.ts:214-216`,
`deliver.ts:62-70`). So the steady-state digest is exactly the issue's quote:
header, count, one line, nothing else. `buildDigest`'s `.trimEnd()` removes the
empty `nextPrompt` slot.

## The two claims in the issue, checked

**1. `agent_status` is not phase completion.** Directly observable in the
berean-os ledger at
`~/.local/state/herdr/plugins/stein.pipeline/runs/personal/berean-os-20260916-berean-os-issue-batch-ujku.json`
— read 2026-09-17 14:12 local, **4 of its 6 tasks** disagree at rest:

```
t2 fix/28-bookmark-save-budget   #28 [done]                agent_status=working
t3 fix/37-gate-screen-rotation   #37 [merge]               agent_status=done
t4 refactor/38-remove-qr-display #38 [blocked-on-decision] agent_status=done
t6 refactor/31-unused-i18n-keys  #31 [plan-review]         agent_status=done
```

(t1 and t5 are the two that agree: `[done]` with `agent_status=done`.)

t3 is the issue's failure mode frozen in the ledger: a line reading `t3 done`
while the task sits in `merge`, unmerged — and it has sat there since
2026-09-16T22:47:27.752Z, roughly 21 hours at the time of this read.

**2. Volume.** *(Read 2026-09-17 14:12 local; this ledger is still being written
— see the drift note below.)* The run's `history` holds **79 transitions between
its first and its abort** (2026-09-16T07:43:26.580Z → 2026-09-17T03:44:34.471Z,
20h01m): 76 task-level, 3 run-level. Only the 3 run-level ones can reach the
digest at all, because `phase_note` is composed from `evaluateRun`'s run
transition (`src/supervisor/deliver.ts:67`, `:236`); **all 76 task transitions
are invisible to the digest by construction**. That, not a digest-to-transition
ratio, is the volume argument.

> **Drift note.** This ledger is not frozen. Re-read at 14:12 local it holds
> **80** entries, the 80th being `t4 done -> blocked-on-decision` at
> 2026-09-17T20:05:44.516Z — appended today, to a run that was aborted
> yesterday. Any count taken from this file must be dated, which is why the
> reads above and below now are.

## What the digest cannot say today

- **Task phase.** Present on the record (`Task.phase`, `types.ts:71`) and in
  every other output — `hpipe status` prints `[${task.phase}]`
  (`status.ts:134`), the workspace badge carries `phase` (`badges.ts:16`) — but
  not in the event line.
- **Age.** `Task.phase_entered_at` / `Run.phase_entered_at` exist
  (`types.ts:72`, `types.ts:111`). Nothing in the delivery path reads them.
- **Next action.** Nothing in `WakeLine` (`tick.ts:6-10`) or
  `PendingPrompt` (`deliver.ts:33-41`) distinguishes "the supervisor drives this,
  do nothing" from "this needs you".

The last one is decidable from data already in hand: `taskRow(task.phase).actor`
(`src/lib/phases.ts:89-141`) says whether the row is `worker`-, `orchestrator`-
or `human`-owned, and `signal` says what clears it. `stall.ts:161-219`
(`stallAwaiting`) already turns exactly that pair into a true English sentence
and is keyed on `row.signal` for this reason.

## Nearest existing example

**`0aa1dbf` — "fix: make the stall probe's sentences true of what it names"**,
merged into `343dde4` yesterday. Same class of change: agent-facing text whose
claims the tree falsified, fixed by composing the sentence in TypeScript from
the phase row rather than asserting it in the template.
Shape (`git show --stat 0aa1dbf`): `src/supervisor/stall.ts` 26 lines changed,
`test/stall.test.ts` 38, plus comment corrections in `deliver.ts` (12) and
`tasks.ts` (9). No schema change, no new file.
`prompts/stall-probe.md` kept only the tokens (`{{awaiting}}`, `{{ladder}}`),
and `test/prompts.test.ts:128-148` pins what the template must *not* assert plus
a "rendered probe leaves no placeholder behind" check. That is the pattern to
mirror.

Secondary: `f5c733d` (#9) for how this repo frames a directive in the issue it
declines, and for the live-ledger-as-evidence style.

## One thing found on the way: `prompts/digest.md` is dead code

`grep -rn "renderPrompt(" src/` lists 19 call sites; **none names `digest`**.
`grep -rn digest src/` returns a single hit, a comment (`deliver.ts:39`). The
digest's layout is `buildDigest`'s `['...'].join('\n')` (`deliver.ts:22-31`) and
the template file is a duplicate of it that nothing reads.

It survives because `test/prompts.test.ts:12` hand-lists `'digest'` in `ALL`,
which is what the "no orphan prompt files" assertion (`:21-24`) checks against —
so the orphan test cannot see this orphan. The v4 plan already recorded this
(`docs/superpowers/plans/2026-09-15-worker-owned-pipeline.md:2995`) and the v3
review raised it as MINOR 7 (`docs/superpowers/reviews/2026-09-13-design-adversarial-2.md:624`),
where it was marked "Fixed" on the design without the wiring ever landing.

This matters to #13 because the issue reads `prompts/digest.md` as "the whole
template". It is not the template; editing it alone would change nothing
delivered. The spec has to pick: render the file (and pay `render()`'s
throw-on-unresolved-placeholder contract at delivery time,
`src/lib/render.ts:11`, in front of the orchestrator) or keep composing in TS
and delete the file. That is a spec decision, noted here, not settled here.

## Constraints the spec inherits

- No schema change is needed: every field the issue asks for (`phase`,
  `phase_entered_at`, `actor` via the phase table) already exists on disk. A
  change that did touch `schema_version` would break runs already on disk
  (`.claude/agents/plugin-dev.md`, "the self-hosting hazard").
- Age formatting exists twice already and is exported neither time:
  `status.ts:12-14` (`ageMinutes`, module-private) and `stall.ts:70` (inline,
  `MS_PER_MINUTE`). A third copy would be the third.
- `applyEvents` is pure and fully unit-tested (`test/tick.test.ts`), as is
  `buildDigest` (`test/deliver.test.ts:33-51`). The current contract those tests
  pin: the header contains `[pipeline] run`, the count reads `N events`, a
  worker delivery carries no header (`deliver.test.ts:64-71`), and the transition
  note survives grouping (`:201-211`).
- DI fakes have passed clean over real startup/gating defects twice
  (`.claude/agents/plugin-dev.md`). Delivery text is observable in
  `test/integration/smoke.md:164-165`, which already asserts what the
  orchestrator pane receives — that runbook is where a live check belongs.
