import { describe, expect, test } from "bun:test";

import { contentSecurityPolicy, permissionAllowed, securityHeaders } from "./security";

function directives(policy: string): Map<string, string> {
  return new Map(
    policy.split("; ").map((entry) => {
      const [name, ...rest] = entry.split(" ");
      return [name, rest.join(" ")];
    }),
  );
}

describe("renderer content security policy", () => {
  test("production denies everything except bundled assets and local covers", () => {
    const policy = directives(contentSecurityPolicy());
    expect(policy.get("default-src")).toBe("'none'");
    expect(policy.get("script-src")).toBe("'self'");
    expect(policy.get("connect-src")).toBe("'self'");
    expect(policy.get("img-src")).toBe("'self' takio-cover:");
    expect(policy.get("object-src")).toBe("'none'");
    expect(policy.get("frame-src")).toBe("'none'");
    expect(policy.get("frame-ancestors")).toBe("'none'");
    expect(policy.get("base-uri")).toBe("'none'");
    expect(policy.get("form-action")).toBe("'none'");
    expect(contentSecurityPolicy()).not.toContain("unsafe-eval");
    expect(policy.get("script-src")).not.toContain("unsafe-inline");
  });

  test("development only opens inline scripts and the HMR socket for the Vite origin", () => {
    const policy = directives(contentSecurityPolicy({ devServerUrl: "http://localhost:1420/" }));
    expect(policy.get("script-src")).toBe("'self' http://localhost:1420 'unsafe-inline'");
    expect(policy.get("connect-src")).toBe("'self' http://localhost:1420 ws://localhost:1420");
    expect(policy.get("img-src")).toBe("'self' http://localhost:1420 takio-cover:");
    expect(policy.get("object-src")).toBe("'none'");
    expect(policy.get("frame-src")).toBe("'none'");
    expect(contentSecurityPolicy({ devServerUrl: "http://localhost:1420/" })).not.toContain("unsafe-eval");
  });

  test("every directive is present exactly once", () => {
    const entries = contentSecurityPolicy().split("; ");
    const names = entries.map((entry) => entry.split(" ")[0]);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("default-src");
    expect(names).toContain("script-src");
    expect(names).toContain("style-src");
    expect(names).toContain("img-src");
    expect(names).toContain("connect-src");
  });

  test("meta delivery omits frame-ancestors, which browsers ignore there", () => {
    const meta = directives(contentSecurityPolicy({ delivery: "meta" }));
    expect(meta.has("frame-ancestors")).toBe(false);
    expect(meta.get("frame-src")).toBe("'none'");
    expect(meta.get("script-src")).toBe("'self'");
  });
});

describe("renderer permissions", () => {
  test("no browser permission is ever granted", () => {
    for (const permission of ["media", "geolocation", "notifications", "clipboard-read", "fullscreen", "openExternal"]) {
      expect(permissionAllowed(permission)).toBe(false);
    }
  });
});

describe("security headers", () => {
  test("attach CSP, nosniff, and no-referrer to document loads", () => {
    const headers = securityHeaders();
    expect(headers["Content-Security-Policy"]).toEqual([contentSecurityPolicy()]);
    expect(headers["X-Content-Type-Options"]).toEqual(["nosniff"]);
    expect(headers["Referrer-Policy"]).toEqual(["no-referrer"]);
  });
});
