**Still registering?** Every new task is backed by an issue — file it with `gh issue create`, then:

    {{hpipe}} task --branch <branch> --issue <n> --surface <surface> \
               [--tier light|standard|heavy] \
               [--depends-on <id,id>] [--files <prefix,prefix>] \
               [--notes "<batch context that does not belong in a public issue>"]

or let `--title "<title>" --body-file <path>` in place of `--issue <n>` file it with that body and
register it in one step. There is no `--text` flag: whatever the worker needs goes in the issue body.
Never run two agents against the same files in parallel — serialize them with `--files`, or with
`--depends-on` when one needs the other's result.

**When the last task is registered:**

    {{hpipe}} dispatch --done

Nothing infers that the batch is complete, and the run cannot finish until you say so.
