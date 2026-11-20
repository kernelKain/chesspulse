// What: the same content security policy, in a file Vite can import without a TypeScript loader.
// Why: the Electron build compiles the TypeScript copy; Vite's config loader does not.
// Removed: a future Vite release would fail to load the policy while bundling the page.
export function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "form-action 'none'",
  ].join('; ');
}
