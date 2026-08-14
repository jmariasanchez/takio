#!/usr/bin/env bun

import { chmod, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const version = process.env.TAKIO_BUN_VERSION ?? process.versions.bun;
const repositoryRoot = resolve(import.meta.dir, "..");
const toolchainRoot = resolve(process.env.TAKIO_TOOLCHAIN_DIR ?? join(repositoryRoot, ".takio", "toolchains"));

const targets: Record<string, string> = {
  "darwin-arm64": "bun-darwin-aarch64",
  "darwin-x64": "bun-darwin-x64",
  "linux-arm64": "bun-linux-aarch64",
  "linux-x64": "bun-linux-x64",
};

const target = targets[`${process.platform}-${process.arch}`];
if (!target) {
  throw new Error(`No official Bun bootstrap target for ${process.platform}-${process.arch}`);
}

function output(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

function run(command: string[], options: { cwd?: string } = {}): string {
  const result = Bun.spawnSync({ cmd: command, cwd: options.cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${output(result.stderr)}`);
  }
  return output(result.stdout);
}

function verifyExecutable(executable: string): void {
  const actualVersion = run([executable, "--version"]);
  if (actualVersion !== version) {
    throw new Error(`Official Bun version mismatch: expected ${version}, got ${actualVersion}`);
  }
  if (process.platform === "darwin") {
    const dependencies = run(["/usr/bin/otool", "-L", executable])
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(" (compatibility version", 1)[0])
      .filter(Boolean)
      .filter(
        (dependency) =>
          !dependency.startsWith("/System/Library/") &&
          !dependency.startsWith("/usr/lib/") &&
          !dependency.startsWith("@rpath/") &&
          !dependency.startsWith("@loader_path/") &&
          !dependency.startsWith("@executable_path/"),
      );
    if (dependencies.length > 0) {
      throw new Error(`Official Bun has nonportable macOS dependencies:\n${dependencies.join("\n")}`);
    }
  }
}

const installDirectory = join(toolchainRoot, `bun-v${version}-${target}`);
const executablePath = join(installDirectory, target, "bun");

if (!existsSync(executablePath)) {
  await mkdir(toolchainRoot, { recursive: true });
  const temporaryDirectory = await Bun.$`mktemp -d ${join(tmpdir(), "takio-bun.XXXXXX")}`.text().then((value) => value.trim());
  try {
    const archiveName = `${target}.zip`;
    const archivePath = join(temporaryDirectory, archiveName);
    const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${archiveName}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed ${response.status} ${response.statusText}: ${url}`);
    await Bun.write(archivePath, await response.arrayBuffer());
    run(["/usr/bin/ditto", "-x", "-k", archivePath, temporaryDirectory]);
    await rm(installDirectory, { recursive: true, force: true });
    await mkdir(installDirectory, { recursive: true });
    run(["/bin/mv", join(temporaryDirectory, target), installDirectory]);
    await chmod(executablePath, 0o755);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

verifyExecutable(executablePath);
console.log(executablePath);
