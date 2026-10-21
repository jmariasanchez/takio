import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

import { contentSecurityPolicy } from "./electron/security";

/**
 * Packaged renderers load from `file://`, where Electron's `onHeadersReceived`
 * never runs. The production policy is therefore baked into the HTML as a meta
 * tag. Development keeps the header path so React Fast Refresh keeps working.
 */
function productionContentSecurityPolicy(): Plugin {
  return {
    name: "takio-production-csp",
    apply: "build",
    transformIndexHtml: {
      order: "pre",
      handler: () => [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy({ delivery: "meta" }) },
          injectTo: "head-prepend",
        },
      ],
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), productionContentSecurityPolicy()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
