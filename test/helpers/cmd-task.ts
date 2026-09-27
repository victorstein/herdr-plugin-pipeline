import { cmdTask as cmdTaskReadingRealLabels } from '../../src/cli'

type CmdTaskArgs = Parameters<typeof cmdTaskReadingRealLabels>

/**
 * Registration reads an issue's labels through `gh`; a call here with no fifth
 * argument defaults that read to an empty list instead of the real `cmdTask`
 * default, which would shell out to `gh` in a temp dir that is not a GitHub
 * repo. Only the tests that exercise the label read pass their own.
 */
export function cmdTask(
  ctx: CmdTaskArgs[0], input: CmdTaskArgs[1], fileIssue?: CmdTaskArgs[2], dispatchBase?: CmdTaskArgs[3],
  readLabels: CmdTaskArgs[4] = async () => [],
): ReturnType<typeof cmdTaskReadingRealLabels> {
  return cmdTaskReadingRealLabels(ctx, input, fileIssue, dispatchBase, readLabels)
}
