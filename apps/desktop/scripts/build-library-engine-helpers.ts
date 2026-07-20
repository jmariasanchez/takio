const portableMacOsDependencyPrefixes = [
  "/System/Library/",
  "/usr/lib/",
  "@rpath/",
  "@loader_path/",
  "@executable_path/",
];

export function nonportableMacOsDependencies(otoolOutput: string): string[] {
  return otoolOutput
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(" (compatibility version", 1)[0])
    .filter(
      (dependency) =>
        dependency.length > 0 &&
        !portableMacOsDependencyPrefixes.some((prefix) => dependency.startsWith(prefix)),
    );
}

export function assertMatchingBunVersion(expectedVersion: string, actualVersion: string): void {
  if (actualVersion !== expectedVersion) {
    throw new Error(
      "Bun compile executable version mismatch: expected " +
        expectedVersion +
        ", got " +
        actualVersion,
    );
  }
}

export function createCompileCommand(
  bunExecutablePath: string,
  inputPath: string,
  outputPath: string,
  compileExecutablePath?: string,
): string[] {
  const command = [
    bunExecutablePath,
    "build",
    "--compile",
    inputPath,
    "--outfile",
    outputPath,
  ];
  if (compileExecutablePath) {
    command.splice(3, 0, "--compile-executable-path=" + compileExecutablePath);
  }
  return command;
}
