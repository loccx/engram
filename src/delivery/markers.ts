/**
 * marker blocks for files the user also edits: install and uninstall must agree on
 * what the block is (one begin marker, one end marker, each alone on a line), and
 * anything else is left byte-identical and reported.
 */

export interface Markers {
  begin: string
  end: string
}

export const MARKDOWN_MARKERS: Markers = { begin: '<!-- engram:begin -->', end: '<!-- engram:end -->' }
/** the same block in line-comment syntax */
export const HASH_MARKERS: Markers = { begin: '# engram:begin', end: '# engram:end' }

export interface BlockResult {
  text: string
  status: 'replaced' | 'appended' | 'removed' | 'absent' | 'malformed'
}

function markerLines(text: string, marker: string): number[] {
  return text
    .split('\n')
    .map((line, index) => (line.trim() === marker ? index : -1))
    .filter((index) => index >= 0)
}

function findBlock(text: string, markers: Markers): { begin: number; end: number } | null {
  const begins = markerLines(text, markers.begin)
  const ends = markerLines(text, markers.end)
  if (begins.length !== 1 || ends.length !== 1 || begins[0] > ends[0]) return null
  return { begin: begins[0], end: ends[0] }
}

function strayMarkers(text: string, markers: Markers): number {
  return markerLines(text, markers.begin).length + markerLines(text, markers.end).length
}

export function upsertBlock(
  existing: string | null,
  block: string,
  markers: Markers = MARKDOWN_MARKERS
): BlockResult {
  if (existing === null || !existing.trim()) {
    return { text: `${block}\n`, status: 'appended' }
  }

  const found = findBlock(existing, markers)
  if (found) {
    const lines = existing.split('\n')
    const head = lines.slice(0, found.begin).join('\n').replace(/\s+$/, '')
    const tail = lines
      .slice(found.end + 1)
      .join('\n')
      .replace(/^\s+/, '')
    const parts = [head, block, tail].filter((part) => part !== '')
    return { text: `${parts.join('\n\n').replace(/\s+$/, '')}\n`, status: 'replaced' }
  }

  if (strayMarkers(existing, markers) > 0) return { text: existing, status: 'malformed' }

  return { text: `${existing.replace(/\s+$/, '')}\n\n${block}\n`, status: 'appended' }
}

export function removeBlock(existing: string, markers: Markers = MARKDOWN_MARKERS): BlockResult {
  const found = findBlock(existing, markers)
  if (!found) {
    return { text: existing, status: strayMarkers(existing, markers) > 0 ? 'malformed' : 'absent' }
  }

  const lines = existing.split('\n')
  const head = lines.slice(0, found.begin).join('\n')
  const tail = lines.slice(found.end + 1).join('\n')
  const text = `${[head.replace(/\s+$/, ''), tail.replace(/^\s+/, '')].filter((part) => part !== '').join('\n\n')}\n`
  return { text, status: 'removed' }
}
