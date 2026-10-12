# Ship — run {{run_id}}: one PR from `{{batch}}` into `{{into}}`

Every task that landed is on `{{batch}}`. It ships as one PR, and CI runs once, on that PR.

1. **Check the combined tree.** This is the one local run of every landing together, and it catches
   what no single task could. Bring the batch checkout up to date:

{{checkout_steps}}

   then, from anywhere in this repo:

       {{hpipe}} batch-check

   {{check_sentence}} This phase clears only once the PR's head is the one it recorded, so run it again
   after any push to `{{batch}}`. If it is red, dispatch a subagent with `model: {{implement_model}}` to fix it in the
   checkout and **wait for it within this turn**; verify, commit, push, and run `batch-check` again.
2. **Bring `{{into}}` in only if it conflicts.** If `origin/{{into}}` has moved and
   `git -C {{checkout_quoted}} merge-tree --write-tree origin/{{into}} origin/{{batch}}` reports conflicts,
   merge `origin/{{into}}` into the batch checkout, resolve, push, and run `batch-check` again.
3. **Open the PR, or update it:**

       {{pr_command}}

   The body is the plugin's, at `{{body_path}}`: one release-note line per landing, between
   `BEGIN_COMMIT_OVERRIDE` and `END_COMMIT_OVERRIDE`. Leave that block alone; a fix that deserves a line
   of its own goes through a fix task, whose title then lands in it. The title only has to pass PR-title
   lint: release-please reads the override block instead.

Never force-push, rebase or squash `{{batch}}`: its history is every landing's record.
