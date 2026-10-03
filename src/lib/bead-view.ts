import type { BeadDetail } from './bd'
import { RUN_METADATA_KEY } from './bead-desired'

const orNone = (text: string | undefined): string => (text === undefined || text.trim() === '' ? '(none)' : text.trim())

export function formatBeadDetail(bead: BeadDetail): string {
  const labels = bead.labels ?? []
  const comments = bead.comments ?? []
  const runId = bead.metadata?.[RUN_METADATA_KEY]
  return [
    `${bead.id} [${bead.status}] ${bead.title}`,
    `labels:     ${labels.length > 0 ? labels.join(', ') : 'none'}`,
    `assignee:   ${bead.assignee || 'none'}`,
    ...(typeof runId === 'string' ? [`run:        ${runId}`] : []),
    '',
    'description:',
    orNone(bead.description),
    '',
    'acceptance:',
    orNone(bead.acceptance_criteria),
    '',
    comments.length === 0 ? 'comments: none' : 'comments:',
    ...comments.map((comment) => `- ${comment.text.trim().replace(/\n/g, '\n  ')}`),
  ].join('\n')
}
