// What: the page's content security policy.
// Why: the camera worker needs a blob: worker, and the React dev preamble is an inline module script.
// Removed: production would allow inline scripts, or the dev window would block refresh.
export function contentSecurityPolicy(development = false): string {
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
