/**
 * Renderer hardening shared by the Electron main process.
 *
 * The renderer is a fully local React bundle: it never loads remote scripts,
 * styles, or fonts, and the only non-bundled resources are cover images served
 * through the privileged `takio-cover:` scheme. The policies below encode that
 * so an injected `<script>` or `<img src="https://...">` cannot exfiltrate
 * anything even if a future rendering bug lets untrusted metadata through.
 */

export interface ContentSecurityPolicyOptions {
  /** Vite dev server origin when running `bun run desktop`, otherwise undefined. */
  readonly devServerUrl?: string;
  /**
   * Whether the policy will be delivered through a `<meta>` tag. Browsers
   * ignore `frame-ancestors` there and log a warning, so it is omitted.
   */
  readonly delivery?: "header" | "meta";
}

/**
 * Build the Content-Security-Policy header value for the renderer.
 *
 * Production is strict: self-hosted scripts and styles only, no inline script,
 * no remote connections. The Vite dev server needs inline scripts for React
 * Fast Refresh and a WebSocket back to itself for HMR, so development relaxes
 * exactly those two directives and nothing else.
 */
export function contentSecurityPolicy({ devServerUrl, delivery = "header" }: ContentSecurityPolicyOptions = {}): string {
  const dev = devServerUrl ? parseDevOrigin(devServerUrl) : null;
  const self = dev ? `'self' ${dev.http}` : "'self'";
  const directives: Record<string, string> = {
    "default-src": "'none'",
    "script-src": dev ? `${self} 'unsafe-inline'` : self,
    "style-src": `${self} 'unsafe-inline'`,
    "img-src": `${self} takio-cover:`,
    "font-src": self,
    "connect-src": dev ? `${self} ${dev.ws}` : self,
    "worker-src": "'none'",
    "object-src": "'none'",
    "frame-src": "'none'",
    "base-uri": "'none'",
    "form-action": "'none'",
    ...(delivery === "header" ? { "frame-ancestors": "'none'" } : {}),
  };
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join("; ");
}

function parseDevOrigin(url: string): { http: string; ws: string } {
  const parsed = new URL(url);
  const http = parsed.origin;
  const ws = `${parsed.protocol === "https:" ? "wss" : "ws"}://${parsed.host}`;
  return { http, ws };
}

/** Browser permissions the renderer is allowed to request. There are none. */
export function permissionAllowed(_permission: string): boolean {
  return false;
}

/** Response headers that should be attached to every renderer document load. */
export function securityHeaders(options: ContentSecurityPolicyOptions = {}): Record<string, string[]> {
  return {
    "Content-Security-Policy": [contentSecurityPolicy(options)],
    "X-Content-Type-Options": ["nosniff"],
    "Referrer-Policy": ["no-referrer"],
  };
}
