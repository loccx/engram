// minimal parquet reader. the memoryagentbench release publishes parquet only, the
// eval harness has no parquet dependency, and the hub's json routes time out for that
// split, so the few encodings the file uses are decoded here: plain and dictionary
// byte-array values, rle/bit-packed levels, snappy, data page v1 and v2.
// anything outside that set throws — a wrong row is worse than a loud stop.
import { readFileSync } from 'node:fs'

const PAGE_DATA = 0
const PAGE_DICTIONARY = 2
const PAGE_DATA_V2 = 3

const ENC_PLAIN = 0
const ENC_PLAIN_DICT = 2
const ENC_RLE_DICT = 8
const ENC_BIT_PACKED = 4

const CODEC_UNCOMPRESSED = 0
const CODEC_SNAPPY = 1

const TYPE_BYTE_ARRAY = 6

const REP_REQUIRED = 0
const REP_REPEATED = 2

/** list-of-list is the deepest shape this reader assembles */
export const MAX_REP_DEPTH = 2

export interface ParquetColumn {
  /** dotted path, e.g. `metadata.source` */
  path: string
  /** repeated ancestors: 0 scalar, 1 list, 2 list of list */
  repDepth: number
  maxDef: number
  /** one entry per row; a repeated column yields arrays, null when the value is absent */
  values: unknown[]
}

export interface ParquetReadResult {
  rows: number
  columns: ParquetColumn[]
}

/** decode the requested leaf columns of every row group, in request order */
export function readParquetColumns(file: string, requested: string[]): ParquetReadResult {
  const buf = readFileSync(file)
  const meta = parseFileMetaData(buf)
  const leaves = new Map(meta.schema.map((leaf) => [leaf.path, leaf]))

  const plans = requested.map((path) => {
    const leaf = resolveLeaf(leaves, path)
    if (leaf.repDepth > MAX_REP_DEPTH) {
      throw new Error(`${path}: ${leaf.repDepth} repeated levels is beyond this reader`)
    }
    return { path, leaf, values: [] as unknown[] }
  })

  let rows = 0
  for (const group of meta.rowGroups) {
    for (const plan of plans) {
      const chunk = group.columns.find((c) => c.path === plan.leaf.path)
      if (!chunk) throw new Error(`${plan.path}: missing in a row group`)
      const triples = decodeColumnChunk(buf, chunk, plan.leaf)
      plan.values.push(...assembleRows(triples, group.numRows, plan.leaf))
    }
    rows += group.numRows
  }
  return {
    rows,
    columns: plans.map((plan) => ({
      path: plan.path,
      repDepth: plan.leaf.repDepth,
      maxDef: plan.leaf.maxDef,
      values: plan.values,
    })),
  }
}

/** the leaf columns of a file, without decoding any data */
export function parquetSchema(file: string): Array<Pick<ParquetColumn, 'path' | 'repDepth' | 'maxDef'>> {
  return parseFileMetaData(readFileSync(file)).schema.map((leaf) => ({
    path: leaf.path,
    repDepth: leaf.repDepth,
    maxDef: leaf.maxDef,
  }))
}

interface SchemaLeaf {
  path: string
  type: number
  repDepth: number
  maxDef: number
  /** definition level of the outermost field, 0 when it is required */
  containerDef: number
  /** definition level of each repeated node, outermost first */
  slotDefs: number[]
}

/**
 * a list column's leaf path carries the synthetic `list.element` groups, so a caller
 * asks for the logical name (`questions`) and the schema node is matched here
 */
function resolveLeaf(leaves: Map<string, SchemaLeaf>, requested: string): SchemaLeaf {
  const exact = leaves.get(requested)
  if (exact) return exact
  const candidates = [...leaves.values()].filter((leaf) => leaf.path.startsWith(`${requested}.`))
  if (candidates.length === 1) return candidates[0]
  throw new Error(
    `${requested}: ${candidates.length === 0 ? 'no such column' : 'ambiguous column'} ` +
      `(known: ${[...leaves.keys()].sort().join(', ')})`
  )
}

interface ColumnChunkRef {
  path: string
  type: number
  codec: number
  numValues: number
  dataPageOffset: number
  dictionaryPageOffset: number
}

interface RowGroupMeta {
  numRows: number
  columns: ColumnChunkRef[]
}

interface FileMeta {
  schema: SchemaLeaf[]
  rowGroups: RowGroupMeta[]
}

/** thrift compact protocol, read-only, over a buffer slice */
class Compact {
  pos = 0
  private lastFieldId = 0

  constructor(private readonly buf: Buffer) {}

  private byte(): number {
    return this.buf[this.pos++]
  }

  varint(): number {
    let result = 0
    let shift = 0
    for (;;) {
      const b = this.byte()
      result += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) return result
      shift += 7
      if (shift > 35) throw new Error('parquet: varint overflow')
    }
  }

  zigzag(): number {
    const raw = this.varint()
    return (raw % 2 === 0 ? raw / 2 : -(raw + 1) / 2)
  }

  binary(): Buffer {
    const length = this.varint()
    const start = this.pos
    this.pos += length
    if (start + length > this.buf.length) throw new Error('parquet: string runs past the buffer')
    return this.buf.subarray(start, start + length)
  }

  string(): string {
    return this.binary().toString('utf8')
  }

  /** list header: element type and length; a zero element type means an empty list */
  listHeader(): { type: number; size: number } {
    const head = this.byte()
    const type = head & 0x0f
    let size = head >> 4
    if (size === 15) size = this.varint()
    if (type === 0) size = 0
    return { type, size }
  }

  /** a boolean field value rides in the field header itself */
  boolValue(type: number): boolean {
    return type === 1
  }

  skip(type: number): void {
    switch (type) {
      case 1:
      case 2:
        return
      case 3:
        this.pos += 1
        return
      case 4:
      case 5:
      case 6:
        this.varint()
        return
      case 7:
        this.pos += 8
        return
      case 8:
        this.binary()
        return
      case 9:
      case 10: {
        const { type: elementType, size } = this.listHeader()
        for (let i = 0; i < size; i++) this.skip(elementType)
        return
      }
      case 11: {
        const head = this.byte()
        const size = this.varint()
        for (let i = 0; i < size; i++) {
          this.skip(head >> 4)
          this.skip(head & 0x0f)
        }
        return
      }
      case 12:
        this.readStruct(() => false)
        return
      default:
        throw new Error(`parquet: unknown thrift type ${type}`)
    }
  }

  /** null marks the struct stop field */
  fieldHeader(): { id: number; type: number } | null {
    const head = this.byte()
    if (head === 0) return null
    const type = head & 0x0f
    const delta = head >> 4
    if (delta === 0) this.lastFieldId = this.zigzag()
    else this.lastFieldId += delta
    return { id: this.lastFieldId, type }
  }

  /**
   * read a struct, calling `read` per field; a false return skips that field. field id
   * deltas are relative to the enclosing struct, so the id is saved around a nested read.
   */
  readStruct(read: (id: number, type: number) => boolean): void {
    const outer = this.lastFieldId
    this.lastFieldId = 0
    for (;;) {
      const header = this.fieldHeader()
      if (header === null) break
      if (!read(header.id, header.type)) this.skip(header.type)
    }
    this.lastFieldId = outer
  }
}

/** file metadata from the footer; the buffer may be a slice, so relative offsets only */
function parseFileMetaData(buf: Buffer): FileMeta {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PAR1' || buf.toString('latin1', buf.length - 4) !== 'PAR1') {
    throw new Error('parquet: missing PAR1 magic')
  }
  const footerLength = buf.readUInt32LE(buf.length - 8)
  const footer = buf.subarray(buf.length - 8 - footerLength, buf.length - 8)

  const elements: Array<{ type: number; repetition: number; name: string; children: number }> = []
  const rowGroups: RowGroupMeta[] = []

  const reader = new Compact(footer)
  reader.readStruct((id, type) => {
    if (id === 2 && type === 9) {
      const { size } = reader.listHeader()
      for (let i = 0; i < size; i++) {
        const element = { type: 0, repetition: 0, name: '', children: 0 }
        reader.readStruct((fid) => {
          if (fid === 1) element.type = reader.zigzag()
          else if (fid === 3) element.repetition = reader.zigzag()
          else if (fid === 4) element.name = reader.string()
          else if (fid === 5) element.children = reader.zigzag()
          else return false
          return true
        })
        elements.push(element)
      }
      return true
    }
    if (id === 4 && type === 9) {
      const { size } = reader.listHeader()
      for (let i = 0; i < size; i++) rowGroups.push(readRowGroup(reader))
      return true
    }
    return false
  })

  return { schema: buildLeaves(elements), rowGroups }
}

function readRowGroup(reader: Compact): RowGroupMeta {
  const group: RowGroupMeta = { numRows: 0, columns: [] }
  reader.readStruct((id, type) => {
    if (id === 1 && type === 9) {
      const { size } = reader.listHeader()
      for (let i = 0; i < size; i++) group.columns.push(readColumnChunk(reader))
      return true
    }
    if (id === 3) {
      group.numRows = reader.zigzag()
      return true
    }
    return false
  })
  return group
}

function readColumnChunk(reader: Compact): ColumnChunkRef {
  const chunk: ColumnChunkRef = {
    path: '',
    type: 0,
    codec: 0,
    numValues: 0,
    dataPageOffset: 0,
    dictionaryPageOffset: 0,
  }
  reader.readStruct((id, type) => {
    if (id !== 3 || type !== 12) return false
    reader.readStruct((mid) => {
      if (mid === 1) chunk.type = reader.zigzag()
      else if (mid === 3) {
        const { size } = reader.listHeader()
        const names: string[] = []
        for (let i = 0; i < size; i++) names.push(reader.string())
        chunk.path = names.join('.')
      } else if (mid === 4) chunk.codec = reader.zigzag()
      else if (mid === 5) chunk.numValues = reader.zigzag()
      else if (mid === 9) chunk.dataPageOffset = reader.zigzag()
      else if (mid === 11) chunk.dictionaryPageOffset = reader.zigzag()
      else return false
      return true
    })
    return true
  })
  return chunk
}

/**
 * the schema is a depth-first list with the root first; definition levels count every
 * optional or repeated ancestor (the leaf included), repetition levels count only the
 * repeated ones, which is what sets the nesting depth of a column.
 */
function buildLeaves(
  elements: Array<{ type: number; repetition: number; name: string; children: number }>
): SchemaLeaf[] {
  const leaves: SchemaLeaf[] = []
  let index = 1

  const walk = (
    path: string[],
    maxDef: number,
    maxRep: number,
    slots: number[],
    containerDef: number
  ): void => {
    const element = elements[index++]
    if (!element) throw new Error('parquet: schema ended before its last child')
    const def = maxDef + (element.repetition === REP_REQUIRED ? 0 : 1)
    const rep = maxRep + (element.repetition === REP_REPEATED ? 1 : 0)
    const nextPath = [...path, element.name]
    const nextSlots = element.repetition === REP_REPEATED ? [...slots, def] : slots
    if (element.children > 0) {
      const nextContainer = path.length === 0 ? def : containerDef
      for (let i = 0; i < element.children; i++) walk(nextPath, def, rep, nextSlots, nextContainer)
      return
    }
    leaves.push({
      path: nextPath.join('.'),
      type: element.type,
      repDepth: rep,
      maxDef: def,
      containerDef,
      slotDefs: nextSlots,
    })
  }

  const root = elements[0]
  if (!root) return leaves
  for (let i = 0; i < root.children; i++) walk([], 0, 0, [], 0)
  return leaves
}

interface Triple {
  rep: number
  def: number
  value: string | null
}

function decodeColumnChunk(buf: Buffer, chunk: ColumnChunkRef, leaf: SchemaLeaf): Triple[] {
  if (chunk.type !== TYPE_BYTE_ARRAY) {
    throw new Error(`${chunk.path}: physical type ${chunk.type} is beyond this reader`)
  }
  if (chunk.codec !== CODEC_UNCOMPRESSED && chunk.codec !== CODEC_SNAPPY) {
    throw new Error(`${chunk.path}: compression codec ${chunk.codec} is beyond this reader`)
  }

  let pos = chunk.dictionaryPageOffset > 0 ? chunk.dictionaryPageOffset : chunk.dataPageOffset
  let dictionary: string[] | null = null
  const triples: Triple[] = []
  let seen = 0

  while (seen < chunk.numValues) {
    const headerReader = new Compact(buf.subarray(pos))
    const header = readPageHeader(headerReader)
    pos += headerReader.pos
    const body = buf.subarray(pos, pos + header.compressedPageSize)
    pos += header.compressedPageSize

    if (header.type === PAGE_DICTIONARY) {
      if (header.encoding !== ENC_PLAIN && header.encoding !== ENC_PLAIN_DICT) {
        throw new Error(`${chunk.path}: dictionary page encoding ${header.encoding} is beyond this reader`)
      }
      dictionary = decodePlainByteArray(decompress(body, chunk, header.uncompressedPageSize), header.numValues)
      continue
    }
    if (header.type !== PAGE_DATA && header.type !== PAGE_DATA_V2) {
      throw new Error(`${chunk.path}: page type ${header.type} is beyond this reader`)
    }

    const repWidth = bitsFor(leaf.repDepth)
    const defWidth = bitsFor(leaf.maxDef)
    let repLevels: number[]
    let defLevels: number[]
    let valueBytes: Buffer

    if (header.type === PAGE_DATA_V2) {
      const repBytes = repWidth === 0 ? Buffer.alloc(0) : body.subarray(0, header.repLevelBytes)
      const defBytes = defWidth === 0 ? Buffer.alloc(0) : body.subarray(header.repLevelBytes, header.repLevelBytes + header.defLevelBytes)
      const values = body.subarray(header.repLevelBytes + header.defLevelBytes)
      valueBytes = header.isCompressed
        ? decompress(values, chunk, header.uncompressedPageSize - header.repLevelBytes - header.defLevelBytes)
        : values
      repLevels = repWidth === 0 ? zeros(header.numValues) : decodeRleHybrid(repBytes, repWidth, header.numValues)
      defLevels = defWidth === 0 ? zeros(header.numValues, leaf.maxDef) : decodeRleHybrid(defBytes, defWidth, header.numValues)
    } else {
      const raw = decompress(body, chunk, header.uncompressedPageSize)
      let offset = 0
      if (repWidth > 0) {
        const length = raw.readUInt32LE(offset)
        repLevels = decodeRleHybrid(raw.subarray(offset + 4, offset + 4 + length), repWidth, header.numValues)
        offset += 4 + length
      } else {
        repLevels = zeros(header.numValues)
      }
      if (defWidth > 0) {
        const length = raw.readUInt32LE(offset)
        defLevels = decodeRleHybrid(raw.subarray(offset + 4, offset + 4 + length), defWidth, header.numValues)
        offset += 4 + length
      } else {
        defLevels = zeros(header.numValues, leaf.maxDef)
      }
      valueBytes = raw.subarray(offset)
    }

    const present = defLevels.filter((level) => level === leaf.maxDef).length
    const values = decodeValues(valueBytes, header.encoding, present, dictionary, chunk.path)
    let valueIndex = 0
    for (let i = 0; i < header.numValues; i++) {
      const def = defLevels[i] ?? 0
      triples.push({
        rep: repLevels[i] ?? 0,
        def,
        value: def === leaf.maxDef ? (values[valueIndex++] ?? null) : null,
      })
    }
    seen += header.numValues
  }
  return triples
}

function zeros(count: number, fill = 0): number[] {
  return new Array<number>(count).fill(fill)
}

function bitsFor(maxLevel: number): number {
  return maxLevel <= 0 ? 0 : 32 - Math.clz32(maxLevel)
}

function decompress(body: Buffer, chunk: ColumnChunkRef, expected: number): Buffer {
  if (chunk.codec === CODEC_UNCOMPRESSED) return body
  const out = snappyDecode(body)
  if (out.length !== expected) {
    throw new Error(
      `${chunk.path}: snappy produced ${out.length} bytes, the page header promises ${expected}`
    )
  }
  return out
}

/** raw snappy block format: literal and copy tags, no framing */
export function snappyDecode(input: Buffer): Buffer {
  const header = readUnsigned(input, 0)
  const out = Buffer.alloc(header.value)
  let at = header.next
  let written = 0

  while (at < input.length) {
    const tag = input[at++]
    const kind = tag & 0x03
    if (kind === 0) {
      let length = tag >> 2
      if (length >= 60) {
        const extra = length - 59
        length = 0
        for (let i = 0; i < extra; i++) length += input[at + i] * 2 ** (8 * i)
        at += extra
      }
      length += 1
      input.copy(out, written, at, at + length)
      at += length
      written += length
      continue
    }
    let length: number
    let offset: number
    if (kind === 1) {
      length = ((tag >> 2) & 0x07) + 4
      offset = ((tag >> 5) << 8) + input[at++]
    } else if (kind === 2) {
      length = (tag >> 2) + 1
      offset = input.readUInt16LE(at)
      at += 2
    } else {
      length = (tag >> 2) + 1
      offset = input.readUInt32LE(at)
      at += 4
    }
    if (offset === 0 || offset > written) throw new Error('snappy: copy offset outside the output')
    for (let i = 0; i < length; i++) {
      out[written] = out[written - offset]
      written++
    }
  }
  if (written !== header.value) {
    throw new Error(`snappy: wrote ${written} bytes, the preamble promises ${header.value}`)
  }
  return out
}

function readUnsigned(buf: Buffer, at: number): { value: number; next: number } {
  let value = 0
  let shift = 0
  let pos = at
  for (;;) {
    const b = buf[pos++]
    value += (b & 0x7f) * 2 ** shift
    if ((b & 0x80) === 0) break
    shift += 7
    if (shift > 28) throw new Error('snappy: length varint overflow')
  }
  return { value, next: pos }
}

/** rle/bit-packed hybrid: the body holds exactly `count` levels */
export function decodeRleHybrid(body: Buffer, bitWidth: number, count: number): number[] {
  if (bitWidth === 0) return zeros(count)
  const out: number[] = []
  const byteWidth = Math.ceil(bitWidth / 8)
  let at = 0
  while (out.length < count && at < body.length) {
    const header = readUnsigned(body, at)
    at = header.next
    if ((header.value & 1) === 1) {
      const groups = header.value >>> 1
      let bitAt = 0
      for (let i = 0; i < groups * 8 && out.length < count; i++) {
        let value = 0
        for (let b = 0; b < bitWidth; b++) {
          const bit = (body[at + ((bitAt + b) >> 3)] >> ((bitAt + b) & 7)) & 1
          value |= bit << b
        }
        bitAt += bitWidth
        out.push(value)
      }
      at += groups * bitWidth
      continue
    }
    const run = header.value >>> 1
    let value = 0
    for (let i = 0; i < byteWidth; i++) value += body[at + i] * 2 ** (8 * i)
    at += byteWidth
    for (let i = 0; i < run && out.length < count; i++) out.push(value)
  }
  if (out.length < count) {
    throw new Error(`parquet: rle run ended after ${out.length} of ${count} levels`)
  }
  return out
}

function decodeValues(
  body: Buffer,
  encoding: number,
  count: number,
  dictionary: string[] | null,
  path: string
): string[] {
  if (encoding === ENC_PLAIN) return decodePlainByteArray(body, count)
  if (encoding === ENC_RLE_DICT) {
    if (!dictionary) throw new Error(`${path}: dictionary data page without a dictionary page`)
    const indices = decodeRleHybrid(body.subarray(1), body[0], count)
    return indices.map((index) => {
      const value = dictionary[index]
      if (value === undefined) throw new Error(`${path}: dictionary index ${index} out of range`)
      return value
    })
  }
  if (encoding === ENC_PLAIN_DICT) throw new Error(`${path}: PLAIN_DICTIONARY data page is beyond this reader`)
  if (encoding === ENC_BIT_PACKED) throw new Error(`${path}: legacy BIT_PACKED values are beyond this reader`)
  throw new Error(`${path}: value encoding ${encoding} is beyond this reader`)
}

export function decodePlainByteArray(body: Buffer, count: number): string[] {
  const out: string[] = []
  let at = 0
  for (let i = 0; i < count; i++) {
    const length = body.readUInt32LE(at)
    at += 4
    out.push(body.toString('utf8', at, at + length))
    at += length
  }
  return out
}

interface PageHeader {
  type: number
  uncompressedPageSize: number
  compressedPageSize: number
  numValues: number
  encoding: number
  repLevelBytes: number
  defLevelBytes: number
  isCompressed: boolean
}

function readPageHeader(reader: Compact): PageHeader {
  const header: PageHeader = {
    type: -1,
    uncompressedPageSize: 0,
    compressedPageSize: 0,
    numValues: 0,
    encoding: ENC_PLAIN,
    repLevelBytes: 0,
    defLevelBytes: 0,
    isCompressed: true,
  }
  reader.readStruct((id, type) => {
    if (id === 1) {
      header.type = reader.zigzag()
      return true
    }
    if (id === 2) {
      header.uncompressedPageSize = reader.zigzag()
      return true
    }
    if (id === 3) {
      header.compressedPageSize = reader.zigzag()
      return true
    }
    if ((id === 5 || id === 7) && type === 12) {
      reader.readStruct((fid) => {
        if (fid === 1) header.numValues = reader.zigzag()
        else if (fid === 2) header.encoding = reader.zigzag()
        else return false
        return true
      })
      return true
    } else if (id === 8 && type === 12) {
      reader.readStruct((fid, ftype) => {
        if (fid === 1) header.numValues = reader.zigzag()
        else if (fid === 4) header.encoding = reader.zigzag()
        else if (fid === 5) header.defLevelBytes = reader.zigzag()
        else if (fid === 6) header.repLevelBytes = reader.zigzag()
        else if (fid === 7) header.isCompressed = reader.boolValue(ftype)
        else return false
        return true
      })
      return true
    }
    return false
  })
  if (header.type === -1) throw new Error('parquet: page header without a type')
  return header
}

/**
 * one triple per level slot: a scalar column yields one row per triple, a list one group
 * per row, and a list of list one inner group per rep level. the def thresholds that say
 * which container exists come from the schema walk, not from a fixed count.
 */
function assembleRows(triples: Triple[], rows: number, leaf: SchemaLeaf): unknown[] {
  const out: unknown[] = []
  if (leaf.repDepth === 0) {
    let index = 0
    for (let r = 0; r < rows; r++) {
      const triple = triples[r]
      const present = triple !== undefined && triple.def === leaf.maxDef
      out.push(present ? triples[index++].value ?? null : null)
    }
    return out
  }

  const innerSlot = leaf.slotDefs[1] ?? leaf.maxDef
  let outer: unknown[] | null = null
  let inner: unknown[] | null = null
  for (const triple of triples) {
    if (triple.rep === 0) {
      outer = triple.def >= leaf.containerDef ? [] : null
      out.push(outer)
      if (leaf.repDepth === 2) {
        inner = outer !== null && triple.def >= innerSlot ? [] : null
        if (inner !== null) outer!.push(inner)
      }
    } else if (leaf.repDepth === 2 && triple.rep === 1) {
      inner = []
      outer?.push(inner)
    }
    const target = leaf.repDepth === 2 ? inner : outer
    if (triple.def === leaf.maxDef && target) target.push(triple.value ?? null)
  }
  return out
}
