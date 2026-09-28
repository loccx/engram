import { describe, it, expect } from 'vitest'
import { clusterLexicalFamilies, type LexicalMember } from '../src/maintenance/prune.js'

const member = (id: string, content: string, importance = 0.5): LexicalMember => ({
  id,
  content,
  namespace: '/p',
  type: 'pattern',
  importance,
  access_count: 0,
  pinned: false,
  link_degree: 0,
  created_at: 1,
})

const OPENING = 'None of these findings name a specific recurring manual task'
const burst = [0, 1, 2, 3].map((i) =>
  member(`burst-${i}`, `${OPENING} — detail variant ${i} with a distinct tail of its own`)
)
const distinct = member('distinct', 'A completely different memory about SQLite WAL mode and concurrent readers')

describe('clusterLexicalFamilies clusterPrefix mode', () => {
  it('is off by default: a shared opening does not group under the ratio test', () => {
    const clusters = clusterLexicalFamilies([...burst, distinct], { prefixChars: 48, threshold: 0.95 })
    expect(clusters.reduce((n, c) => n + c.redundant.length, 0)).toBe(0)
  })

  it('groups the bucket when enabled, keeping exactly one member', () => {
    const clusters = clusterLexicalFamilies([...burst, distinct], {
      prefixChars: 48,
      threshold: 0.95,
      clusterPrefix: true,
    })

    const grouped = clusters.filter((c) => c.redundant.length > 0)
    expect(grouped).toHaveLength(1)
    expect(grouped[0].members).toHaveLength(4)
    expect(grouped[0].redundant).toHaveLength(3)
    expect(grouped[0].keeper.id).toBe('burst-0')
    expect(clusters.some((c) => c.keeper.id === 'distinct' && c.redundant.length === 0)).toBe(true)
  })

  it('keeps the highest-utility member as the keeper', () => {
    const rows = [
      member('low', `${'X'.repeat(40)} tail a`, 0.1),
      member('high', `${'X'.repeat(40)} tail b`, 0.9),
    ]
    const clusters = clusterLexicalFamilies(rows, { prefixChars: 40, clusterPrefix: true })
    expect(clusters).toHaveLength(1)
    expect(clusters[0].keeper.id).toBe('high')
    expect(clusters[0].redundant.map((r) => r.member.id)).toEqual(['low'])
  })
})
