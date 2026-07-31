import { join } from "node:path";

import { packageCliRelease } from "../apps/cli/src/release-package.js";

const root = join(import.meta.dir, "..");
const manifest = await Bun.file(join(root, "package.json")).json() as { version?: unknown };
if (typeof manifest.version !== "string") throw new TypeError("package.json version is required.");

const result = await packageCliRelease({
  sourcePath: join(root, "apps", "cli", "dist", "takio"),
  outputDirectory: join(root, "dist", "releases"),
  version: manifest.version,
});
console.log(JSON.stringify({ ok: true, value: { release: result } }));
