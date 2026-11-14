import { lazyNamed, lazyPage, type LazyPage } from './lazy-page'

/**
 * Every routed page of the dashboard, downloaded on first use instead of with the app.
 * The two sub-applications (Thruline, AI Platform) are one chunk each, and Thruline splits
 * again per page inside its own shell.
 */
export const KeysPage = lazyPage(() => import('@/pages/KeysPage'))
export const PlaygroundPage = lazyPage(() => import('@/pages/PlaygroundPage'))
export const FallbackPage = lazyPage(() => import('@/pages/FallbackPage'))
export const ModelDetailPage = lazyPage(() => import('@/pages/ModelDetailPage'))
export const FusionPage = lazyPage(() => import('@/pages/FusionPage'))
export const EmbeddingsPage = lazyPage(() => import('@/pages/EmbeddingsPage'))
export const EmbeddingDetailPage = lazyPage(() => import('@/pages/EmbeddingDetailPage'))
export const ImagePage = lazyPage(() => import('@/pages/ImagePage'))
export const VideoPage = lazyPage(() => import('@/pages/VideoPage'))
export const AudioPage = lazyPage(() => import('@/pages/AudioPage'))
export const SearchPage = lazyPage(() => import('@/pages/SearchPage'))
export const DecisionPage = lazyPage(() => import('@/pages/DecisionPage'))
export const MediaDetailPage = lazyPage(() => import('@/pages/MediaDetailPage'))
export const PremiumPage = lazyPage(() => import('@/pages/PremiumPage'))
export const AgentsPage = lazyPage(() => import('@/pages/AgentsPage'))
export const UserAnalyticsPage = lazyNamed(() => import('@/custom/UserAnalyticsPage'), 'UserAnalyticsPage')
export const ProfileUsagePage = lazyNamed(() => import('@/custom/ProfileUsagePage'), 'ProfileUsagePage')
export const UsageRankingPage = lazyNamed(() => import('@/custom/UsageRankingPage'), 'UsageRankingPage')
export const AuditLogPage = lazyNamed(() => import('@/custom/AuditLogPage'), 'AuditLogPage')
export const UsersAccessPage = lazyNamed(() => import('@/custom/ScopedAdministrativePages'), 'UsersAccessPage')
export const InvitesAccessPage = lazyNamed(() => import('@/custom/ScopedAdministrativePages'), 'InvitesAccessPage')
export const AnalyticsAccessPage = lazyNamed(() => import('@/custom/ScopedAdministrativePages'), 'AnalyticsAccessPage')
export const LogsAccessPage = lazyNamed(() => import('@/custom/ScopedAdministrativePages'), 'LogsAccessPage')
export const XGatewayApp = lazyPage(() => import('@/custom/x-gateway/XGatewayApp'))
export const AiPlatformApp = lazyNamed(() => import('@/custom/ai-platform/AiPlatformApp'), 'AiPlatformApp')

type Preloadable = Pick<LazyPage, 'preload'>

/** Which pages a path will need, most specific pattern first. Mirrors the routes in App.tsx. */
const ROUTES: ReadonlyArray<readonly [RegExp, readonly Preloadable[]]> = [
  [/^\/thruline(\/|$)/, [XGatewayApp]],
  [/^\/ai-platform(\/|$)/, [AiPlatformApp]],
  [/^\/models\/chat\/[^/]+/, [ModelDetailPage]],
  [/^\/(models(\/chat)?)?\/?$/, [FallbackPage]],
  [/^\/models\/fusion/, [FusionPage]],
  [/^\/models\/embeddings\/[^/]+/, [EmbeddingDetailPage]],
  [/^\/models\/embeddings/, [EmbeddingsPage]],
  [/^\/models\/(image|video|audio|transcription)\/[^/]+/, [MediaDetailPage]],
  [/^\/models\/image/, [ImagePage]],
  [/^\/models\/video/, [VideoPage]],
  [/^\/models\/audio/, [AudioPage]],
  [/^\/models\/search/, [SearchPage]],
  [/^\/models\/decision/, [DecisionPage]],
  [/^\/playground/, [PlaygroundPage]],
  [/^\/keys/, [KeysPage]],
  [/^\/invites/, [InvitesAccessPage]],
  [/^\/users\/[^/]+\/analytics/, [UserAnalyticsPage]],
  [/^\/users/, [UsersAccessPage]],
  [/^\/profiles\/[^/]+\/usage/, [ProfileUsagePage]],
  [/^\/usage/, [UsageRankingPage]],
  [/^\/audit/, [AuditLogPage]],
  [/^\/agents/, [AgentsPage]],
  [/^\/analytics/, [AnalyticsAccessPage]],
  [/^\/logs/, [LogsAccessPage]],
  [/^\/premium/, [PremiumPage]],
]

/** Start downloading the code for `pathname` (a router path, without the base). Safe to repeat. */
export function preloadRoute(pathname: string): void {
  for (const [pattern, pages] of ROUTES) {
    if (pattern.test(pathname)) {
      for (const page of pages) page.preload()
      return
    }
  }
}

/** The same, for a browser pathname that still carries the app's base path. */
export function preloadBrowserPath(pathname: string, base: string): void {
  const prefix = base.replace(/\/$/, '')
  preloadRoute(prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname)
}
