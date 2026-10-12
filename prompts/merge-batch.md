# Land {{branch}} ({{bead}}) on `{{batch}}`

{{review_count}}, and `{{land_sha8}}` is the head that was reviewed{{checked_note}}. It contains every
landing before it, so it lands as a fast-forward. Land it with exactly this command:

    {{land_command}}

- **Push this sha and no other.** Commits on `{{branch}}` after it were not reviewed or checked.
- **If the push is refused for any reason** — `rejected`, `fetch first`, `non-fast-forward`,
  `remote rejected` — end your turn. `{{batch}}` has moved, and the task goes back to `sync` once the
  supervisor's next fetch shows it. Never `git pull` in `{{repo_root}}`: it is the user's working copy.
- **Never force-push, rebase or squash `{{batch}}`.** Every later base and every landing check reads
  its ancestry.
- **Do not push to `{{branch}}` now.** Anything pushed there after its review sends the task back
  through `sync` and a review, so it lands reviewed and checked rather than not at all.

Landing is yours, not the plugin's; nothing lands automatically. Once it has landed, end your turn:
the supervisor sees it on its next fetch, closes {{bead}} and tears the worktree down. Nothing reaches
`{{into}}` until the batch PR merges.
