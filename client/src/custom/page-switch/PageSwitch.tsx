import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useI18n } from '@/i18n'
import { useUserSession } from '../use-session'
import { GatewayGalaxyLabel } from '../x-gateway/GatewayGalaxyLabel'
import { readMemory, remember, sideOf, switchTarget } from './switch-state'
import './page-switch.css'

/**
 * The one button that moves between FreeLLMAPI and Thruline.
 *
 * It is mounted once, above both layouts, and positioned with `position: fixed`,
 * so it sits at exactly the same screen coordinates on both pages and is never
 * rebuilt when the route changes. Each side carries its own look (a galaxy going
 * in, an ink dot coming back) and its own WebGPU transition; see
 * x-gateway/transition. Both headers keep clear of it through the
 * `html[data-has-page-switch]` rules in page-switch.css.
 */

const strings = {
  en: { toThruline: 'Switch to Thruline', toFreellmapi: 'Switch to FreeLLMAPI' },
  vi: { toThruline: 'Chuyển sang Thruline', toFreellmapi: 'Chuyển sang FreeLLMAPI' },
}

export function PageSwitch() {
  const location = useLocation()
  const session = useUserSession()
  const { locale } = useI18n()
  const side = sideOf(location.pathname)
  const visible = !session.isPending && !session.isError && session.hasPermission('use_x_gateway')

  // Remember the page being left, except one-shot screens that make no sense to return to.
  useEffect(() => {
    if (location.pathname.includes('/thruline/accounts/callback')) return
    remember(side, `${location.pathname}${location.search}`)
  }, [side, location.pathname, location.search])

  // Headers reserve room for the button only while it is actually on screen.
  useEffect(() => {
    if (!visible) return
    document.documentElement.setAttribute('data-has-page-switch', '')
    return () => document.documentElement.removeAttribute('data-has-page-switch')
  }, [visible])

  if (!visible) return null
  const text = strings[locale === 'vi' ? 'vi' : 'en']
  const toThruline = side === 'freellmapi'
  const label = toThruline ? text.toThruline : text.toFreellmapi
  const target = switchTarget(toThruline ? 'thruline' : 'freellmapi', readMemory())

  return (
    <Link
      key={side}
      to={target}
      data-page-switch={toThruline ? 'to-thruline' : 'to-freellmapi'}
      className={`page-switch ${toThruline ? 'page-switch--galaxy' : 'page-switch--ink'}`}
      aria-label={label}
      title={label}
    >
      {toThruline ? (
        <>
          <GatewayGalaxyLabel>Thruline</GatewayGalaxyLabel>
          <ArrowRight className="page-switch__arrow" aria-hidden="true" />
        </>
      ) : (
        <>
          <span className="page-switch__ink" aria-hidden="true">
            <span className="page-switch__marble" />
            <span className="page-switch__ripple" />
            <span className="page-switch__ripple page-switch__ripple--late" />
            <span className="page-switch__dot" />
          </span>
          <ArrowLeft className="page-switch__arrow" aria-hidden="true" />
          <span className="page-switch__brand">FreeLLMAPI</span>
        </>
      )}
    </Link>
  )
}
