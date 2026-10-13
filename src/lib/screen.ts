/** How many lines of a pane the supervisor reads: enough for a Claude input box and what sits above it. */
export const SCREEN_LINES = 40

const PLAIN_RULE = /^─{10,}$/
/**
 * A session named with `/rename` carries its name in the box's TOP rule —
 * `──── PR#132 review ─`, truncated with `…` in a narrow pane — leaving as few as
 * two dashes before it. Only ever accepted as the top rule of a box whose first
 * line is `❯` and whose bottom rule is plain: transcript text can start with
 * `── ` too.
 */
const LABELLED_TOP_RULE = /^─{2,} \S.*$/

/**
 * The text in a Claude input box — the `❯` line and any continuation lines between
 * the two horizontal rules that frame it — or `null` when the screen shows no box
 * this recognises, which callers must read as "do not touch". The last framed box
 * wins; Claude's rewind menu also draws `❯`, but indented and unframed.
 */
export function inputBoxText(screen: string): string | null {
  const lines = screen.split('\n')
  const bounds = inputBoxBounds(lines)
  if (bounds === null) return null
  return lines.slice(bounds.open + 1, bounds.close)
    .map((line, i) => (i === 0 ? line.slice(1) : line)).join('\n').trim()
}

/** The line indexes of the last framed input box's top and bottom rules. */
export function inputBoxBounds(lines: readonly string[]): { open: number; close: number } | null {
  const isTopRule = (line: string) => PLAIN_RULE.test(line) || LABELLED_TOP_RULE.test(line)
  for (let close = lines.length - 1; close > 0; close--) {
    if (!PLAIN_RULE.test((lines[close] ?? '').trim())) continue
    let open = close - 1
    while (open >= 0 && !isTopRule((lines[open] ?? '').trim())) open--
    if (open < 0) return null
    if (!(lines[open + 1] ?? '').startsWith('❯')) continue
    return { open, close }
  }
  return null
}

const TERMINAL_ESCAPE = /\x1b(?:\[([0-9;:?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

/** SGR parameters after which a colour index or RGB triple follows, not a style. */
const EXTENDED_COLOUR = new Set([38, 48, 58])

function faintAfter(params: string, faint: boolean): boolean {
  const codes = params === '' ? [0] : params.split(';').map(Number)
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i]
    if (code !== undefined && EXTENDED_COLOUR.has(code)) {
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 1
    } else if (code === 0 || code === 22) {
      faint = false
    } else if (code === 2) {
      faint = true
    }
  }
  return faint
}

/**
 * The screen as text, minus everything drawn faint. Claude draws its prompt
 * suggestion inside the input box in faint text, and a plain-text read cannot
 * tell it from a human's draft — every idle box would read as stuck. Measured
 * against Claude Code in a live herdr 0.9.0 session.
 */
export function withoutFaintText(styled: string): string {
  let faint = false
  let text = ''
  let from = 0
  const visible = (segment: string) => (faint ? keptWhenFaint(segment) : segment)
  for (const escape of styled.matchAll(TERMINAL_ESCAPE)) {
    text += visible(styled.slice(from, escape.index))
    from = escape.index + escape[0].length
    if (escape[2] === 'm') faint = faintAfter(escape[1] ?? '', faint)
  }
  text += visible(styled.slice(from))
  return text.replace(/\r/g, '')
}

/**
 * A paste placeholder is someone's input whatever it is drawn in: dropped with
 * the suggestion, a stuck paste would read as an empty box and the next send
 * would be appended to it.
 */
function keptWhenFaint(segment: string): string {
  return (segment.match(PASTE_PLACEHOLDER) ?? []).join(' ')
}

/**
 * The screen as text with every escape sequence removed and nothing else: faint
 * text kept. Claude draws the usage-limit line's `⎿` dim, and `withoutFaintText`
 * would drop the anchor that tells the real line from a quoted copy.
 */
export function withoutEscapes(styled: string): string {
  return styled.replace(TERMINAL_ESCAPE, '').replace(/\r/g, '')
}

/** How a long paste collapses in a Claude input box, measured live: `[Pasted text #1 +40 lines]`. */
export const PASTE_PLACEHOLDER = /\[Pasted text #\d+[^\]]*\]/g
