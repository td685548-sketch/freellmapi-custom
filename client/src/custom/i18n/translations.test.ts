import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VI } from './vi'
import { translate } from './use-custom-t'

// Every English string a custom screen passes to tc('…') must have a Vietnamese entry, so a new
// screen cannot ship half translated. Labels that reach tc() through a variable are in VI as well.

const here = path.dirname(fileURLToPath(import.meta.url))
const customDir = path.resolve(here, '..')
const sources = readdirSync(customDir).filter(f => f.endsWith('.tsx') && !f.includes('.test.')).map(f => readFileSync(path.join(customDir, f), 'utf8'))
const literal = /\btc\(\s*'((?:[^'\\]|\\.)*)'/g
const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))

describe('custom screen translations', () => {
  it('has a Vietnamese entry for every tc() string', () => {
    const used = new Set<string>()
    for (const src of sources) for (const m of src.matchAll(literal)) used.add(unescape(m[1]!))
    expect(used.size).toBeGreaterThan(400)
    const missing = [...used].filter(k => /\p{L}{2,}/u.test(k) && !(k in VI))
    expect(missing).toEqual([])
  })

  it('keeps every placeholder of the English text that the translation uses', () => {
    for (const [en, vi] of Object.entries(VI)) {
      const known = new Set([...en.matchAll(/\{(\w+)\}/g)].map(m => m[1]))
      for (const m of vi.matchAll(/\{(\w+)\}/g)) expect(known.has(m[1]), `${en} → ${vi}`).toBe(true)
    }
  })

  it('translates for Vietnamese and leaves every other locale in English', () => {
    expect(translate('vi', 'Want to use these models?')).toBe('Muốn dùng các model này?')
    expect(translate('vi', 'Signed out {revoked} sessions', { revoked: 3 })).toBe('Đã đăng xuất 3 phiên')
    expect(translate('fr', 'Signed out {revoked} sessions', { revoked: 3 })).toBe('Signed out 3 sessions')
    expect(translate('vi', 'A sentence nobody translated')).toBe('A sentence nobody translated')
  })
})
