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

**Then restart the herdr session you want it in.** Linking registers the plugin globally for your
user, but its startup hook only runs when a server boots — so on an already-running session nothing
happens until you restart it. If `hpipe status` reports no supervisor and no `pipeline` workspace
appeared, that is why. (`herdr server reload-config` does not trigger it either.)

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
| Orchestrator pane died or changed id | Run the `claim` action from the pane that should drive it; `hpipe status` flags this |
| Plugin misbehaving | `herdr plugin disable stein.pipeline` |
| Out permanently | `herdr plugin unlink stein.pipeline`, then `rm ~/.local/bin/hpipe` |

Nothing the plugin owns is load-bearing for the work: runs are bookkeeping, and the artifacts are
files in your repo and objects on GitHub.

## Design

`docs/superpowers/specs/2026-09-13-herdr-pipeline-plugin-design.md`, with three adversarial reviews
in `docs/superpowers/reviews/`. Read the "Verified herdr facts" table before changing anything that
touches the herdr or gh CLIs — every row was measured, and several correct-looking assumptions in
earlier drafts were wrong.

## License

MIT. See [LICENSE](./LICENSE).
