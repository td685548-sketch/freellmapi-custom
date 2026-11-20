// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { AboutContent } from './AboutContent'
import { DEPLOY_TARGETS, GITHUB_REPO_URL, isCurrentDeploymentOrigin } from './deploy-targets'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  window.matchMedia = window.matchMedia ?? (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function renderAbout(props: { currentOrigin?: string; version?: string | null; locale?: 'en' | 'vi' } = {}) {
  act(() => {
    root.render(
      <I18nProvider initialLocale={props.locale ?? 'en'}>
        <AboutContent currentOrigin={props.currentOrigin} version={props.version ?? null} />
      </I18nProvider>,
    )
  })
  await flush()
}

describe('isCurrentDeploymentOrigin', () => {
  it('matches identical origins regardless of path or case', () => {
    expect(isCurrentDeploymentOrigin('https://freellm-thanhdo.onrender.com', 'https://FREELLM-THANHDO.onrender.com')).toBe(true)
    expect(isCurrentDeploymentOrigin('https://laptop-o6msglm4.tailc4d30d.ts.net', 'https://laptop-o6msglm4.tailc4d30d.ts.net')).toBe(true)
    expect(isCurrentDeploymentOrigin('https://freellmapi-1d80d.containers.snapdeploy.app', 'http://localhost:4001')).toBe(false)
    expect(isCurrentDeploymentOrigin('not-a-url', 'https://freellm-thanhdo.onrender.com')).toBe(false)
  })
})

describe('AboutContent', () => {
  it('renders all 3 deployment links and the GitHub repository link', async () => {
    await renderAbout({ currentOrigin: 'http://localhost:4001', version: '2.4.0' })

    const links = [...container.querySelectorAll('a')].map(link => ({
      href: link.getAttribute('href'),
      target: link.getAttribute('target'),
      rel: link.getAttribute('rel'),
    }))

    expect(links).toContainEqual({
      href: GITHUB_REPO_URL,
      target: '_blank',
      rel: 'noopener noreferrer',
    })

    for (const target of DEPLOY_TARGETS) {
      expect(links).toContainEqual({
        href: target.url,
        target: '_blank',
        rel: 'noopener noreferrer',
      })
    }

    expect(container.textContent).toContain('https://freellm-thanhdo.onrender.com')
    expect(container.textContent).toContain('https://laptop-o6msglm4.tailc4d30d.ts.net')
    expect(container.textContent).toContain('https://freellmapi-1d80d.containers.snapdeploy.app')
    expect(container.textContent).toContain('v2.4.0')
  })

  it('marks only the matching deployment target as Active here', async () => {
    await renderAbout({ currentOrigin: 'https://laptop-o6msglm4.tailc4d30d.ts.net' })

    const cards = [...container.querySelectorAll('[data-deploy-id]')]
    const activeIds = cards
      .filter(card => card.getAttribute('data-active-origin') === 'true')
      .map(card => card.getAttribute('data-deploy-id'))

    expect(activeIds).toEqual(['tailscale'])
    expect(container.textContent).toContain('Active here')
  })

  it('copies the deployment URL when the copy button is clicked', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })

    await renderAbout({ currentOrigin: 'http://localhost:4001' })

    const copyBtn = container.querySelector('button[aria-label="Copy URL for Render"]') as HTMLButtonElement | null
    expect(copyBtn).not.toBeNull()

    await act(async () => {
      copyBtn?.click()
      await Promise.resolve()
    })
    await flush()

    expect(writeText).toHaveBeenCalledWith('https://freellm-thanhdo.onrender.com')
    expect(copyBtn?.getAttribute('aria-label')).toBe('Copied URL for Render')
  })
})
