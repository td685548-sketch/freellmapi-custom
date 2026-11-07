import { useCallback } from 'react'
import { useI18n } from '@/i18n'
import { VI } from './vi'

// Translations of this fork's own screens. The English sentence is its own key, so a missing
// translation simply shows English, and upstream's 60 locale files stay untouched (they are synced
// from upstream). Only Vietnamese is translated today; every other locale reads English.

const DICTIONARIES: Record<string, Record<string, string>> = { vi: VI }

export type CustomT = (english: string, vars?: Record<string, string | number>) => string

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (vars[name] === undefined || vars[name] === null ? match : String(vars[name])))
}

export function translate(locale: string, english: string, vars?: Record<string, string | number>): string {
  return interpolate(DICTIONARIES[locale]?.[english] ?? english, vars)
}

export function useCustomT(): CustomT {
  const { locale } = useI18n()
  return useCallback((english: string, vars?: Record<string, string | number>) => translate(locale, english, vars), [locale])
}
