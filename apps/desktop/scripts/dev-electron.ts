import { join } from "node:path";

const packageRoot = join(import.meta.dir, "..");

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { cwd: packageRoot, stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) process.exit(code);
}

await run(["bun", "run", "build:engine"]);
await run(["bun", "run", "build:electron"]);

const vite = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", "1420"], {
  cwd: packageRoot,
  stdout: "inherit",
  stderr: "inherit",
});

for (let attempt = 0; attempt < 100; attempt += 1) {
  try {
    const response = await fetch("http://127.0.0.1:1420", { signal: AbortSignal.timeout(200) });
    if (response.ok) break;
  } catch {
    await Bun.sleep(100);
  }
}

const electron = Bun.spawn(["bunx", "electron", "."], {
  cwd: packageRoot,
  env: { ...process.env, VITE_DEV_SERVER_URL: "http://127.0.0.1:1420" },
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await electron.exited;
vite.kill();
process.exit(exitCode);
