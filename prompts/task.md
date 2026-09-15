# {{branch}} — issue #{{issue}}

You own this task end to end. Work only in this worktree, only on surface `{{surface}}`.

**Read `{{agent_file}}` first** — it is the scoped guide for this surface, and the repo's root
`CLAUDE.md` outranks it where they conflict.

{{dist_note}}

## The task

{{task_text}}

## Definition of done

- TDD: a failing test first, then the minimum code to pass it.
- Mirror the nearest existing example; name the file you modelled on in your first message.
- Conventional-commit messages on this branch. Never commit to `main`.
- Open a PR whose body ends with a real closing keyword:

      Closes #{{issue}}

  "Implements #{{issue}}" does **not** auto-close the issue and will be treated as a failure.

If neither this repo nor the gold standard establishes a pattern this work needs, stop and escalate
rather than inventing one.
