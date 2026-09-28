import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // onnxruntime-node's native addon is not safe to load across vitest's
    // default worker-thread pool (crashes with a fatal V8 HandleScope error).
    pool: 'forks',
    // hermetic by default: no 131 mb model, no network, same results on every machine
    env: { ENGRAM_EMBEDDINGS: 'off' },
  },
})
