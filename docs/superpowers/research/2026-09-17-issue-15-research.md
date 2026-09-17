# Research — issue #15: the stall probe fires once per phase entry and never escalates

Branch `fix/15-stall-escalation`, worktree
`/Volumes/stein/.herdr/worktrees/herdr-plugin-pipeline/fix-15-stall-escalation`, at `6008bce`.
Everything below was read or run in that tree today; nothing is recalled.

## 1. Which files own the behaviour

| Concern | Location |
| --- | --- |
| Probe eligibility + the once-ever key | `src/supervisor/stall.ts:62` (`taskStallKey`), `:83` (task skip), `:45` (run skip) |
| Probe send + "mark probed only on success" | `src/supervisor/stall.ts:97-103` (`sendProbes`) |
| The `probed` set that backs `alreadyProbed` | `src/supervisor/main.ts:109` |
| The two probe call sites | `src/supervisor/main.ts:238-252` (run), `:254-268` (task) |
| Which rows are probe-eligible at all | `src/lib/phases.ts:31-41` (`stallable`, `stallWhen`, `probeTarget`) and the row table at `:51-73`, `:89-141` |
| Thresholds | `src/lib/config.ts:8-9`, defaults `STALL_MINUTES: 15` / `TASK_STALL_MINUTES: 45` at `:26-27` |
| Probe wording | `prompts/stall-probe.md` |
| The health signal the probe names | `src/supervisor/deliver.ts:84-102` (`artifactPathFor` / `absoluteArtifactPath`) |
| Automatic escalation, the only kind that exists | `src/lib/machine.ts:113-127` (`advanceLoopingRow`), `:68-83` (run rows) |
| `escalated` semantics | `src/lib/phases.ts:130-131` (task), `:70-71` (run); `src/lib/machine.ts:90-96` (`enterTaskPhase` stamps `escalated_from`) |
| `hpipe status` rendering + warnings | `src/lib/status.ts:73-131`; gone-pane warning at `:99-102` |
| Tests | `test/stall.test.ts` (20 tests, 31 `expect()` calls: `bun test test/stall.test.ts` → 20 pass, 0 fail) |

## 2. Current control flow

One supervisor tick (`src/supervisor/main.ts:111-272`), in order: drain events → load runs →
`applyEvents` → save → CI poll → `pickOneAdvance` → per-run `rebindOrchestrator`, `evaluateRun`,
`advanceTasks`, `deliverPendingAnswers`, `announceDecisions`, `refreshBadges` → `deliveriesFor`
sends → **then** the two `sendProbes` calls. Loop sleeps `TICK_MS` (default 1000, `config.ts:23`).

Probe selection, per candidate (`stall.ts:66-87`):

1. `taskRow(task.phase).stallable` must be true — `queued`, `ci`, `merge`, `close`, `teardown`,
   `failed`, `orphaned`, `blocked-on-failure`, `escalated`, `done` are all excluded
   (`phases.ts:89-141`).
2. `probePaneFor` resolves a pane; a worker row with `pane_id === null` falls back to
   `run.orchestrator_pane` (`stall.ts:22-26`).
3. `(now - task.phase_entered_at) / 60_000 >= thresholdMinutes`.
4. **`alreadyProbed.has(key)` → skipped**, where the key is
   `${run_id}:${task_id}:${phase}:${phase_entered_at}` (`stall.ts:62-64`).

`sendProbes` adds the key to `probed` only when the send returned `ok` (`stall.ts:101`), so a failed
send stays eligible — `test/stall.test.ts:153-163` pins that. Because step 4's key is bound to
`phase_entered_at`, a *successful* probe permanently retires that phase entry. There is no counter,
no second probe, no backoff and no timer that outlives it: the issue's reading of the code is
correct.

Two further properties that constrain any fix:

- **`probed` is process-local and unpersisted.** It is a bare `Set<string>` created inside `main()`
  (`main.ts:109`) and never written to the ledger (`saveRun` serialises the `Run` only,
  `ledger.ts:44-46`; `Task` has no probe field, `types.ts:44-80`). A supervisor restart silently
  re-arms every probe. Any attempt count that must survive a restart has to go on the record.
- **The probe prompt promises the current behaviour.** `prompts/stall-probe.md:7` — "If you are
  still working, ignore this — it will not ask again for this phase." Re-probing makes that line
  false.

### The health signal

For a task the probe names `absoluteArtifactPath(run, task)` (`deliver.ts:97-102`), i.e.
`task.checkout_path` joined with the row's artifact slot or a `docs/superpowers/reviews/...` verdict
path. The phase-advance predicates are `isFresh` (mtime > `phase_entered_at`,
`predicates.ts:10-16`) and `isSettled` (size+mtime stable across `FILE_SETTLE_MS`,
`predicates.ts:27-33`). Nothing reads the worktree's git state: the only `git` subprocesses in
`src/` are `git rev-parse --show-toplevel` at `src/cli.ts:346` and `src/actions/claim.ts:14`
(`grep -rn "Bun.spawn" src/`). A dirty-worktree liveness signal would be new subprocess surface, not
a reuse.

### The dead-orchestrator half of the issue

The issue says the supervisor "does not act on" the gone-pane case. Precisely: it *does* call
`rebindOrchestrator` every tick for every advancing run (`main.ts:170`), which lists live panes
(`orchestrator.ts:47`) and re-points the run when `resolveOrchestrator` finds exactly one agent pane
in the repo's primary workspace. When it cannot disambiguate it returns `null` (`orchestrator.ts:30`)
and deliberately keeps the stale id (`orchestrator.ts:38-41`). What is missing is any *stop*: the
run keeps producing digests, and the per-pane failure counter in `main.ts:229-235` is **deleted**
when the budget is exhausted (`attempts.delete(delivery.paneId)` at `:234`), so the next tick starts
counting from 1 again. "Giving up" is not sticky — it is a 5-tick cycle repeated forever, which is
consistent with 33 further deliveries into a dead pane. `formatStatus` is the only place that names
the condition (`status.ts:99-102`), and it is reached from the CLI/action path only
(`src/actions/status.ts:12`, `src/cli.ts:278`), never from the supervisor.

### What `escalated` currently costs a task

If the fix routes a stalled task to `escalated`, these are already true and are not free:

- `escalated` holds its files: `{ phase: 'escalated', ..., holdsFiles: true }` (`phases.ts:130-131`).
  A task in `blocked-on-files` behind it waits forever, and `status.ts:47-52` tells the human
  `hpipe release --task <id>` is the only way out.
- `escalated` is in `TERMINAL_BAD` (`gating.ts:6-8`), so every dependent task gates straight to
  `blocked-on-failure`.
- `escalated` is in `SETTLED` (`teardown.ts:12-15`) but not `terminal`, so the run can still leave
  `execute` — and `advanceRun`'s `execute` arm sends the whole run to `escalated` if no task ever
  reached `done` (`machine.ts:68-73`).
- Nothing ever tears an escalated task's worktree down (`runTeardown` only acts on `phase ===
  'teardown'`, `teardown.ts:25`).

## 3. Installed versions

```
$ bun --version   → 1.3.14
$ node --version  → v24.16.0
$ gh --version    → gh version 2.96.0 (2026-07-02)
$ herdr --version → herdr 0.9.0
$ git --version   → git version 2.54.0
$ bunx tsc --version → Version 5.9.3
```

`package.json` declares no runtime dependencies; devDependencies are `@types/bun: latest` and
`typescript: ^5.6.0`. `bun.lock` (lockfileVersion 1) resolves `@types/bun@1.4.2`,
`bun-types@1.4.2`, `@types/node@26.5.1`, `typescript@5.9.3`, `undici-types@8.9.0`.

Baseline on this worktree, before any change:

```
$ bun test
 351 pass
 0 fail
 767 expect() calls
Ran 351 tests across 33 files. [6.23s]

$ bun run typecheck
$ tsc --noEmit          (no output, exit 0)
```

## 4. Nearest existing examples

**Nearest change to this exact code** — three prior commits touch `src/supervisor/stall.ts`, and all
three have the same shape: row-table or predicate edit plus tests, no new persisted state.

```
$ git log --oneline --all -- src/supervisor/stall.ts
6d3b840 feat: move design work into per-issue worker agents (#4)
9153fa4 fix: probe execute only when it is genuinely stuck
0b5283a feat: probe the actorless rows through the orchestrator pane
fe3b727 feat: table-driven run machine with explicit intake closure
38ffabf feat: the herdr pipeline plugin (#1)
184187b fix: probe stalled tasks even after a PR already exists
58263b4 fix: poll CI across all runs and notice silent tasks
1315d82 feat: stall probe restricted to artifact phases, once per phase entry
```

`1315d82` is the commit that introduced the behaviour #15 is about —
`src/supervisor/main.ts | 21 +`, `src/supervisor/stall.ts | 29 +`, `test/stall.test.ts | 43 +`.
`9153fa4` is the closest precedent for narrowing probe eligibility: `src/lib/phases.ts | 21 +-`,
`src/supervisor/stall.ts | 1 +`, `test/stall.test.ts | 19 +-`.

**Nearest existing "retry N times, cap it, surface it, reset it from the CLI" mechanism** —
`delivery_attempts`, which is the pattern a probe-attempt counter would mirror almost field for
field:

- persisted field on `Task`: `delivery_attempts: number` (`types.ts:78`), initialised at
  `cli.ts:95`;
- cap from config: `PROMPT_RETRY_MAX: 5` (`config.ts:13`, `:31`), plumbed as
  `promptRetryMax` (`main.ts:200`, `tasks.ts:246`);
- the check and the increment: `tasks.ts:260` (`>= deps.promptRetryMax → continue`), `:277`
  (`+= 1` on a failed send), `:282` (reset to 0 on success);
- surfaced to the human in `hpipe status`: `status.ts:29-36`;
- cleared by `hpipe rewind` / `hpipe answer`: `cli.ts:179`, `cli.ts:270`;
- documented for the operator: `test/integration/smoke.md:281`, `:473`.

**Nearest existing "N failures → `escalated`" mechanism** — `advanceLoopingRow`
(`machine.ts:113-127`): `bumpCounter(task, row.phase)`, then `count >= maxPasses` →
`enterTaskPhase(run, task, 'escalated', ...)`, else back to `row.onBlocker`. The counter is
monotone by design (`machine.ts:11-21`) and only `hpipe rewind` clears it. The escalation prompt it
lands on is `prompts/escalate.md`, which is written for the review-pass case ("This phase hit
{{pass}} review passes without clearing") and would need a second framing for a stall.

## 5. Open questions the spec has to settle

- Re-probe the same pane, or escalate to a different actor? The worker fallback already collapses a
  paneless worker onto the orchestrator (`stall.ts:22-26`), so "probe the orchestrator after N
  worker probes" reuses existing plumbing; "escalate to the human" does not exist as a task
  transition outside `advanceLoopingRow`.
- Where the attempt count lives. In-process (`probed`, lost on restart) is what exists; on `Task`
  (like `delivery_attempts`) is what survives — and `Run` has `schema_version: 2`
  (`ledger.ts:38`), with `isCurrentSchemaRun` rejecting anything else (`main.ts:30-32`), so an
  added optional field needs a defaulting story for runs already on disk.
- Whether reaching `escalated` for a stall is acceptable given §2's file-holding and
  `TERMINAL_BAD` cascade, or whether a new non-file-holding state is needed.
