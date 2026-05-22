import type { ExtractedEntity } from './types.js'

export function extractEntities(content: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = []
  const seen = new Set<string>()
  const max = 30

  const add = (entity_type: ExtractedEntity['entity_type'], entity_text: string) => {
    const text = entity_text.trim()
    if (!text) return
    const key = text.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    entities.push({ entity_text: text, entity_type })
  }

  const collect = (re: RegExp, type: ExtractedEntity['entity_type'], group: number = 0) => {
    let match: RegExpExecArray | null
    while ((match = re.exec(content)) !== null) {
      add(type, match[group] ?? match[0])
      if (entities.length >= max) return
    }
  }

  collect(/(?:\.{1,2}\/|\/)?(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8}\b/g, 'file_path')
  if (entities.length < max) collect(/\*\.[A-Za-z0-9]{1,8}\b/g, 'file_path')

  if (entities.length < max) collect(/\bfunction\s+([A-Za-z_$][\w$]*)\b/g, 'function', 1)
  if (entities.length < max) collect(/\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*\(/g, 'function', 1)
  if (entities.length < max) collect(/\b([a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*)\s*\(/g, 'function', 1)

  if (entities.length < max) collect(/\bclass\s+([A-Z][\w$]*)\b/g, 'class', 1)
  if (entities.length < max) collect(/\binterface\s+([A-Z][\w$]*)\b/g, 'class', 1)
  if (entities.length < max) collect(/\btype\s+([A-Z][\w$]*)\b/g, 'class', 1)

  if (entities.length < max) collect(/`([A-Za-z_$#][\w$-]*)`/g, 'symbol', 1)
  if (entities.length < max) collect(/\b([A-Z][A-Z0-9_]{2,})\b/g, 'symbol', 1)
  if (entities.length < max) collect(/(^|\s)(#[A-Za-z][\w-]*)\b/gm, 'symbol', 2)

  if (entities.length < max) collect(/\bimport\s+[^'"\n]+\s+from\s+['"]([^'"]+)['"]/g, 'library', 1)
  if (entities.length < max) collect(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, 'library', 1)

  if (entities.length < max) collect(/https?:\/\/[^\s)\]}>"']+/g, 'url')
  if (entities.length < max) collect(/\b(?:[A-Za-z]+Error|Error):\s*[^\n]+/g, 'error')

  return entities.slice(0, max)
}
