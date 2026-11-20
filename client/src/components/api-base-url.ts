// The /v1 base URL for ready-to-run snippets, derived the same way as the chat
// model page + Keys page: the dev server port in DEV, the page origin in a
// packaged/hosted build. Lives in its own module so api-usage.tsx only
// exports components (react-refresh rule).
export function apiBaseUrl(): string {
  return import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`
}
