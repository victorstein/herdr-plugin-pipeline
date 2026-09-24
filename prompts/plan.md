# Write the implementation plan — {{branch}} (#{{issue}})

The spec at `{{spec_path}}` cleared review. Turn it into an implementation plan.

Write it to exactly this path:

    {{plan_path}}

Bite-sized steps, two to five minutes each, TDD throughout: write the failing test, run it, implement
the minimum, run it again, commit. Exact file paths. Complete code in every step — no placeholders,
no "similar to step N", no "add appropriate error handling". Every step leaves the tree working and
committable.

Assume the implementer has no context for this codebase beyond `{{spec_path}}` and this plan. You are
that implementer, several phases from now, with your reasoning gone.

Declare every file any step creates, edits or deletes — tests and docs included — on `FILES:` lines
at the start of a line, outside any code block, comma-separated, one line or several. Each entry is a
repo-relative file path or a directory prefix ending in `/` — no globs, no absolute paths. A glob is
cut at its first wildcard, so `**/*.ts` locks the whole repository:

    FILES: src/lib/gating.ts, test/gating.test.ts
    FILES: docs/runbook.md

The pipeline adds these to the task's file lock before implementation starts and holds this task
back while a sibling is working on any of them. A file you edit without declaring it is one a
sibling can edit at the same time.

If you are back here from a `BLOCKER` verdict (pass {{pass}}), the review is the newest file for this
issue under `docs/superpowers/reviews/`. Fix every BLOCKER and every MAJOR you accept before
rewriting anything else.

Commit and push the plan, then stop.
