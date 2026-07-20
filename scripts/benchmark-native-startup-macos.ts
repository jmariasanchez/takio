const MARKER = "TAKIO_LIBRARY_USABLE";
const ROADMAP_LIMIT_MILLISECONDS = 2_000;
const TIMEOUT_MILLISECONDS = 10_000;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must name an existing benchmark input.`);
  }
  return value;
}

if (process.platform !== "darwin") {
  throw new Error("Native startup benchmarking requires macOS.");
}

const executable = requiredEnvironment("TAKIO_NATIVE_STARTUP_EXECUTABLE");
const dataDirectory = requiredEnvironment("TAKIO_DATA_DIR");
const startedAt = performance.now();
const child = Bun.spawn({
  cmd: [executable],
  env: {
    ...process.env,
    TAKIO_DATA_DIR: dataDirectory,
    TAKIO_STARTUP_BENCHMARK: "1",
  },
  stdout: "ignore",
  stderr: "pipe",
});

const reader = child.stderr.getReader();
const decoder = new TextDecoder();
let output = "";
const markerMeasurement = (async (): Promise<number> => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      throw new Error(
        `Takio exited before the library became usable (exit ${await child.exited}): ${output}`,
      );
    }
    output += decoder.decode(value, { stream: true });
    if (output.includes(MARKER)) {
      return performance.now() - startedAt;
    }
  }
})();
markerMeasurement.catch(() => undefined);

let timeout: ReturnType<typeof setTimeout> | undefined;
const timedOut = new Promise<never>((_, reject) => {
  timeout = setTimeout(() => {
    reject(new Error(`Timed out waiting for ${MARKER}: ${output}`));
  }, TIMEOUT_MILLISECONDS);
});

try {
  const elapsed = await Promise.race([markerMeasurement, timedOut]);
  console.info(
    `[native-startup] spawn-to-library-usable=${elapsed.toFixed(1)}ms ` +
      `roadmap<=${ROADMAP_LIMIT_MILLISECONDS}ms`,
  );
  if (elapsed > ROADMAP_LIMIT_MILLISECONDS) {
    process.exitCode = 1;
  }
} finally {
  if (timeout) clearTimeout(timeout);
  child.kill("SIGTERM");
  await child.exited;
}
