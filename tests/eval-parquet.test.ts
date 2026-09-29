// parquet reader tests. the fixture is a self-generated file (author-written rows, no
// third-party data) that mirrors the memoryagentbench conflict-resolution schema:
// context string, questions list<string>, answers list<list<string>>, metadata.source
// and metadata.qa_pair_ids. the decode was also checked against pyarrow on the real
// 8-row split, which is where the nested-level and snappy paths were verified.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { decodePlainByteArray, decodeRleHybrid, parquetSchema, readParquetColumns, snappyDecode } from '../eval/lib/parquet.js'

const FIXTURE = fileURLToPath(
  new URL('./fixtures/memoryagentbench-conflict-resolution.parquet', import.meta.url)
)

describe('parquet reader', () => {
  it('decodes the columns of the conflict-resolution fixture', () => {
    const result = readParquetColumns(FIXTURE, [
      'context',
      'questions',
      'answers',
      'metadata.source',
      'metadata.qa_pair_ids',
    ])
    const columns = new Map(result.columns.map((column) => [column.path, column.values]))

    expect(result.rows).toBe(2)
    expect(columns.get('metadata.source')).toEqual(['fixture_sh_6k', 'fixture_mh_6k'])
    expect(columns.get('context')).toEqual([
      'Here is a list of facts:\n0. Alpha was created in the city of Oslo.\n1. The sport of Beta is chess.',
      'Here is a list of facts:\n0. Gamma is a citizen of Peru.\n1. Gamma is a citizen of Chile.',
    ])
    expect(columns.get('questions')).toEqual([
      ['Which sport is Betas sport?', 'Where was Alpha created?'],
      ['What is the country of citizenship of Gamma?'],
    ])
    expect(columns.get('answers')).toEqual([[['chess'], ['Oslo', 'the city of Oslo']], [['Chile']]])
    expect(columns.get('metadata.qa_pair_ids')).toEqual([
      ['fixture_sh_6k_no0', 'fixture_sh_6k_no1'],
      ['fixture_mh_6k_no0'],
    ])
    for (const column of result.columns) {
      expect(column.values).toHaveLength(result.rows)
    }
  })

  it('reports the nesting depth of each leaf without reading data', () => {
    const schema = parquetSchema(FIXTURE)
    const byPath = new Map(schema.map((leaf) => [leaf.path, leaf]))
    expect(byPath.get('context')?.repDepth).toBe(0)
    expect(byPath.get('questions.list.element')?.repDepth).toBe(1)
    expect(byPath.get('answers.list.element.list.element')?.repDepth).toBe(2)
    expect(byPath.get('metadata.source')?.repDepth).toBe(0)
  })

  it('fails loud on an unknown or ambiguous column', () => {
    expect(() => readParquetColumns(FIXTURE, ['nope'])).toThrow(/no such column/)
    expect(() => readParquetColumns(FIXTURE, ['metadata'])).toThrow(/ambiguous column/)
  })

  it('decodes snappy literals and copies', () => {
    // preamble 12, literal of 4 bytes, then a two-byte-offset copy of 8 bytes
    const literal = Buffer.from([12, (4 - 1) << 2, 1, 2, 3, 4, ((8 - 1) << 2) | 2, 4, 0])
    expect([...snappyDecode(literal)]).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4])
    // a one-byte-offset copy of 4 bytes
    const shortCopy = Buffer.from([6, (2 - 1) << 2, 5, 6, ((4 - 4) << 2) | 1, 2])
    expect([...snappyDecode(shortCopy)]).toEqual([5, 6, 5, 6, 5, 6])
    // a misleading preamble is an error, not a short buffer
    expect(() => snappyDecode(Buffer.from([9, (2 - 1) << 2, 7, 8]))).toThrow(/promises 9/)
  })

  it('decodes rle and bit-packed runs', () => {
    // one rle run: header (count << 1) = 8, one 1-byte value
    expect(decodeRleHybrid(Buffer.from([8, 3]), 2, 4)).toEqual([3, 3, 3, 3])
    // one bit-packed group of 8 values, bit width 2
    const packed = Buffer.from([(1 << 1) | 1, 0b11_10_01_00, 0b00_11_10_01])
    expect(decodeRleHybrid(packed, 2, 8)).toEqual([0, 1, 2, 3, 1, 2, 3, 0])
    // bit width 0 means every level is 0 and the body is empty
    expect(decodeRleHybrid(Buffer.alloc(0), 0, 3)).toEqual([0, 0, 0])
    expect(() => decodeRleHybrid(Buffer.from([8, 3]), 2, 9)).toThrow(/ended after/)
  })

  it('decodes plain byte arrays with their length prefix', () => {
    const body = Buffer.concat([
      Buffer.from([3, 0, 0, 0]),
      Buffer.from('abc', 'utf8'),
      Buffer.from([0, 0, 0, 0]),
    ])
    expect(decodePlainByteArray(body, 2)).toEqual(['abc', ''])
  })

  it('refuses a file that is not parquet', () => {
    expect(() => readParquetColumns('/etc/hosts', ['context'])).toThrow(/PAR1/)
    const firstBytes = readFileSync(FIXTURE).subarray(0, 4).toString('latin1')
    expect(firstBytes).toBe('PAR1')
  })
})
