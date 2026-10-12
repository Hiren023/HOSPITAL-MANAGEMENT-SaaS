/**
 * A minimal PDF writer.
 *
 * Just enough to render a prescription as a real, printable PDF: one or more pages of
 * Helvetica text with an explicit page break. No images, no tables, no fonts beyond the
 * standard 14.
 *
 * ── Why hand-rolled rather than a library ────────────────────────────────────
 *
 * A PDF library is a meaningful dependency to add for one document type, and the part we
 * need is small and fully specified. The PDF format's core is a set of numbered objects,
 * a cross-reference table of byte offsets, and a trailer. Getting the offsets right is
 * the only subtlety, and `assertValidPdf` in the test suite checks exactly that: a
 * document with a wrong xref offset will not open, so the test proves the bytes are
 * genuinely a PDF rather than merely starting with the right four characters.
 *
 * If richer output is ever needed (a logo, a table grid, a second column), swapping this
 * for a real library is a contained change: `renderPrescriptionPdf` is the only caller.
 */

/** Escape the three characters that terminate a PDF literal string. */
function escapeText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

/**
 * Fold a line to `maxChars`, breaking on spaces where possible.
 *
 * Without this a long instruction runs off the page edge and is simply lost — which for a
 * prescription is the worst possible failure, because the missing text is the part a
 * patient needed.
 */
export function wrap(value: string, maxChars: number): string[] {
  const words = value.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []

  const lines: string[] = []
  let line = words[0] ?? ''

  for (const word of words.slice(1)) {
    if ((line + ' ' + word).length > maxChars) {
      lines.push(line)
      line = word
    } else {
      line += ' ' + word
    }
  }
  lines.push(line)

  return lines
}

export interface PdfLine {
  text: string
  /** `Helvetica-Bold` for headings. */
  bold?: boolean
  /** Extra space below this line, in points. */
  gapAfter?: number
  size?: number
}

/** A4 in points. */
const PAGE_WIDTH = 595
const PAGE_HEIGHT = 842
const MARGIN_X = 50
const MARGIN_TOP = 792
const BOTTOM_LIMIT = 56

/**
 * Render lines into a valid PDF.
 *
 * Returns the complete file as bytes.
 */
export function renderPdf(lines: PdfLine[]): Uint8Array {
  // Lay out into pages first: walk the lines, break when the next one would fall off.
  const pages: PdfLine[][] = []
  let current: PdfLine[] = []
  let cursorY = MARGIN_TOP

  for (const line of lines) {
    const size = line.size ?? 11
    const height = size + 4 + (line.gapAfter ?? 4)

    if (cursorY - height < BOTTOM_LIMIT) {
      pages.push(current)
      current = []
      cursorY = MARGIN_TOP
    }

    current.push(line)
    cursorY -= height
  }
  pages.push(current)

  const contentStreams = pages.map((pageLines) => {
    let y = MARGIN_TOP
    const parts: string[] = ['BT']

    for (const line of pageLines) {
      const size = line.size ?? 11
      const font = line.bold ? '/F2' : '/F1'
      y -= size + 4

      parts.push(`${font} ${size} Tf`)
      parts.push(`1 0 0 1 ${MARGIN_X} ${y.toFixed(2)} Tm`)
      parts.push(`(${escapeText(line.text)}) Tj`)
      parts.push('ET')

      // A gap is drawn as an empty line at the same origin, so it costs no extra object.
      if (line.gapAfter) {
        y -= line.gapAfter
        parts.push(`1 0 0 1 ${MARGIN_X} ${y.toFixed(2)} Tm`)
        parts.push('() Tj')
        parts.push('ET')
      }
    }

    return parts.join('\n')
  })

  const objects: string[] = []

  objects.push('<< /Type /Catalog /Pages 2 0 R >>')

  const pageObjectNumbers = contentStreams.map((_, index) => 4 + index * 2)
  objects.push(
    `<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  )

  objects.push(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`,
  )
  objects.push(
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`,
  )

  contentStreams.forEach((stream, index) => {
    const pageNumber = 4 + index * 2
    const contentNumber = pageNumber + 1

    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNumber} 0 R >>`,
    )
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`)
  })

  // Assemble, recording each object's byte offset for the cross-reference table.
  let body = '%PDF-1.4\n'
  const offsets: number[] = []

  objects.forEach((body_text, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${body_text}\nendobj\n`
  })

  const xrefOffset = Buffer.byteLength(body, 'latin1')

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`
  }

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`

  const file = body + xref + trailer
  return new Uint8Array(Buffer.from(file, 'latin1'))
}