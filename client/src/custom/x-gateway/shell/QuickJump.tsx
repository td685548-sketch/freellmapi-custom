import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search } from 'lucide-react'
import { useShellStrings } from '../shell-strings'
import type { NavGroup } from './nav'

const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()

/** Keyboard page switcher (Ctrl/⌘ K). Searches page names without needing diacritics. */
export function QuickJump({ groups, open, onClose }: { groups: NavGroup[]; open: boolean; onClose: () => void }) {
  const sh = useShellStrings()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const results = useMemo(() => {
    const needle = plain(query.trim())
    return groups.flatMap(group => group.items.map(item => ({ ...item, group: group.label })))
      .filter(item => !needle || plain(`${item.label} ${item.group}`).includes(needle))
  }, [groups, query])
  useEffect(() => {
    if (!open) return
    setQuery('')
    setCursor(0)
    input.current?.focus()
  }, [open])
  if (!open) return null
  const go = (to: string) => { onClose(); navigate(to) }
  const active = Math.min(cursor, Math.max(results.length - 1, 0))
  return <div className="x-jump-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="x-jump" role="dialog" aria-modal="true" aria-label={sh.jump}>
      <label className="x-jump-input"><Search size={16} /><span className="x-sr-only">{sh.jump}</span>
        <input ref={input} value={query} placeholder={sh.jumpPlaceholder} role="combobox" aria-expanded="true" aria-controls="x-jump-list"
          aria-activedescendant={results[active] ? `x-jump-${active}` : undefined}
          onChange={event => { setQuery(event.target.value); setCursor(0) }}
          onKeyDown={event => {
            if (event.key === 'Escape') onClose()
            else if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((active + 1) % Math.max(results.length, 1)) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((active - 1 + results.length) % Math.max(results.length, 1)) }
            else if (event.key === 'Enter' && results[active]) { event.preventDefault(); go(results[active].to) }
          }} />
      </label>
      <ul id="x-jump-list" role="listbox" className="x-jump-list">
        {results.map((item, index) => <li key={item.to} id={`x-jump-${index}`} role="option" aria-selected={index === active}
          className={index === active ? 'active' : ''} onMouseEnter={() => setCursor(index)} onClick={() => go(item.to)}>
          <item.icon size={16} /><span>{item.label}</span><small>{item.group}</small>
        </li>)}
        {results.length === 0 && <li className="x-jump-empty">{sh.jumpEmpty}</li>}
      </ul>
      <p className="x-jump-hint">{sh.jumpHint}</p>
    </div>
  </div>
}
