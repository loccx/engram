import { describe, it, expect, afterEach } from 'vitest'
import {
  EMBED_BATCH_MAX,
  embeddingsDisabled,
  embeddingState,
  getEmbedding,
  getEmbeddings,
} from '../src/embeddings/pipeline.js'

describe('ENGRAM_EMBEDDINGS switch', () => {
  const before = process.env.ENGRAM_EMBEDDINGS
  afterEach(() => {
    if (before === undefined) delete process.env.ENGRAM_EMBEDDINGS
    else process.env.ENGRAM_EMBEDDINGS = before
  })

  it('reads the variable per call and ignores case and padding', () => {
    expect(embeddingsDisabled({ ENGRAM_EMBEDDINGS: ' OFF ' })).toBe(true)
    expect(embeddingsDisabled({ ENGRAM_EMBEDDINGS: 'on' })).toBe(false)
    expect(embeddingsDisabled({})).toBe(false)
  })

  it('off never loads the model and reports not ready', async () => {
    process.env.ENGRAM_EMBEDDINGS = 'off'
    expect(await getEmbedding('anything at all')).toBeNull()
    expect(embeddingState()).toMatchObject({ ready: false, loaded: false })
  })

  it('off answers a batch with one null per text, in input order', async () => {
    process.env.ENGRAM_EMBEDDINGS = 'off'
    const vectors = await getEmbeddings(['first text', '', 'third, longer than the first'])
    expect(vectors).toEqual([null, null, null])
    expect(vectors.length).toBe(3)
    expect(await getEmbeddings([])).toEqual([])
  })

  it('caps a forward pass at EMBED_BATCH_MAX texts', () => {
    expect(EMBED_BATCH_MAX).toBeGreaterThanOrEqual(2)
    expect(EMBED_BATCH_MAX).toBeLessThanOrEqual(32)
  })
})
