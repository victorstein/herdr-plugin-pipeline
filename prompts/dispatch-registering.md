**Still registering?** Every new task is backed by a bead — run `{{hpipe}} next` and adopt one where
it fits:

    {{hpipe}} task --branch <branch> --bead <id> --surface <surface> \
               [--tier light|standard|heavy] \
               [--depends-on <id,id>] [--files <prefix,prefix>] \
               [--notes "<batch context that does not belong in the bead>"]

or let `--title "<title>" --body-file <path> [--acceptance-file <path>]` in place of `--bead <id>`
file one with that brief and register it in one step. There is no `--text` flag: whatever the worker
needs goes in the bead's brief. Never run `bd` or `bv` yourself. Never run two agents against the
same files in parallel — serialize them with `--files`, or with `--depends-on` when one needs the
other's result. The picks `{{hpipe}} next` lists under `now` can run in parallel, but bv and Beads
know nothing about files.

**When the last task is registered:**

    {{hpipe}} dispatch --done

Nothing infers that the batch is complete, and the run cannot finish until you say so.
