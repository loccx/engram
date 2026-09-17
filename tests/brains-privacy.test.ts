import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { DatabaseManager } from '../src/db/init.js'
import {
  exportBrain,
  redactNamespace,
  scrubHomePaths,
  readManifestFromFile,
} from '../src/brains/snapshot.js'

/**
 * A brain is handed to other people. These tests pin the privacy contract:
 * the owner's filesystem layout must not travel, while memory LAYERS must.
 */
describe('brains/privacy: snapshots carry no owner filesystem layout', () => {
  let tmp: string
  let outPath: string
  let src: DatabaseManager

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'engram-privacy-'))
    outPath = join(tmp, 'brain.db')
    src = new DatabaseManager(':memory:')
    src.db
      .prepare(
        'INSERT INTO sessions(id, project_path, tool_name, summary, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('sess1', '/Users/tester/proj', 'claude-code', 'Resolved and pushed PR #80704', Date.now(), null)
  })

  afterEach(() => {
    src.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function insertMemory(
    id: string,
    namespace: string,
    projectPath: string,
    shareable: 0 | 1,
    content = 'hello world'
  ): void {
    src.db
      .prepare(
        'INSERT INTO memories(id, session_id, project_path, content, type, importance, tags, created_at, access_count, namespace, shareable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, 'sess1', projectPath, content, 'note', 0.5, '[]', Date.now(), 0, namespace, shareable)
  }

  it('redactNamespace maps home to ~, keeps synthetic scopes, neutralizes foreign paths', () => {
    expect(redactNamespace('/Users/alice/cb', '/Users/alice')).toBe('~/cb')
    expect(redactNamespace('/Users/alice/cb//payments', '/Users/alice')).toBe('~/cb//payments')
    expect(redactNamespace('/Users/alice', '/Users/alice')).toBe('~')
    expect(redactNamespace('/opt/data/proj', '/Users/alice')).toBe('ext/proj')
    expect(redactNamespace('autonomous-crypto-desk', '/Users/alice')).toBe('autonomous-crypto-desk')
    expect(redactNamespace('~/already/relative', '/Users/alice')).toBe('~/already/relative')
  })

  it('ships no absolute owner path in any table, while preserving layers', () => {
    insertMemory('m1', `${homedir()}/proj`, `${homedir()}/proj`, 1, 'root layer fact')
    insertMemory('m2', `${homedir()}/proj//payments`, `${homedir()}/proj`, 1, 'payments scope fact')
    insertMemory('m3', '/Users/tester/proj', '/Users/tester/proj', 1, 'foreign home fact')

    const res = exportBrain(src.db, {
      namespace: `${homedir()}/proj`,
      outputPath: outPath,
      includeScopes: true,
    })
    // m3 lives in a different namespace root and must NOT be swept in.
    expect(res.memoryCount).toBe(2)

    const snap = new Database(outPath, { readonly: true })
    try {
      const rows = snap
        .prepare('SELECT namespace, project_path FROM memories ORDER BY namespace')
        .all() as Array<{ namespace: string; project_path: string }>
      expect(rows.map((r) => r.namespace)).toEqual(['~/proj', '~/proj//payments'])
      // project_path is NOT NULL in the schema, so it carries the redacted form.
      expect(rows.every((r) => r.project_path === r.namespace)).toBe(true)

      const sessions = snap
        .prepare('SELECT project_path, started_at, ended_at FROM sessions')
        .all() as Array<Record<string, unknown>>
      expect(sessions.length).toBe(1)
      expect(sessions[0].project_path).toBe('~/proj')
      expect(JSON.stringify(sessions)).not.toContain('/Users/tester')
      expect(JSON.stringify(sessions)).not.toContain('PR #80704')
    } finally {
      snap.close()
    }

    // Nothing anywhere in the produced file may carry a real absolute path:
    // memories, sessions, links, entities, FTS index and manifest are all in it.
    const bytes = readFileSync(outPath, 'latin1')
    expect(bytes.includes('/Users/tester')).toBe(false)
    expect(bytes.includes(homedir())).toBe(false)

    const manifest = readManifestFromFile(outPath)
    expect(manifest.source_namespace).toBe('~/proj')
    expect(manifest.included_layers ?? '').not.toContain('/Users')
    expect(manifest.included_layers ?? '').not.toContain(homedir())
  })

  it('redacts home paths inside free text and extracted entities', () => {
    expect(scrubHomePaths('see /Users/alice/proj/x.ts for the fix')).toBe('see ~/proj/x.ts for the fix')
    // The relative tail is preserved, exactly like ~/cb/engram on macOS.
    expect(scrubHomePaths('/home/bob/app and C:\\Users\\bob\\app')).toBe('~/app and ~\\app')
    expect(scrubHomePaths('no paths here')).toBe('no paths here')

    insertMemory(
      'm1',
      `${homedir()}/proj`,
      `${homedir()}/proj`,
      1,
      `decision recorded at ${homedir()}/proj/notes.md`
    )
    src.db
      .prepare(
        'INSERT INTO memory_entities(memory_id, entity_text, entity_type, created_at) VALUES (?, ?, ?, ?)'
      )
      .run('m1', `${homedir()}/proj/secret-file.ts`, 'file', Date.now())

    exportBrain(src.db, { namespace: `${homedir()}/proj`, outputPath: outPath })

    const snap = new Database(outPath, { readonly: true })
    try {
      const content = snap.prepare('SELECT content FROM memories').get() as { content: string }
      expect(content.content).toContain('~/proj/notes.md')
      const entity = snap.prepare('SELECT entity_text FROM memory_entities').get() as {
        entity_text: string
      }
      expect(entity.entity_text).toBe('~/proj/secret-file.ts')
    } finally {
      snap.close()
    }
    expect(readFileSync(outPath, 'latin1').includes(homedir())).toBe(false)
  })

  it('redacts a namespace rooted outside the home directory', () => {
    insertMemory('m9', '/Users/tester/proj', '/Users/tester/proj', 1, 'foreign home fact')

    const res = exportBrain(src.db, { namespace: '/Users/tester/proj', outputPath: outPath })
    expect(res.memoryCount).toBe(1)

    const snap = new Database(outPath, { readonly: true })
    try {
      const row = snap.prepare('SELECT namespace FROM memories').get() as { namespace: string }
      // Never absolute; either ~/proj (if this machine's home is /Users/tester)
      // or ext/proj (leaf-only form for a foreign root).
      expect(row.namespace.startsWith('/')).toBe(false)
      expect(['~/proj', 'ext/proj']).toContain(row.namespace)
    } finally {
      snap.close()
    }
    expect(readFileSync(outPath, 'latin1').includes('/Users/tester')).toBe(false)
  })

  it('does not export a memory the owner has superseded', () => {
    insertMemory('m1', 'work', '/p', 1, 'old fact the owner retracted')
    insertMemory('m2', 'work', '/p', 0, 'the correction, not itself shareable')
    src.db
      .prepare(
        'INSERT INTO memory_links(source_id, target_id, similarity, link_type, created_at, confidence) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('m2', 'm1', 0.9, 'supersedes', Date.now(), 0.95)

    const res = exportBrain(src.db, { namespace: 'work', outputPath: outPath })
    expect(res.memoryCount).toBe(0)
  })

  it('default export stays exact-match so no publish silently widens', () => {
    insertMemory('m1', 'work', '/p', 1)
    insertMemory('m2', 'work//sub', '/p', 1)
    insertMemory('m3', 'work/deeper', '/p', 1)

    const res = exportBrain(src.db, { namespace: 'work', outputPath: outPath })
    expect(res.memoryCount).toBe(1)
  })
})
