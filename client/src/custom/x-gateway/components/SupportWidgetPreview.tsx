import { useEffect, useRef } from 'react'
import type { SupportDeskPublicWidgetConfig } from '@freellmapi/shared/support-service-desk.js'

declare global {
  interface Window {
    FreeLLMAPISupport?: {
      preview?: (container: HTMLElement, publicConfig: SupportDeskPublicWidgetConfig) => { destroy: () => void }
      init?: (config: unknown) => unknown
      _instance?: unknown
    }
  }
}

export interface SupportWidgetPreviewProps {
  publicConfig: SupportDeskPublicWidgetConfig
  className?: string
  style?: React.CSSProperties
}

/**
 * Preview container component that renders the widget appearance preview
 * backed by the same canonical served widget appearance renderer with transport disabled.
 * Does not instantiate a second widget, does not modify global instance, and cleans up cleanly.
 */
export default function SupportWidgetPreview({
  publicConfig,
  className,
  style,
}: SupportWidgetPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let pendingScript: HTMLScriptElement | null = null
    let onLoad: (() => void) | null = null
    let previewInstance: { destroy: () => void } | null = null

    function mountPreview() {
      if (
        !disposed && container &&
        typeof window !== 'undefined' &&
        window.FreeLLMAPISupport &&
        typeof window.FreeLLMAPISupport.preview === 'function'
      ) {
        container.innerHTML = ''
        previewInstance = window.FreeLLMAPISupport.preview(container, publicConfig)
      }
    }

    if (
      typeof window !== 'undefined' &&
      window.FreeLLMAPISupport &&
      typeof window.FreeLLMAPISupport.preview === 'function'
    ) {
      mountPreview()
    } else if (typeof document !== 'undefined') {
      const scriptSrc = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/thruline/v1/support/widget.js`
      let script = Array.from(document.scripts).find(item => item.getAttribute('src') === scriptSrc)
      const isNew = !script
      if (!script) {
        script = document.createElement('script')
        script.src = scriptSrc
        script.async = true
      }
      pendingScript = script
      onLoad = mountPreview
      script.addEventListener('load', onLoad)
      if (isNew) document.head.appendChild(script)
    }

    return () => {
      disposed = true
      if (pendingScript && onLoad) pendingScript.removeEventListener('load', onLoad)
      if (previewInstance?.destroy) {
        previewInstance.destroy()
        previewInstance = null
      }
      if (container) {
        container.innerHTML = ''
      }
    }
  }, [publicConfig])

  return (
    <div
      ref={containerRef}
      data-testid="support-widget-preview"
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 520,
        padding: 16,
        background: '#f3f4f6',
        borderRadius: 12,
        overflow: 'hidden',
        position: 'relative',
        ...style,
      }}
    />
  )
}
