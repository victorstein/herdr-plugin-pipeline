---
name: plugin-dev
description: Scoped guide for work on the herdr-plugin-pipeline plugin itself — the hpipe CLI, the supervisor, the phase machine, and the prompt templates.
---

# Surface `plugin`

This repo is one small Bun/TypeScript package with no runtime dependencies. There is a single
surface, so you own whatever the issue touches — `--files` on the task, not the surface, is what
keeps you off a sibling's files.

## The shape of it

- `src/cli.ts` — every `hpipe` subcommand, argv parsing, and the task/run constructors.
- `src/lib/` — the pure core. `phases.ts` is the phase table (`RUN_ROWS`, `TASK_ROWS`) and is the
  spine: a phase's actor, signal, artifact, successor and stallability all live in one row.
  `machine.ts`, `predicates.ts`, `gating.ts`, `status.ts`, `render.ts`, `store.ts`, `ledger.ts`.
- `src/supervisor/` — the single long-lived driver: `tick.ts` evaluates, `deliver.ts` sends,
  `stall.ts` probes, `tasks.ts` stats artifacts.
- `src/hooks/`, `src/actions/` — thin herdr entry points. Hooks only enqueue; they must never block.
- `prompts/*.md` — the text agents actually receive, rendered by `render()` with `{{var}}` tokens.
- `test/` — `bun test`, one file per lib module, plus `test/integration/smoke.md`, a hand-run live
  runbook the unit suite cannot replace.

## Conventions that are not negotiable

- **`bun test` and `bun run typecheck` both green before you push.** There is no build step.
- **`render()` throws on an unresolved `{{placeholder}}`** (`src/lib/render.ts:11`), at delivery
  time, in front of an agent. Adding a token to a prompt means adding it at every render site;
  `test/prompts.test.ts` guards the declared prompt set and the review-trailer contract, and it will
  fail you for an orphan or missing prompt file.
- **Comments in this repo carry the *why* only**, and several end in `Measured on a live run.`
  because they record something a live run taught us. Match that. Do not add a comment that
  restates the line below it.
- **Conventional PR titles.** PRs are squash-merged and release-please parses the title — see
  `.claude/skills/conventional-pr-titles/SKILL.md`. A non-conventional title silently ships no
  release.
- Never commit to `main`.

## The self-hosting hazard

You are changing the pipeline that is driving you. The installed plugin is a **GitHub install pinned
to a tag**, not a link to this checkout, so your edits do not touch the supervisor mid-run — but
that is exactly why it holds:

- **Never link `src/cli.ts` onto your PATH, and never run the checkout's `src/cli.ts` directly**
  against live state. `bin/hpipe` asks herdr which copy is installed at call time for a reason: the
  CLI and the supervisor share one ledger, and a checkout writing a drifted schema into it either
  throws inside the supervisor pane or makes the run silently invisible.
- A change to `phases.ts` or to `schema_version` is a change to the format of runs already on disk.
  Say so in your spec.

## Where the behaviour is actually proven

Unit tests use dependency-injected fakes and have passed clean over real defects twice — the first
live run of the previous design found two startup/gating bugs the suite was happy with. If your
change touches startup, gating, delivery or pane I/O, say in your plan how it would be verified
against a real herdr session, and treat a difference between the runbook and what you observe as a
finding rather than a test to make pass.
