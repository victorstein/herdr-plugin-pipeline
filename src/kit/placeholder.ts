import { MOCHA } from './palette'

const fg = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return `\x1b[38;2;${n >> 16};${(n >> 8) & 255};${n & 255}m`
}
const title = process.env.KIT_TITLE ?? 'this agent'
const stage = process.env.KIT_STAGE ?? 'board'
process.stdout.write(`\x1b[2J\x1b[H\n  ${fg(MOCHA.mauve)}✻\x1b[0m ${title}\n  ${fg(MOCHA.overlay1)}is on the ${stage} stage\x1b[0m\n`)
setInterval(() => {}, 1 << 30)
