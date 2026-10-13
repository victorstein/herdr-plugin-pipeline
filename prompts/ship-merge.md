# Merge the batch PR — run {{run_id}}, PR #{{pr}}

{{ci_status}}Merge it with exactly these two commands:

    gh pr edit {{pr}} --body-file {{body_file}}
    gh pr merge {{pr}} --squash{{match_head}} --subject {{subject}} --body-file {{squash_body_file}}

- **The first replaces PR #{{pr}}'s whole description** with the plugin's body, so the override block
  is current. Anything you added to the description by hand is dropped: add it to `{{body_path}}`
  first, outside the override block. The plugin rewrites that file with every ship prompt, so add to
  it just before you run these.
- **A 5xx from `gh` is GitHub's, not yours:** run the same command again.
- **Squash, never a merge commit.** release-please reads the PR body's override block only for a
  squash merge; a merge commit makes it read the batch's commits one by one. Leave the block alone.
- **The squash commit carries the release lines itself:** its subject is the first landed title and
  its body holds the rest, one per line. So the release reads the same lines even if release-please
  never finds the PR body.
- **Green is for {{green_head}}.**{{pinned}} If anything is pushed to `{{batch}}` now, the run goes
  back to `ship-ci` and you are told again once the new head is green.

This is the last point at which a check a decision ruled "before merge" can still be done.

If GitHub refuses the merge: a required review means getting one, and "branches must be up to date"
means `gh pr update-branch {{pr}}`, which moves the head back through `ship-ci`. Until PR #{{pr}}
merges this run holds the repo, and no other `{{hpipe}} start` can begin here. Merging is yours, not
the plugin's; nothing merges automatically.
