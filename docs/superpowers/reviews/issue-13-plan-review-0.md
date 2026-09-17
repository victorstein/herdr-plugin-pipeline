# Adversarial review — implementation plan for #13, pass 0

**Plan:** `docs/superpowers/plans/2026-09-17-issue-13-plan.md`
**Spec:** `docs/superpowers/specs/2026-09-17-issue-13-design.md` (v4, `VERDICT: CLEAR` at pass 2)
**Reviewed at:** `8402480`, worktree `fix-13-digest-content`

## Method — the plan was executed, not read

Baseline re-verified first: `bun test` → **414 pass / 0 fail / 33 files**; `bun run typecheck` → exit 0.
Matches the plan's stated baseline (`plan:24`).

Every step was then **applied to the tree literally** — the quoted `tick.ts`, `main.ts` and
`deliver.ts` edits, all 24 quoted tests appended verbatim to `test/tick.test.ts` /
`test/deliver.test.ts`, the `ALL` edit in `test/prompts.test.ts`, and the deletion of
`prompts/digest.md` — and the gates re-run. Result:

```
438 pass / 0 fail / 1019 expect() calls across 33 files
tsc --noEmit → exit 0
```

414 + 24 = 438, so every quoted test compiles, runs, and asserts exactly what it claims. **Every
expected string in the plan matched character for character**, including the em-dash in
`agent:idle — worker's move`, the `→` in `[research → spec]`, the four-space tail indent, and the
backtick-quoted `` `hp rewind r1 plan --task t2` ``. The tree was then reverted and the 414/0
baseline re-confirmed.

The 5a/5b/5c split **genuinely holds**: 5a adds `event`/`phaseAtEvent` without removing `text`, so
`src/supervisor/main.ts:128`/`:212` keep compiling; 5b is purely additive; 5c is the only step with a
red interval, closed inside the step. No other step leaves a red tree. The `hpipe` hoist from
`main.ts:239` to just above the run loop is in the same `try` block as its remaining consumer at
`main.ts:249`, so it resolves. No forbidden file (`src/cli.ts`, `prompts/intake.md`,
`prompts/dispatch.md`, `README.md`, `src/lib/status.ts`, `src/lib/phases.ts`,
`test/integration/smoke.md`) is touched.

Every §C1–§C4 requirement and every numbered step of §Data-and-control-flow maps to a plan step. No
placeholders, no "do X" without showing how. What follows is what the execution exposed.

---

## MAJOR 1 — the spec's T23c is degraded into a test that cannot fail, leaving pass-2 MAJOR 2 unguarded

**Claim.** Step 8's fourth test is titled *"the footer rides any orchestrator delivery, not only the
wake-line one"* and its comment states the failure it guards: *"main.ts pushes up to three
orchestrator pendings per run and the first is dropped when it has no text and no events, so
attaching the footer to that one alone loses it"* (`plan:691-701`).

**Problem.** The test body does not construct that situation. It passes **one** pending that carries
both `text: 'merge PR #44'` **and** the `footer` (`plan:696-699`). A single pending that survives
`deliveriesFor`'s filter and carries the footer itself is green under *any* wiring, including the v3
wiring that pass 2 ranked MAJOR. The assertion and the comment do not describe the same scenario.

The spec's T23c is explicit about the shape required: *"an orchestrator pending with empty
`text`/`events`, **plus a second** orchestrator pending carrying only a task prompt | the footer
still renders — pins **pass 2 MAJOR 2**"* (`design.md`, §Testing strategy, T23c row).

**Evidence.** Built against the plan's own `deliver.ts` (step 8 applied), the spec's form of the test
fails today and the plan's form does not:

```
deliveriesFor([
  { paneId: 'w1:p1', run, text: '',             isOrchestrator: true, events: [], footer: 'also waiting on you:\n- t3' },
  { paneId: 'w1:p1', run, text: 'merge PR #44', isOrchestrator: true, events: [] },
])
→ "[pipeline] run … → intake\n\n0 events:\n\nmerge PR #44"      // footer gone
```

`src/supervisor/deliver.ts:53` drops the first pending before grouping, so
`group.find((p) => p.footer)` at the plan's step-8 insertion point never sees it. That is exactly the
loss `design.md` §Data-and-control-flow step 10 and **A15**/**pass 2 MAJOR 2** exist to prevent, and
it is the only seam at which it is testable — `main.ts`'s tick body is not extracted, so step 9
("No new test here", `plan:762`) contributes no coverage either. As written, an implementer who
attached `footer` only to the first `addPending` — v3's wiring — would ship green.

**Fix.** Replace the step-8 test body with the spec's two-pending form and keep the existing title:

```ts
test('the footer rides any orchestrator delivery, not only the wake-line one', () => {
  const run = mkRun()
  const footer = 'also waiting on you:\n- t3 y (#3) [merge 41m] — YOUR move'
  const out = deliveriesFor([
    { paneId: 'w1:p1', run, text: '', isOrchestrator: true, events: [], footer },
    { paneId: 'w1:p1', run, text: 'merge PR #44', isOrchestrator: true, events: [], footer },
  ])
  expect(out).toHaveLength(1)
  expect(out[0]?.text).toContain('also waiting on you:')
})
```

Carrying `footer` on **both** pendings is what step 9's wiring actually produces, so this is red under
v3's wiring and green under the plan's, and it also exercises `group.find`'s de-duplication (one
`also waiting on you:` in the output).

---

## MAJOR 2 — spec test T10 appears in no step, and it is the only mechanical guard on step 5c's gate change

**Claim.** The plan's shape section says steps 5a–5c carry §C1 (`plan:29-31`), and step 5c replaces
`main.ts`'s blocked-tail gate `line.task?.agent_status === 'blocked'` with
`line.event === 'agent:blocked'` (`plan:503-513`).

**Problem.** The spec's T10 — *"`applyEvents` with `blocked` then `idle` for one task in one call |
two lines; `wake[0].event === 'agent:blocked'`, `wake[1].event === 'agent:idle'`"* — is in no step.
Step 5a has three tests (`plan:288-319`), each applying a **single** event. Nothing anywhere in the
plan applies two status events for one task in one `applyEvents` call.

That is the case the whole change is justified by. `design.md` §C1 and **A12** argue the gate must
move because *"one drain can apply `blocked` then `idle` for the same task: the `agent:blocked` line
loses its tail, and in the reverse order an `agent:idle` line carries a blocked pane's screen"*. The
per-line (rather than per-task) semantics of `event` is the entire content of pass-0 MAJOR 1, and
after the plan is applied nothing in the suite would notice if `event` were computed from
`task.agent_status` instead of from `event.agent_status`.

**Evidence.** `src/supervisor/tick.ts:84` (`if (task.agent_status === event.agent_status) continue`)
plus `src/lib/config.ts:25` (`WAKE_ON: ['blocked','done','idle','unknown','exited','released']`) mean
a `blocked`-then-`idle` pair against a `working` task does push two lines — the test is writable and
green under the plan's step-5a implementation. It is simply absent. The spec does not mark it
dropped; §Testing strategy lists it as a required new test in `test/tick.test.ts`.

**Fix.** Add to step 5a, after the existing three tests:

```ts
test('two status events for one task in one drain produce two separately-keyed lines', () => {
  // The gate `main.ts` uses for the pane tail keys off `event`, not
  // `task.agent_status` — that field is overwritten by the second event in the
  // same drain, so a per-task gate attaches the tail to the wrong line.
  const run = mkRun([mkTask({ phase: 'implement' })])
  const at = (agent_status: AgentStatus): QueuedEvent =>
    ({ kind: 'pane.agent_status_changed', session: 'personal', at: 1,
       pane_id: 'w7:p1', workspace_id: 'w7', agent_status })
  const { wake } = applyEvents([run], [at('blocked'), at('idle')], 'personal', new Set())
  expect(wake.map((w) => w.event)).toEqual(['agent:blocked', 'agent:idle'])
  expect(run.tasks[0]?.agent_status).toBe('idle')
})
```

The second assertion is the point: `task.agent_status` is `idle` for **both** lines, so the old gate
could not have distinguished them.

---

## MINOR 1 — step 5c's stated red is wrong: four errors, not two, and the remediation note names only one of the two test sites

**Claim.** *"Run `bun run typecheck` — **two errors**, at `src/supervisor/main.ts:128` and `:212`.
That is the red."* (`plan:495-496`.) And at the end: *"If `test/tick.test.ts` still references `text:`
in the `wakeLine` helper from step 5b, drop that property there too."* (`plan:543-544`.)

**Problem.** `tsconfig.json` has `"include": ["src", "test"]`, so `bun run typecheck` compiles the
test files. Step 5b introduces `text: ''` at **two** sites in `test/tick.test.ts`: the `wakeLine`
helper (`plan:394`) and the run-level literal passed directly to `describeWake` in the fourth test
(`plan:439`). Both are fresh object literals, so both trip excess-property checking. The remediation
sentence is conditional and names only the helper.

**Evidence.** Reproduced by applying step 5b as written and then deleting `text` from `WakeLine`:

```
test/tick.test.ts(377,83): error TS2353: Object literal may only specify known properties,
                           and 'text' does not exist in type 'WakeLine'.
test/tick.test.ts(418,70): error TS2353: …
```

plus the two in `main.ts` — four, not two.

**Fix.** Change the sentence at `plan:495-496` to *"four errors: `src/supervisor/main.ts:128` and
`:212`, and the two `text: ''` sites step 5b added to `test/tick.test.ts` (the `wakeLine` helper and
the run-level literal in *'a run-level wake line renders without an action rung'*)"*, and make
`plan:543-544` unconditional, naming both sites. Simplest alternative: omit `text: ''` from both
sites in step 5b — TypeScript does not require an optional-free literal to carry every field, and
`text` is only removed one step later anyway. Either way the gate catches it; the plan's stated red
should just be true.

**Also, minor and in the same class:** step 9 cites *"currently lines 212–217"* and *"currently lines
156–169"* (`plan:771`, `:790`), but step 5c has already inserted two lines above 155 and grown the
blocked-tail loop from 8 lines to 11, so those ranges no longer hold by the time step 9 runs. The
quoted *content* is unambiguous, so this is navigational only — but "currently" should be read as
"at HEAD", and saying so once in §Before you start would remove the ambiguity.

---

## MINOR 2 — step 8's red is misdescribed; `bun test` does not typecheck

**Claim.** *"Run `bun test test/deliver.test.ts` — fails to typecheck on the unknown `footer` key."*
(`plan:713`.)

**Problem.** Bun transpiles and does not typecheck, so the unknown `footer` key is silently dropped
at runtime rather than raising. The step still goes red — three of its five tests fail on their
assertions — but two (*'a digest with no footer is byte-identical…'* and *'a worker delivery never
carries the footer'*) **pass at baseline**, which is expected for a compatibility test and a
negative test, and an implementer told to expect a compile failure may think the step is misapplied.

**Evidence.** Verified: with the step-8 tests appended and `deliver.ts` unchanged, `bun test
test/deliver.test.ts` reports failures on the three footer-asserting tests only.

**Fix.** Reword to: *"Run `bun test test/deliver.test.ts` — the three footer-asserting tests fail
(Bun strips types, so the unknown key is dropped rather than raising). `bun run typecheck` is what
flags the key itself."*

---

## MINOR 3 — no traceability to T1–T27, and three spec cases are silently absent

**Claim.** The plan is a faithful rendering of §Testing strategy.

**Problem.** The plan carries no mapping from its tests back to the spec's T-numbers, so an absence
is invisible. Walking the table by hand: T1–T9, T9b, T9c, T11–T13, T15–T24, T27 are present.
Beyond the two MAJORs above, three are absent and none is marked dropped:

- **T25** — *"same, with `hpipe = 'bun run /p/src/cli.ts'` | the footer line carries **that** string
  … proves the parameter is live, which it was not in v2"*. All four `parkedFooter` tests
  (`plan:555-590`) pass `'hp'`. Step 2's `actionFor` test covers the rendering, but T25's subject is
  `parkedFooter`'s own fourth parameter.
- **T26** — *"`escalated` task that ALSO produced a wake line this digest | `''` — `covered` wins over
  the widened predicate"*. Step 6's covered test (`plan:572-576`) uses a `merge` task, not an
  `escalated` one; the widened predicate is the half T26 exists to pin.
- **T9's second half** — *"and **never** the string `intake`"*, the falsehood §Rejected alternatives
  and **A8** are built on. Not asserted anywhere.

**Evidence.** `grep -c "'bun run /p/src/cli.ts'" ` over the plan's step-6/7 blocks: 0.
`plan:572-576` uses `phase: 'merge'`. No occurrence of `intake` in any assertion.

**Fix.** Two one-line additions to step 6 and one to step 2, plus a short traceability line per step:

```ts
test('the footer renders the CLI it is given, and covered wins over the escalated exception', () => {
  const now = 1_000_000
  const run = mkRun([])
  run.run_id = 'r1'
  run.tasks = [mkTask({ task_id: 't1', phase: 'escalated', escalated_from: 'plan',
                        phase_entered_at: now })]
  expect(parkedFooter(run, new Set(), now, 'bun run /p/src/cli.ts'))
    .toContain('bun run /p/src/cli.ts rewind r1 plan --task t1')   // T25
  expect(parkedFooter(run, new Set(['t1']), now, 'hp')).toBe('')   // T26
})
```

and in step 2's rung-7 loop, `expect(at(phase)).not.toContain('intake')` (T9). Then add a
`**Covers:** T…` line to each step so a future pass can audit the table without re-deriving it.

---

## What was checked and found sound

Recorded so the next pass does not re-derive it:

- **§C2's ladder is faithful to the spec's table, in order.** Rung 6 is inserted between the
  `row.actor === 'worker'` rung and the catch-all, matching `design.md` §C2 rungs 1–7. Verified
  against `src/lib/phases.ts:89-141`: all 20 `TASK_ROWS` classify, and step 4's guard passes.
- **Rung 6's predicate matches `src/lib/status.ts:46-63`.** `isInFlight` is `true` for both `failed`
  and `escalated` (`holdsFiles: true` at `src/lib/phases.ts:137`, `:131`) and `filesOverlap` is the
  same prefix test (`src/lib/gating.ts:19-21`); both are already exported and `gating.ts` imports
  only `./phases` and `./types`, so `tick.ts` gains no cycle. Confirmed by a clean `tsc`.
- **`buildDigest`'s byte-identity claim holds.** With `footer` absent or `''`, the new
  `tail.flatMap` form produces output identical to today's fixed-slot join, including the
  `eventLines: []` / `nextPrompt: ''` corner. The three untouched literals at
  `test/deliver.test.ts:34`, `:47`, `:124` compile and pass unedited, as **A15** requires.
- **`main.ts` narrows correctly.** `if (line.event === 'agent:blocked' && line.task?.pane_id)`
  narrows `line.task` to non-null and `pane_id` to `string` — no cast needed under `strict` +
  `noUncheckedIndexedAccess`.
- **The hoist is call-count-neutral and in scope.** `const hpipe` moves from `main.ts:239` to above
  the run loop, inside the same `for(;;)` `try`, and `stallAwaiting(c.run, c.task, hpipe)` at `:249`
  still resolves.
- **Step 10's red is real.** `test/prompts.test.ts:12` currently hand-lists `'digest'`; removing it
  makes `no orphan prompt files` (`:21-24`) fail naming `digest`, and `git rm prompts/digest.md`
  clears it. Nothing else in `src/` or `test/` references the file.
- **Step 4's and step 7's "verify it bites" instructions are correct** — both guards pass on first
  run, and the described mutations do turn them red.
- **Scope.** Files touched are exactly the seven the plan declares; none is on the ruling's
  do-not-touch list. Step 12's PR-body carry-overs match §Non-goals and the Scope ruling.

---

Two MAJORs, three MINORs. Both MAJORs are "write the test the spec already specified" — neither
reverses a decision, changes scope, nor needs a human judgment. Fix all five inline and proceed.

VERDICT: CLEAR
