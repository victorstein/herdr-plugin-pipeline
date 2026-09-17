# Research — issue #9: hardcoded artifact paths make workers write artifacts the supervisor never sees

Established against this worktree at `6008bce` (branch `fix/9-artifact-paths`) and against the
berean-os checkout at `/Volumes/stein/Documents/development/personal/berean-os`. Every claim below
is either a `file:line` citation or a command whose output is quoted.

## Installed versions

    $ bun --version   → 1.3.14
    $ node --version  → v24.16.0
    $ herdr --version → herdr 0.9.0
    $ cat version.txt → 1.2.1

Dependencies are dev-only (`package.json:10-13`): `@types/bun@1.4.2`, `typescript@5.9.3` (resolved,
`bun.lock:14-21`). No runtime dependency is involved in this behaviour — the paths are built with
`node:path`'s `join` and read with `node:fs`'s `statSync`.

Baseline is green before any change:

    $ bun test      → 351 pass, 0 fail, 767 expect() calls, 33 files
    $ bun run typecheck → tsc --noEmit, no output

## Which files own the behaviour

| File | Line(s) | Role |
|---|---|---|
| `src/cli.ts` | 88-92 | Mints the three task artifact paths from a hardcoded stem |
| `src/lib/worker-prompt.ts` | 23-25 | Renders those paths into the worker brief **relative** |
| `src/supervisor/tasks.ts` | 92-95, 47 | Renders them into every later phase prompt **absolute** |
| `src/supervisor/deliver.ts` | 90, 93, 97-101 | Same for review verdicts; `docs/superpowers/reviews` hardcoded |
| `src/supervisor/tasks.ts` | 202-210 | The stat that gates the phase |
| `src/lib/predicates.ts` | 10-20, 27 | `isFresh` / `isSettled` — the stat itself |
| `src/supervisor/main.ts` | 256-266 | Task stall probe; names no path |
| `prompts/worker-brief.md` | "The loop" section | The instruction the issue quotes |
| `test/cli-commands.test.ts` | 171-175 | Pins the current hardcoded layout |

`src/cli.ts:88-92`, verbatim:

```ts
    artifacts: {
      research: join('docs/superpowers/research', `${stem}-research.md`),
      spec: join('docs/superpowers/specs', `${stem}-design.md`),
      plan: join('docs/superpowers/plans', `${stem}-plan.md`),
```

with `stem = ${date}-issue-${input.issue}` (`src/cli.ts:76-77`). Introduced by `6d3b840`
*"feat: move design work into per-issue worker agents (#4)"*, 2026-09-16.

## Current control flow

1. `hpipe task` builds `task.artifacts` from the hardcoded stems (`src/cli.ts:88-92`) with
   `checkout_path: null` (`src/cli.ts:87`).
2. It immediately moves the task `queued → research` (`src/cli.ts:122`) and renders the brief
   (`src/cli.ts:125`).
3. `renderWorkerPrompt` passes the **raw relative** strings as `research_path` / `spec_path` /
   `plan_path` (`src/lib/worker-prompt.ts:23-25`) and returns the brief with `prompts/research.md`
   already appended (`src/lib/worker-prompt.ts:34-36`).
4. Every **later** phase prompt goes through `promptForTaskPhase`, which renders the same three vars
   **absolute** via `taskArtifactPath` → `join(task.checkout_path ?? run.repo_root, rel)`
   (`src/supervisor/tasks.ts:92-95`), and `verdict_path` absolute via `absoluteArtifactPath`
   (`src/supervisor/tasks.ts:47`, `src/supervisor/deliver.ts:97-101`).
5. The phase clears only if `isFresh` **and** `isSettled` pass on the absolute path
   (`src/supervisor/tasks.ts:202-210`). `isFresh` is a `statSync` in a `try`, returning `false` on
   throw (`src/lib/predicates.ts:10-20`) — a missing file is indistinguishable from a stale one.
6. No branch anywhere reports the absent path. `gatherSignals` returns `base` unchanged and the tick
   moves on.

### The asymmetry that actually explains the failure

`promptForTaskPhase` is only reached after `advanceTask` has changed the phase
(`src/supervisor/tasks.ts:165-167`, guarded by `if (task.phase === cameFrom) continue`). The
`queued → research` transition takes the other branch and `continue`s
(`src/supervisor/tasks.ts:135-146`), and the `research` row has **no `onBlocker`**
(`src/lib/phases.ts:92-93`), so no task ever re-enters `research`.

**`research` is therefore the only phase whose artifact path reaches the worker as a bare relative
string, exactly once, embedded in a long brief. `spec`, `plan` and all four review rows arrive later
as absolute paths.**

The brief cannot simply be made absolute today: `checkout_path` is only ever written from a herdr
worktree hook (`src/supervisor/tick.ts:40`, fed by `src/hooks/_hook.ts:56`), which fires long after
`hpipe task` has rendered and returned the brief. At render time the absolute path is genuinely
unknowable.

## Evidence from the berean-os run of 2026-09-16

The repo layout **before** the run (`git ls-tree --name-only 305fe51a docs/superpowers/`, the last
commit before 2026-09-16):

    docs/superpowers/notes
    docs/superpowers/plans
    docs/superpowers/specs

So **neither `research/` nor `reviews/` existed.** Both were created by the run itself; every one of
the 6 files now in `research/` and the first file in `reviews/` was added on 2026-09-16.

Every rename in the entire history of `docs/superpowers/` in that repo
(`git log --all --find-renames --diff-filter=R -- docs/superpowers/`):

    b90dbf1d docs: move issue 38 research to the path the supervisor stats
      R100  docs/superpowers/notes/qr-display-removal.md          → research/2026-09-16-issue-38-research.md
    2e014947 docs: move issue 28 research to the path the pipeline reads
      R100  docs/superpowers/notes/bookmark-save-reachability.md  → research/2026-09-16-issue-28-research.md
    2eca32c2 docs: move issue 27 research to the path the phase chain reads
      R100  docs/superpowers/notes/2026-09-16-atomic-store-saves.md → research/2026-09-16-issue-27-research.md

Three corrective renames. Nothing else in that tree was ever moved.

**Two corrections to the issue body, both of which change the shape of the fix:**

1. **It was three workers, not two.** Issue #9 names t5 (issue 27) and t2 (issue 28). Issue 38 also
   misfiled, to `notes/qr-display-removal.md`, and was moved by `b90dbf1d`. Tracing each of the six
   research artifacts to its first-added path: issues 27, 28 and 38 came from `notes/`; issues 30,
   31 and 37 were written correctly. **3 of 6 — a 50% failure rate, not 2 for 2.**

2. **"The directory does not exist" is not the cause.** `docs/superpowers/reviews/` did not exist
   before the run either, and is hardcoded in exactly the same way
   (`src/supervisor/deliver.ts:90,93`). **23 review files landed there, with zero renames.** Same
   missing directory, same hardcoded stem, opposite outcome. The variable that separates the two
   populations is relative-vs-absolute delivery, not directory existence — review paths arrive
   absolute via `absoluteArtifactPath` (`src/supervisor/tasks.ts:47`), research paths arrive
   relative (`src/lib/worker-prompt.ts:23`).

This repo is itself an instance of the mismatch: `ls docs/superpowers/` here returns `plans`,
`reviews`, `specs` — **no `research/`**. This note had to create the directory.

## The stall probe does not close the gap

`research` is `stallable: true` (`src/lib/phases.ts:93`), so a probe does fire once at
`TASK_STALL_MINUTES` (default 45, `src/lib/config.ts:27`; no `config.env` exists on this machine, so
defaults are live). But `src/supervisor/main.ts:262-264` substitutes a phrase for the path:

```ts
            artifact_path: taskRow(candidate.task.phase).signal === 'pr'
              ? `a PR for ${branch}`
              : `whatever clears ${candidate.task.phase} for ${branch}`,
```

`prompts/stall-probe.md` then renders *"nothing has appeared at: whatever clears research for
fix/... (#38)"* and closes with *"If you finished but wrote the file somewhere else, move it to the
path above"* — pointing at a phrase, not a path. The **run**-level probe twelve lines earlier does
call `absoluteArtifactPath` (`src/supervisor/main.ts:241`), so the machinery exists and is already
used; only the task branch discards it.

## Nearest existing example

**For failing fast against what the repo actually has: `src/cli.ts:71-74`.**

```ts
  const agentFile = join(run.repo_root, '.claude', 'agents', `${input.surface}-dev.md`)
  if (!existsSync(agentFile)) {
    return fail(`no agent definition at ${agentFile} — check --surface`)
  }
```

This is the only place the pipeline reads the target repo's own layout, and it is the established
shape: check at `hpipe task` time against `run.repo_root`, and `fail()` with the resolved path in
the message. `run.repo_root` is set at run creation (`src/lib/ledger.ts:29`) and is the main
checkout, which exists — so a derivation or validation step at registration time has a real
directory to look at, unlike the worktree.

**For making something configurable: `src/lib/config.ts`.** Note the constraint — `loadConfig` reads
`config.env` from `configDir`, which is `HERDR_PLUGIN_CONFIG_DIR` (`src/startup.ts:104`), a
**per-plugin, not per-repo** location. Nothing in `src/` reads any config file from `run.repo_root`;
the only repo-local file read at all is the agent definition above. A per-repo option as the issue's
first direction suggests would be a new mechanism, not an extension of an existing one.

## What a fix has to account for

- Four hardcoded stems, not three: `research`, `specs`, `plans` (`src/cli.ts:89-91`) and `reviews`
  (`src/supervisor/deliver.ts:90,93`). Only `research` mismatched either repo's prior convention;
  `specs` and `plans` matched berean-os and match here.
- `test/cli-commands.test.ts:171-175` asserts the current hardcoded layout and will need to change:

      expect(task.artifacts.research).toContain('docs/superpowers/research/')

- The brief is rendered before `checkout_path` exists (`src/cli.ts:87`, `src/supervisor/tick.ts:40`),
  so "just render it absolute" is not available at that point without a new delivery.
- `hpipe brief` (`src/cli.ts:134-141`) re-renders through the same `renderWorkerPrompt`, so anything
  fixed in the brief is fixed there too.
- A missing artifact is currently indistinguishable from a stale one at the stat
  (`src/lib/predicates.ts:10-20`); any "the artifact is absent" signal needs that distinction.

## Open question for the spec

The issue's first direction — derive the directory from what the repo has — and the evidence above
point in different directions. Derivation would have sent the berean-os workers to `notes/`, which
is where they went anyway; it would not have prevented the 23 review files from landing in a
`reviews/` directory that did not exist. The measured discriminator is how the path is delivered.
The spec should decide whether to fix the path, the delivery, the missing-artifact signal, or some
combination, and say which of the three the evidence supports.
