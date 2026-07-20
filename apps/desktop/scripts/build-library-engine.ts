import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const portableMacOsDependencyPrefixes = [
  "/System/Library/",
  "/usr/lib/",
  "@rpath/",
  "@loader_path/",
  "@executable_path/",
];

function commandOutput(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

function assertPortableMacOsDependencies(executablePath: string, label: string): void {
  const result = Bun.spawnSync({
    cmd: ["/usr/bin/otool", "-L", executablePath],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "Could not inspect " + label + " dependencies: " + commandOutput(result.stderr),
    );
  }

  const dependencies = commandOutput(result.stdout)
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (compatibility version", 1)[0])
    .filter(Boolean);
  const nonportableDependencies = dependencies.filter(
    (dependency) =>
      !portableMacOsDependencyPrefixes.some((prefix) => dependency.startsWith(prefix)),
  );
  if (nonportableDependencies.length > 0) {
    throw new Error(
      [
        label + " has nonportable macOS dependencies:",
        ...nonportableDependencies.map((dependency) => "  " + dependency),
        "Use an official, version-matched Bun executable by setting",
        "TAKIO_BUN_COMPILE_EXECUTABLE=/absolute/path/to/bun.",
      ].join("\n"),
    );
  }
}

function verifyBunVersion(executablePath: string): void {
  const result = Bun.spawnSync({
    cmd: [executablePath, "--version"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "Could not run Bun compile executable at " +
        executablePath +
        ": " +
        commandOutput(result.stderr),
    );
  }

  const actualVersion = commandOutput(result.stdout);
  const expectedVersion = process.versions.bun;
  if (actualVersion !== expectedVersion) {
    throw new Error(
      "Bun compile executable version mismatch: expected " +
        expectedVersion +
        ", got " +
        actualVersion,
    );
  }
}

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
const compileExecutableOverride = process.env.TAKIO_BUN_COMPILE_EXECUTABLE;
const compileExecutablePath = resolve(compileExecutableOverride ?? process.execPath);

if (compileExecutableOverride) {
  verifyBunVersion(compileExecutablePath);
}
if (process.platform === "darwin") {
  assertPortableMacOsDependencies(compileExecutablePath, "Bun compile executable");
}

await mkdir(binariesDirectory, { recursive: true });

const compileCommand = [
  process.execPath,
  "build",
  "--compile",
  join(import.meta.dir, "../../cli/src/main.ts"),
  "--outfile",
  outputPath,
];
if (compileExecutableOverride) {
  compileCommand.splice(3, 0, "--compile-executable-path=" + compileExecutablePath);
}
const processResult = Bun.spawn({
  cmd: compileCommand,
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await processResult.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}
if (process.platform === "darwin") {
  assertPortableMacOsDependencies(outputPath, "Compiled library engine");
}
