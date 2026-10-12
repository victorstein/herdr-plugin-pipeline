import type { CiBucket } from './types'

export interface CheckRow { bucket: string }

export interface PrView {
  merged: boolean
  mergedAtMs: number | null
  /** The commit the merge put on the base branch; null until merged. */
  mergeCommit?: string | null
  headSha: string | null
}

export interface HeadCi {
  bucket: CiBucket
  /** The commit the bucket was read for: a result is only ever about one head. */
  headSha: string
}

interface RollupRow { __typename?: string; status?: string; conclusion?: string; state?: string }

/** One entry of a commit's status rollup, bucketed the way `gh pr checks` buckets it. */
function rollupBucket(row: RollupRow): string {
  if (row.__typename === 'StatusContext') {
    if (row.state === 'SUCCESS') return 'pass'
    return row.state === 'FAILURE' || row.state === 'ERROR' ? 'fail' : 'pending'
  }
  if (row.status !== 'COMPLETED') return 'pending'
  switch (row.conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL': return 'pass'
    case 'SKIPPED': return 'skipping'
    case 'CANCELLED': return 'cancel'
    default: return 'fail'
  }
}

export function rollUpBucket(rows: CheckRow[]): CiBucket {
  if (rows.length === 0) return 'pending'
  if (rows.some((r) => r.bucket === 'fail')) return 'fail'
  if (rows.some((r) => r.bucket === 'cancel')) return 'fail'
  if (rows.some((r) => r.bucket === 'pending')) return 'pending'
  return 'pass'
}

export class Gh {
  constructor(
    private readonly bin: string = process.env.GH_BIN ?? 'gh',
    private readonly cwd: string = process.cwd(),
  ) {}

  // Bun.spawn throws synchronously on a missing binary or a cwd that doesn't
  // exist. Callers rely on these methods never throwing, so a spawn failure
  // must degrade to a non-ok result rather than crash the supervisor loop.
  private async run(args: string[]): Promise<{ code: number; text: string; stderr: string }> {
    try {
      const proc = Bun.spawn([this.bin, ...args], { cwd: this.cwd, stdout: 'pipe', stderr: 'pipe' })
      // Drained together: reading one pipe to the end first can deadlock gh on a full other one.
      const [text, stderr] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ])
      const code = await proc.exited
      return { code, text, stderr }
    } catch (error) {
      return { code: -1, text: '', stderr: String(error) }
    }
  }

  private async json<T>(args: string[], okCodes: number[] = [0]): Promise<T | null> {
    const { code, text } = await this.run(args)
    if (!okCodes.includes(code)) return null
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  async prForBranch(branch: string): Promise<number | null> {
    const rows = await this.json<{ number: number }[]>(
      ['pr', 'list', '--head', branch, '--json', 'number', '--limit', '1'],
    )
    return rows?.[0]?.number ?? null
  }

  /**
   * The head's rollup and its workflow runs come from the same head sha, so a push
   * between the calls cannot pair one commit's checks with another's. A run still
   * queued has no check of its own yet: `gh pr checks` listed only an older finished
   * check and called the head green. Measured on a live run (#16).
   */
  async headCi(pr: number): Promise<HeadCi | null> {
    const view = await this.json<{ headRefOid: string | null; statusCheckRollup: RollupRow[] | null }>(
      ['pr', 'view', String(pr), '--json', 'headRefOid,statusCheckRollup'],
    )
    if (!view?.headRefOid) return null
    const runs = await this.json<{ status: string }[]>(
      ['run', 'list', '--commit', view.headRefOid, '--json', 'status,conclusion', '--limit', '100'],
    )
    if (runs === null) return null
    const rows = [
      ...(view.statusCheckRollup ?? []).map((row) => ({ bucket: rollupBucket(row) })),
      ...runs.filter((run) => run.status !== 'completed').map(() => ({ bucket: 'pending' })),
    ]
    return { bucket: rollUpBucket(rows), headSha: view.headRefOid }
  }

  /** A batch PR must be squash-merged for its override block to apply, so a run that cannot is refused at start. */
  async squashMergeAllowed(): Promise<{ allowed: boolean } | { error: string }> {
    const { code, text, stderr } = await this.run(['repo', 'view', '--json', 'squashMergeAllowed'])
    if (code !== 0) return { error: stderr.trim() || `gh exited ${code}` }
    try {
      return { allowed: (JSON.parse(text) as { squashMergeAllowed?: boolean }).squashMergeAllowed === true }
    } catch {
      return { error: `gh repo view printed no JSON: ${text.trim()}` }
    }
  }

  async prChecksDetail(pr: number): Promise<string> {
    const rows = await this.json<{ bucket: string; name: string; link?: string }[]>(
      ['pr', 'checks', String(pr), '--json', 'bucket,name,state,link'],
      [0, 8],
    )
    return (rows ?? [])
      .filter((r) => r.bucket === 'fail' || r.bucket === 'cancel')
      .map((r) => `- ${r.name} (${r.bucket})${r.link ? ` ${r.link}` : ''}`)
      .join('\n')
  }

  async prView(pr: number): Promise<PrView | null> {
    const view = await this.json<{
      state: string; mergedAt: string | null; mergeCommit: { oid: string } | null; headRefOid: string | null
    }>(
      ['pr', 'view', String(pr), '--json', 'state,mergedAt,mergeCommit,headRefOid'],
    )
    if (!view) return null
    return {
      merged: view.state === 'MERGED',
      mergedAtMs: view.mergedAt ? Date.parse(view.mergedAt) : null,
      mergeCommit: view.mergeCommit?.oid ?? null,
      headSha: view.headRefOid,
    }
  }
}
