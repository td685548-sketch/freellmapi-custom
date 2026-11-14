import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { preloadBrowserPath } from './custom/route-splitting/lazy-pages'

// Start downloading the page being opened now, in parallel with sign-in and the first API calls,
// instead of after them.
preloadBrowserPath(window.location.pathname, import.meta.env.BASE_URL)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
