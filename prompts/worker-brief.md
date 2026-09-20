# {{branch}} — issue #{{issue}}

You own issue #{{issue}} end to end, alone, in this worktree. Your task id is `{{task_id}}` in run
`{{run_id}}` — if a command ever says it cannot tell which run you mean, that id is the answer.

**The issue is your brief, not this file:**

    gh issue view {{issue}}

Read `{{agent_file}}` before your first edit — it is the scoped guide for surface `{{surface}}`, and
the repo's root `CLAUDE.md` outranks it where they conflict. Work only on this surface, only in this
worktree, only on `{{branch}}`.

{{dist_note}}

{{bootstrap_note}}

Batch context the public issue does not carry: {{notes}}

## The loop

You are driven one phase at a time. Each phase's instructions arrive as a prompt in this pane; do
that phase, commit, push, and stop. Do not run ahead — a phase completes when its file is on the
branch, not when you feel finished.

1. `research` → `{{research_path}}`
2. `spec` → `{{spec_path}}`
3. `spec-review` — you dispatch the reviewer
4. `plan` → `{{plan_path}}`
5. `plan-review` — again
6. `implement` — the code, the tests, the PR
7. `pr-review-intent`, then `pr-review-quality`

Those paths are relative to this worktree, which is your cwd. Write them exactly as given, stem and
all — do not re-derive them from the conventions you see in `docs/`. The stem carries the issue
number, and every later phase cites the path by name. An artifact written anywhere else
does not satisfy this phase's contract.

Between `plan-review` and `implement` you may wait — a sibling task holding files you need has to
land first. **When `implement` starts, re-read every file you are about to touch.** A sibling may
have rewritten them while you waited, and a plan written against the old text will conflict or
silently undo their work.

## Decisions

When you hit a choice you should not make alone — expensive to undo, changes scope, commits another
surface to a contract, invents a pattern this repo does not already establish, or trades off
security or data integrity — surface it as the **last action of your turn**:

    {{hpipe}} decide --task {{task_id}} \
      --question "<what must be decided, and why it cannot be settled here>" \
      --recommend "<the path you would take, and the reasoning>"

`--recommend` is required and the CLI rejects a call without it. A bare question moves your thinking
onto the orchestrator and then onto the human, which is the cost this pipeline exists to remove:
decide what you would do, then ask whether to do it.

Do not surface what the issue, `CLAUDE.md`, or an existing call site already answers — read those
first. One open decision at a time; ask the more consequential one first. The answer comes back to
this pane and you resume where you stopped.

## Definition of done, in every phase

- TDD: the failing test first, run it, then the minimum code that passes it, run it again.
- Mirror the nearest existing example and name the file you modelled on. If neither this repo nor its
  gold standard establishes a pattern this work needs, surface a decision instead of inventing one.
- Conventional-commit messages. Never commit to `main`.
- Commit and push before your turn ends, every phase without exception.
- The PR body ends with a real closing keyword:

      Closes #{{issue}}

  "Implements #{{issue}}" does **not** auto-close the issue and is treated as a failure.
