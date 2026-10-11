# Usage-limit awareness — design

Pass 1. Written against `main` at `3389164`. It answers findings #13 (rest), #14 and #15 of
`docs/superpowers/notes/2026-10-11-berean-os-live-run.md`. Effort by tier (#13, first part) shipped
separately on `fix/effort-by-tier`.

## Evidence

On the 2026-10-11 berean-os run, Claude's session limit stopped every agent twice: 10:07–11:20Z and
12:34–16:20Z. The plugin saw both outages only as silence.

- **Each worker went idle on a rejected request.** herdr reported it `done`, and its screen ended in
  `You've hit your session limit · resets 10:20am (America/Managua)`. Fifty such 429s occurred across 18 worker transcripts
  from 2026-09-16 to -30, so this isn't rare.
- **The stall ladder ran on.** Every probe was typed in and rejected on arrival, yet counted as a rung. The
  3 h 46 min outage escalated t4, t5 and t6 at 15:34–15:39Z.
- **Every delivery to the orchestrator was wasted.** 18 rejections in the first outage and 33 in the second.
  The gate saw them as delivered, because the text *was* submitted.
- **Nothing resumed at the reset.** The first time, the human told the orchestrator to wake everyone. The
  second time, an escalated task's probe happened to land a minute after the reset. Both times the orchestrator
  same-phase-rewound every task (#14), which clears `passes`, re-reserves verdicts and writes `manual rewind`
  history.

The message has two forms, both seen in transcripts:

    You've hit your session limit · resets 10:20am (America/Managua)
    You've hit your weekly limit · resets Sep 22 at 3am (America/Managua)

## Decisions

| | |
|---|---|
| What is limited | a **pane**, detected from its own screen. Not the account, and not the run |
| Detection | the last limit message on the screen, with no assistant output (`⏺`) below it |
| Where it is read | (a) before every send, from the screen the courier already reads for the input box; (b) on a task pane's `agent:idle`/`agent:done` wake |
| Effect while limited | the gate holds every send to the pane (`held: 'usage_limit'`). Stall candidates whose recipient or actor pane is limited are skipped: no rung, no hold, no escalation |
| At the reset (+60 s) | each limited worker pane gets one `usage-resume` prompt, and its ladder is re-armed (`probes: 0`). The orchestrator gets one note per run naming what resumed. Held digests then flow as normal |
| State | in the gate's memory, like `stuck`. A restarted supervisor re-detects from the screen |
| Status | `hpipe status` reads it through `delivery.<session>.json` (`code: 'usage_limit'`, `until`) |
| Manual | `hpipe nudge --task <id>` / `--all` queues the same resume prompt and changes no phase, passes, verdict or history |
| Not here | a cap on concurrent workers (needs config the CLI reads; separate PR); staggered wake-ups (spreading the restart doesn't lower total use) |

Rejected:

- **Reading Claude's transcript JSONL.** It carries the exact error time, but its path depends on
  `CLAUDE_CONFIG_DIR` and Claude's internal layout. The screen is the interface the plugin already depends on.
- **A run-wide or session-wide flag.** Panes can belong to different accounts, and one pane's screen proves
  only that pane is limited. Every pane on the same account hits the limit on its next request anyway, and is
  detected then.
- **Resuming by re-sending the phase prompt (`owePhasePrompt`).** The worker's context still holds the phase.
  A full phase prompt restarts it from the top, and a review phase would dispatch a second reviewer next to the
  one the limit cut off.

## 1. Parsing (`src/lib/usage-limit.ts`, new, pure)

    export interface UsageLimit {
      kind: 'session' | 'weekly'
      resetsAt: number           // epoch ms
      text: string               // the message line, trimmed
    }
    export function usageLimitOn(screen: string, seenAt: number): UsageLimit | null

- Regex on each line: `/You've hit your (session|weekly) limit · resets (.+?) \(([^)]+)\)/`.
- The **last** match counts, and only if no line below it starts with `⏺`, i.e. the agent has answered
  nothing since. An old message left on screen above newer output isn't a limit.
- Time spec: `h[:mm](am|pm)`, or `Mon D at h[:mm](am|pm)` for weekly. The zone is an IANA name. Wall time
  is converted to UTC with `Intl.DateTimeFormat` offsets (two passes, for DST).
- **Which day.** A session limit resets within 5 h of being hit, and the message is never newer than
  `seenAt`. So the reset is the one occurrence of that wall time in `(seenAt − 19 h, seenAt + 5 h]`. If it's in
  the past, the pane is resumable now. Weekly: the year that puts the date nearest `seenAt`.
- Anything unparseable (format, zone) still counts as limited, with `resetsAt = seenAt + 30 min`. The next read
  re-evaluates it.

**Known gap.** A message left at the bottom of an idle pane more than 19 h after its reset reads as a future
reset, up to 5 h away. That pane would be held, then resumed, for nothing worse than a delay.

## 2. The gate (`src/supervisor/courier.ts`)

`DeliveryGate` gains `limits: Map<pane, { until, text, since }>`:

- `limitedUntil(pane): number | null`. Null once `now >= until`.
- `markLimited(pane, limit)`. It bumps `revision` and logs once:
  `usage limit in w4:p1 until 16:20Z: holding what is addressed to it`.
- `expiredLimits(now, graceMs): Array<{ pane, limit }>` removes and returns the entries whose `until + grace`
  has passed.
- `holds()` reports `{ code: 'usage_limit', since, failures: 0, until }`. `PaneHold` gains optional `until`.

`makeCourier`, ahead of `admit`: if `limitedUntil(pane) !== null`, return
`{ ok: false, code: 'usage_limit', held: 'usage_limit' }` without reading the screen. `boxHold` reads the
screen once and hands it to both checks. A limit found there marks the pane and holds the send, before any
box clearing.

`HoldReason` gains `'usage_limit'`. A held send settles nothing in the outbox (as for `stuck_input`), so the
prompt waits rather than being retried into a wall.

## 3. Detection on wake (`src/supervisor/main.ts`)

In the wake loop that already reads a tail for `agent:blocked`, an `agent:idle` or `agent:done` line for a task
pane reads 40 lines (`paneRead`, plain). A limit found there is marked on the gate, and the line's detail becomes
`paused by Claude's usage limit until 16:20Z`. This catches a worker that hit the limit mid-phase before anything is
owed to it. Before, the first detection would have come with the stall probe 45 minutes later.

## 4. The stall ladder (`src/supervisor/stall.ts`, `main.ts`)

`applyStalls` gets `limited: (pane) => boolean` in `StallDeps`. A candidate whose `paneId` or `actorPaneId` is
limited is skipped outright, before the probe or the escalation's status check. Skipping is correct for both:
a probe can't be answered, and an escalation would be a quota pause dressed as a stall.

The probe dep also maps `held === 'usage_limit'` to `deferred: true`, for the race where the courier detects the
limit on the probe's own send.

## 5. Resume (`src/supervisor/main.ts` + `prompts/usage-resume.md`, new)

After delivery each tick, `gate.expiredLimits(now, 60_000)` is checked. For each expired pane, in each driven run:

- **A task's pane, in a worker row** (`taskRow(phase).actor === 'worker'`): `enqueue` a worker entry with
  `kind: 'resume'`. Its text is `usage-resume.md`, rendered with the phase, the task and when the limit began and
  ended. Then re-arm the task's ladder: `stall = { at, run_at, last_probe_at: now, probes: 0, undelivered: 0, holds: 0 }`.
- **The orchestrator pane:** re-arm the ladder of the run and of every task whose probe recipient is the
  orchestrator.
- **One orchestrator note per run** for the tick's expiries (`to: 'orchestrator'`):
  `Claude's usage limit held this run from 12:34Z to 16:20Z. Resumed where they stopped: t4 (pr-review), t5 (pr-review), t6 (pr-review). Their stall clocks restarted. Nothing for you to do — do not rewind them.`

Both are queued in the same save. The courier then delivers them like any other outbox entry, with every guard
(stuck input, budget, a limit that came back) intact.

`usage-resume.md`:

    # Usage limit lifted — {{phase}} ({{task_id}}, {{branch}})

    Claude's usage limit stopped this session at about {{since}}, and it has reset. Carry on with
    `{{phase}}` from where you stopped. Do not start the phase over: what you already committed, pushed
    or wrote stands. If a subagent you dispatched was cut off by the limit, dispatch it again with the
    same brief and wait for it within this turn.

`OutboxEntry.kind?: 'phase' | 'resume'` (absent reads as `'phase'`). `queuedWorkerPrompt` (status's "its X prompt
is queued") matches only `'phase'` entries. A resume entry in the box is reported as `resume queued for w4:p1`.

## 6. `hpipe nudge` (`src/cli.ts`)

    hpipe nudge --task <id> | --all

It queues the same `kind: 'resume'` entry for each named task that is in a worker row and has a pane, and
re-arms its ladder. `--all` covers every such task in the run. It refuses a task with no pane (status already
says how to start one) and a non-worker row. It touches no phase, passes, verdict reservation or history. It
prints one line per task: `t4: resume queued for w4:p1 (pr-review)`.

The skill's recovery table gains:

| Workers idle after Claude's usage limit | The supervisor resumes them at the reset. If one is still idle after that, `hpipe nudge --task <id>`. Never `rewind` to the same phase for this. |

## 7. Status (`src/lib/status.ts`)

- A pane held with `code: 'usage_limit'`. The task's move reads
  `nothing for you — paused by Claude's usage limit until 16:20Z; the supervisor resumes it then`. That sits ahead of
  the idle-with-nothing and waiting-for-verdict clauses that misread the pause at 11:21Z.
- The `⚠` delivery block shows `usage limit in w1:p1 until 16:20Z` instead of a failure count.

## 8. Tests

- `usage-limit.test.ts`:
  - both message forms;
  - am/pm, `12am`/`12pm`, minutes optional;
  - the day choice either side of midnight and of the 5 h window;
  - a DST change in a zone that has one;
  - an unknown zone, which falls back to 30 min;
  - a later `⏺` line, which isn't a limit;
  - the last of two messages wins.
- Gate:
  - a limited pane holds without reading the screen;
  - `expiredLimits` returns once, then never again;
  - `holds()` carries `until`.
- Courier: a limit on the screen holds the send and leaves the box untouched.
- Stall:
  - a limited recipient or actor yields no rung, hold or escalation;
  - after expiry the ladder starts from zero.
- Resume:
  - one worker entry and one orchestrator note per run;
  - not for a task in a non-worker row;
  - not twice for one expiry.
- `nudge`: queues, re-arms, and leaves phase, passes, `verdict_seq` and history unchanged; the refusals.
- Status: the paused clause wins over idle-with-nothing.
- Wiring (per `project-di-hides-wiring-bugs`): a supervisor-level test that drives a worker pane through
  `agent:done` with a limit on its screen → held → expiry → resume entry delivered. Then a live check in a
  `pipesmokeN` session, by putting the message on a pane's screen.
