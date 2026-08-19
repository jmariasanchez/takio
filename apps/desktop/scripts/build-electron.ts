import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const outputDirectory = join(import.meta.dir, "../dist-electron");
await mkdir(outputDirectory, { recursive: true });

const shared = {
  target: "node" as const,
  external: ["electron"],
  sourcemap: "external" as const,
  minify: false,
};

const [main, preload] = await Promise.all([
  Bun.build({
    ...shared,
    entrypoints: [join(import.meta.dir, "../electron/main.ts")],
    outdir: outputDirectory,
    format: "esm",
    naming: "main.js",
  }),
  Bun.build({
    ...shared,
    entrypoints: [join(import.meta.dir, "../electron/preload.ts")],
    outdir: outputDirectory,
    format: "cjs",
    naming: "preload.cjs",
  }),
]);

if (!main.success || !preload.success) {
  for (const log of [...main.logs, ...preload.logs]) {
    console.error(log);
  }
  process.exit(1);
}
