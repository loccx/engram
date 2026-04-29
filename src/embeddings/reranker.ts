import { AutoTokenizer, AutoModelForSequenceClassification, type PreTrainedTokenizer, type PreTrainedModel } from '@huggingface/transformers'

export const RERANKER_MODEL_ID = 'onnx-community/bge-reranker-v2-m3-ONNX'
export const RERANKER_MAX_LENGTH = 512

export interface RerankResult {
  index: number
  score: number
}

let _tokenizer: PreTrainedTokenizer | null = null
let _model: PreTrainedModel | null = null
let _loading: Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel } | null> | null = null
let _failed = false

export function isRerankerEnabled(): boolean {
  return process.env.ENGRAM_RERANKER_ENABLED?.trim() === '1'
}

async function getReranker(): Promise<{ tokenizer: PreTrainedTokenizer; model: PreTrainedModel } | null> {
  if (_failed) return null
  if (_tokenizer && _model) return { tokenizer: _tokenizer, model: _model }
  if (!_loading) {
    _loading = (async () => {
      process.stderr.write('Engram: loading reranker model (first run only)...\n')
      try {
        const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL_ID)
        const model = await AutoModelForSequenceClassification.from_pretrained(RERANKER_MODEL_ID, {
          dtype: 'q8',
        } as Parameters<typeof AutoModelForSequenceClassification.from_pretrained>[1])
        process.stderr.write('Engram: reranker model ready.\n')
        _tokenizer = tokenizer
        _model = model
        return { tokenizer, model }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        process.stderr.write(`Engram: reranker model unavailable (${msg}), falling back to hybrid score.\n`)
        _failed = true
        return null
      }
    })()
  }
  return _loading
}

/**
 * Run cross-encoder reranking on (query, doc) pairs.
 * Returns sorted results by descending sigmoid(logit) relevance score.
 * Returns null if the reranker is disabled or unavailable; callers must
 * fall back to the hybrid score in that case.
 *
 * Tokenizes all pairs in a single batched call to keep inference under
 * ~1s for 20 pairs on CPU; sequential per-pair inference would be ~3s.
 */
export async function rerank(query: string, docs: string[]): Promise<RerankResult[] | null> {
  if (!isRerankerEnabled()) return null
  if (docs.length === 0) return []
  const r = await getReranker()
  if (!r) return null

  try {
    const queries = docs.map(() => query)
    const inputs = r.tokenizer(queries, {
      text_pair: docs,
      padding: true,
      truncation: true,
      max_length: RERANKER_MAX_LENGTH,
    } as Parameters<PreTrainedTokenizer>[1])

    const output = (await r.model(inputs)) as { logits: { data: Float32Array | number[]; dims: number[] } }
    const logits = output.logits.data
    const dims = output.logits.dims
    const numScores = dims[0] ?? docs.length
    const stride = dims.length >= 2 ? dims[1] : 1

    const results: RerankResult[] = []
    for (let i = 0; i < numScores; i++) {
      const raw = Number(logits[i * stride])
      const sigmoid = 1 / (1 + Math.exp(-raw))
      results.push({ index: i, score: sigmoid })
    }
    results.sort((a, b) => b.score - a.score)
    return results
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    process.stderr.write(`Engram: reranker inference failed (${msg}), falling back to hybrid score.\n`)
    return null
  }
}

export async function warmReranker(): Promise<boolean> {
  if (!isRerankerEnabled()) return false
  const r = await getReranker()
  return r !== null
}

export function resetRerankerForTests(): void {
  _tokenizer = null
  _model = null
  _loading = null
  _failed = false
}
