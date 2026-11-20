// What: the same content security policy, in a file Vite can import without a TypeScript loader.
// Why: the Electron build compiles the TypeScript copy; Vite's config loader does not.
// Removed: a future Vite release would fail to load the policy while bundling the page.
export function contentSecurityPolicy(development = false) {
  const scriptSrc = development ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  return [
    "default-src 'self'",
    scriptSrc,
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
