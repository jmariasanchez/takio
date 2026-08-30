import { chmod, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");
const extension = process.platform === "win32" ? ".exe" : "";
const source = join(root, "target", "release", `takio${extension}`);
const outputDirectory = join(import.meta.dir, "../resources/bin");
const output = join(outputDirectory, `takio-library-engine${extension}`);

const build = Bun.spawn({
  cmd: ["cargo", "build", "--release", "-p", "takio"],
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await build.exited;
if (exitCode !== 0) process.exit(exitCode);

await mkdir(outputDirectory, { recursive: true });
await copyFile(source, output);
if (process.platform !== "win32") await chmod(output, 0o755);
