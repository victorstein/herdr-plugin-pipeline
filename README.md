# herdr-plugin-pipeline

Drives a software pipeline across herdr worktrees, with the design work pushed down to the agent that
has actually read the code.

One **worker** agent owns each GitHub issue end to end: research → spec → adversarial review → plan →
adversarial review → implement → two PR reviews → CI → merge → close → teardown. The **orchestrator**
keeps intake (research the problem, file the issue, dispatch), decision triage, merge, close, and the
whole-branch review at the end.

Workers surface **decisions, not drafts**. When one hits a choice it should not make alone, it calls
`hpipe decide` with a question *and a recommendation*; the orchestrator answers what it can from the
issue or the existing code, and escalates the rest to you with a recommendation already formed.

Event hooks only enqueue. One supervisor pane per herdr session owns all timing, evaluation, and
delivery, prompting each agent with its next instruction just in time — so the pipeline never has to
live in any agent's context, and fleet width scales with worker count rather than with one context
window.

## Install

From GitHub:

    herdr plugin install victorstein/herdr-plugin-pipeline

or, for local development:

    herdr plugin link /path/to/herdr-plugin-pipeline

Requires herdr 0.9.0+, bun, and gh. No build step, and no runtime dependencies —
`@types/bun` and `typescript` are devDependencies for `bun run typecheck` only.

**You do not need `hpipe` on your PATH.** herdr's manifest has no way to install a binary, so every
prompt renders the CLI invocation instead: `bun run <plugin-root>/src/cli.ts …` when the plugin was
installed from GitHub, and plain `hpipe` when a symlink on your PATH resolves back into this same
checkout. If you want the short form for your own typing:

    ln -s /path/to/herdr-plugin-pipeline/src/cli.ts ~/.local/bin/hpipe

That is a convenience, not a requirement — and a symlink pointing at a *different* checkout is
ignored deliberately, so agents are never aimed at another copy's ledger.

**Then restart the herdr session you want it in.** Linking registers the plugin globally for your
user, but its startup hook only runs when a server boots — so on an already-running session nothing
happens until you restart it. If `hpipe status` reports no supervisor and no `pipeline` workspace
appeared, that is why. (`herdr server reload-config` does not trigger it either.)

**Run `hpipe` from inside a pane of the session you mean.** Outside one, it silently falls back to
the `default` session's ledger.

## Use

From the orchestrator's pane:

    hpipe start "chat meter"

The orchestrator is then prompted to research the work, open one GitHub issue per task — **the issue
body is the brief** — and register each with:

    hpipe task --branch <branch> --issue <n> --surface <surface> \
               [--depends-on <ids>] [--files <prefixes>] [--notes <batch context>]

When the batch is complete it closes intake with `hpipe dispatch --done`. Everything after that is
injected: each worker gets its brief at dispatch and its next instruction as each phase completes.

`hpipe status` shows the fleet, every open decision, and anything waiting on you.

## Answering a decision

    hpipe answer --task <id> --decision <id> --answer "…" --by orchestrator|human

The answer is recorded immediately but the worker resumes **only once the answer has actually been
delivered** to its pane — a worker that is busy stays blocked, and `status` reports
"answered but undelivered" rather than pretending the decision was applied.

## Getting out

| | |
|---|---|
| Advanced early | `hpipe rewind <run> <phase> [--task <id>]` — clears retry counters, any undelivered answer, and (rewinding to `dispatch`) worktree adoption |
| A task is stuck behind a failed sibling holding its files | `hpipe release --task <id>` |
| Stop driving a run | `hpipe abort <run>` (undo with `hpipe resume`) |
| Supervisor dead | `hpipe status`, then the `supervisor` action |
| Orchestrator pane died or changed id | Run the `claim` action from the pane that should drive it; `hpipe status` flags this |
| A run from an older plugin version | It is refused, not migrated. `hpipe abort <id>` to release the repo |
| Plugin misbehaving | `herdr plugin disable stein.pipeline` |
| Out permanently | `herdr plugin unlink stein.pipeline`, then `rm ~/.local/bin/hpipe` |

Nothing the plugin owns is load-bearing for the work: runs are bookkeeping, and the artifacts are
files in your repo and objects on GitHub.

## Design

`docs/superpowers/specs/2026-09-15-worker-owned-pipeline-design.md` is current, with two adversarial
reviews in `docs/superpowers/reviews/`. It amends
`specs/2026-09-13-herdr-pipeline-plugin-design.md`, whose supervisor, hooks, event transport, queue,
session scoping and predicate rules still hold — **read that document's "Verified herdr facts" table
before changing anything that touches the herdr or gh CLIs.** Every row was measured, and several
correct-looking assumptions in earlier drafts turned out to be wrong.

Two rules in the current design exist because breaking them shipped real bugs, twice each:

- **Retry counters are monotone.** Every row that can send a record back to a producer carries a
  counter keyed by itself, and nothing resets it on forward progress. Two earlier drafts reset on a
  forward transition and each time deleted a bound — once the review loop, once the CI retry budget.
- **A phase advances on an edge, not a level.** Predicates compare against `phase_entered_at`, or
  against the event that should have caused them. A level predicate re-fires forever and makes
  `hpipe rewind` a no-op on the row it was offered as the escape for.

`test/integration/smoke.md` is the live runbook. Two things the unit suite cannot prove — per-pane
prompt fan-out, and whether a review subagent perturbs its worker pane's reported status — are
assertions in that runbook, not in `bun test`.

## License

MIT. See [LICENSE](./LICENSE).
