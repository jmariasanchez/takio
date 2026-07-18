import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const triples: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc",
};
const triple = triples[`${process.platform}-${process.arch}`];
if (!triple) {
  throw new Error(`Unsupported desktop target: ${process.platform}-${process.arch}`);
}

const binariesDirectory = join(import.meta.dir, "../src-tauri/binaries");
const extension = process.platform === "win32" ? ".exe" : "";
const outputPath = join(binariesDirectory, `takio-library-engine-${triple}${extension}`);
await mkdir(binariesDirectory, { recursive: true });

const processResult = Bun.spawn({
  cmd: [
    process.execPath,
    "build",
    "--compile",
    join(import.meta.dir, "../../cli/src/main.ts"),
    "--outfile",
    outputPath,
  ],
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await processResult.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}
