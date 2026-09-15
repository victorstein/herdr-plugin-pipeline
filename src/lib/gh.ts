import type { CiBucket } from './types'

export interface CheckRow { bucket: string }

export interface PrView {
  merged: boolean
  mergedAtMs: number | null
  headSha: string | null
}

export interface IssueView {
  closed: boolean
  closedAtMs: number | null
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
  private async run(args: string[]): Promise<{ code: number; text: string }> {
    try {
      const proc = Bun.spawn([this.bin, ...args], { cwd: this.cwd, stdout: 'pipe', stderr: 'pipe' })
      const text = await new Response(proc.stdout).text()
      const code = await proc.exited
      return { code, text }
    } catch (error) {
      return { code: -1, text: String(error) }
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

  /** Exit 8 means "checks pending" — a normal state, not an error. */
  async prChecks(pr: number): Promise<CiBucket> {
    const rows = await this.json<CheckRow[]>(
      ['pr', 'checks', String(pr), '--json', 'bucket,name,state,link'],
      [0, 8],
    )
    if (rows === null) return 'unknown'
    return rollUpBucket(rows)
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
    const view = await this.json<{ state: string; mergedAt: string | null; headRefOid: string | null }>(
      ['pr', 'view', String(pr), '--json', 'state,mergedAt,headRefOid'],
    )
    if (!view) return null
    return {
      merged: view.state === 'MERGED',
      mergedAtMs: view.mergedAt ? Date.parse(view.mergedAt) : null,
      headSha: view.headRefOid,
    }
  }

  async issueView(issue: number): Promise<IssueView | null> {
    const view = await this.json<{ closed: boolean; closedAt: string | null }>(
      ['issue', 'view', String(issue), '--json', 'closed,closedAt'],
    )
    if (!view) return null
    return { closed: view.closed, closedAtMs: view.closedAt ? Date.parse(view.closedAt) : null }
  }
}
