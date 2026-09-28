import { describe, it, expect, afterEach } from 'vitest'
import { embeddingsDisabled, embeddingState, getEmbedding } from '../src/embeddings/pipeline.js'

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
})
