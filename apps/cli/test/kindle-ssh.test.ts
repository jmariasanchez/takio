import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommanderError } from "commander";

import { DestinationTransferError } from "../src/destinations.js";
import { sendToKindleSsh, validateKindleSshDestination, type KindleSshRunner } from "../src/kindle-ssh.js";
import { createProgram } from "../src/main.js";

async function tempFile(content = "kindle ssh bytes\n") {
  const root = await mkdtemp(join(tmpdir(), "takio-kindle-ssh-"));
  const source = join(root, "book.epub");
  await writeFile(source, content);
  return { root, source, content };
}

function baseDestination(overrides: Record<string, unknown> = {}) {
  return {
    host: "kindle.local",
    user: "root",
    port: 22,
    remoteRoot: "/mnt/us/documents/koreader",
    timeoutMs: 5_000,
    ...overrides,
  } as any;
}

function expectInvalid(destination: Record<string, unknown>) {
  expect(() => validateKindleSshDestination(baseDestination(destination))).toThrow(DestinationTransferError);
}

describe("rooted Kindle SSH transport", () => {
  test("rejects hostile host user port key and remote path arguments before spawning", () => {
    for (const destination of [
      { host: "-oProxyCommand=sh" },
      { host: "kindle.local;touch x" },
      { user: "root;sh" },
      { user: "-root" },
      { port: 0 },
      { port: 65_536 },
      { identityFile: "relative-key" },
      { identityFile: "/keys/-bad" },
      { remoteRoot: "/home/root/documents" },
      { remoteRoot: "/mnt/us/../documents" },
      { remoteRoot: "/mnt/us/books" },
      { remoteRoot: "/mnt/us/documents/evil space" },
      { timeoutMs: 999 },
    ]) {
      expectInvalid(destination);
    }
  });

  test("uses strict argv arrays, private partial upload, sha256 verification, and non-overwrite publication", async () => {
    const { root, source, content } = await tempFile();
    try {
      const expectedHash = createHash("sha256").update(content).digest("hex");
      const calls: readonly string[][] = [];
      const runner: KindleSshRunner = async (argv, options) => {
        calls.push([...argv]);
        expect(options.timeoutMs).toBe(5_000);
        expect(argv.some((arg) => arg.includes("StrictHostKeyChecking=yes"))).toBe(true);
        expect(argv.some((arg) => arg === "PasswordAuthentication=no")).toBe(true);
        if (argv.includes("sha256sum")) return { exitCode: 0, stdout: `${expectedHash}  ${argv.at(-1)}\n` };
        return { exitCode: 0, stdout: "" };
      };

      const result = await sendToKindleSsh({
        itemId: "book-1",
        sourcePath: source,
        fileName: "Clean-Name.epub",
        destination: baseDestination(),
        runner,
      });

      expect(result).toMatchObject({
        itemId: "book-1",
        transport: "kindle-ssh",
        path: "/mnt/us/documents/koreader/Clean-Name.epub",
        sha256: expectedHash,
        bytes: Buffer.byteLength(content),
        verification: "sha256",
      });
      expect(calls[0]).toEqual(["ssh", "-p", "22", "-o", "StrictHostKeyChecking=yes", "-o", "BatchMode=yes", "-o", "PasswordAuthentication=no", "root@kindle.local", "test", "-d", "/mnt/us/documents/koreader"]);
      expect(calls.some((argv) => argv[0] === "scp" && argv[argv.length - 1]?.startsWith("root@kindle.local:/mnt/us/documents/koreader/.takio-partial-"))).toBe(true);
      expect(calls.some((argv) => argv.includes("ln") && argv.at(-1) === "/mnt/us/documents/koreader/Clean-Name.epub")).toBe(true);
      expect(calls.every((argv) => !argv.join(" ").includes(";"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports collision without uploading", async () => {
    const { root, source } = await tempFile();
    try {
      const calls: readonly string[][] = [];
      const runner: KindleSshRunner = async (argv) => {
        calls.push([...argv]);
        if (argv.includes("!") && argv.includes("-e")) return { exitCode: 1 };
        return { exitCode: 0 };
      };
      await expect(sendToKindleSsh({ itemId: "id", sourcePath: source, destination: baseDestination(), runner })).rejects.toThrow("destination-file-exists");
      expect(calls.some((argv) => argv[0] === "scp")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to remote size when sha256sum is unavailable and fails mismatched verification", async () => {
    const { root, source } = await tempFile("abcdef");
    try {
      const runner: KindleSshRunner = async (argv) => {
        if (argv.includes("sha256sum")) return { exitCode: 127 };
        if (argv.includes("wc")) return { exitCode: 0, stdout: "999 /mnt/us/documents/koreader/.takio-partial-x\n" };
        return { exitCode: 0 };
      };
      await expect(sendToKindleSsh({ itemId: "id", sourcePath: source, destination: baseDestination(), runner })).rejects.toThrow("verification-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps runner timeout failures to copy-failed", async () => {
    const { root, source } = await tempFile();
    try {
      const runner: KindleSshRunner = async () => ({ exitCode: 124 });
      await expect(sendToKindleSsh({ itemId: "id", sourcePath: source, destination: baseDestination(), runner })).rejects.toThrow("copy-failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI emits stable JSON capability and gated unavailable transport reporting", async () => {
    const output: string[] = [];
    await createProgram((line) => output.push(line)).parseAsync(["bun", "takio", "capabilities"]);
    const parsed = JSON.parse(output[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.value.transports.rootedKindleSsh).toMatchObject({ available: true, gated: true, optInRequired: true, passwordHandling: false, hostKeyCheckingDefault: "strict" });
    expect(parsed.value.transports.mtp).toMatchObject({ available: false, gated: true, code: "unsupported-transport" });
    expect(parsed.value.transports.sendToKindle).toMatchObject({ available: false, gated: true, code: "unsupported-transport" });
  });

  test("CLI command resolves an existing library format and uses the injected process boundary", async () => {
    const { root, source, content } = await tempFile();
    const dataRoot = join(root, "data");
    const output: string[] = [];
    const previousDataDir = process.env.TAKIO_DATA_DIR;
    process.env.TAKIO_DATA_DIR = dataRoot;
    try {
      const importOutput: string[] = [];
      await createProgram((line) => importOutput.push(line), (line) => importOutput.push(line)).parseAsync([
        "bun", "takio", "library", "import", "--source-path", source,
      ]);
      const itemId = JSON.parse(importOutput[0]!).value.item.id;
      const expectedHash = createHash("sha256").update(content).digest("hex");
      const runner: KindleSshRunner = async (argv) => argv.includes("sha256sum") ? { exitCode: 0, stdout: `${expectedHash} remote\n` } : { exitCode: 0 };
      await createProgram((line) => output.push(line), (line) => output.push(line), undefined, undefined, undefined, undefined, undefined, undefined, runner).parseAsync([
        "bun", "takio", "destination", "rooted-kindle-send",
        "--id", itemId,
        "--format", "epub",
        "--host", "kindle.local",
        "--user", "root",
        "--remote-root", "/mnt/us/documents/koreader",
        "--identity-file", "/Users/test/.ssh/kindle",
        "--port", "22",
        "--timeout-ms", "5000",
      ]);
      const parsed = JSON.parse(output[0]!);
      expect(parsed.ok).toBe(true);
      expect(parsed.value).toMatchObject({ itemId, transport: "kindle-ssh" });
    } finally {
      if (previousDataDir === undefined) delete process.env.TAKIO_DATA_DIR;
      else process.env.TAKIO_DATA_DIR = previousDataDir;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("CLI rejects invalid rooted Kindle arguments as stable JSON", async () => {
    const output: string[] = [];
    try {
      await createProgram((line) => output.push(line), (line) => output.push(line)).parseAsync([
        "bun", "takio", "destination", "rooted-kindle-send",
        "--id", "bad",
        "--format", "epub",
        "--host", "-oProxyCommand=x",
        "--user", "root",
        "--remote-root", "/mnt/us/documents/koreader",
        "--identity-file", "/Users/test/.ssh/kindle",
        "--port", "22",
        "--timeout-ms", "5000",
      ]);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(CommanderError);
      expect(JSON.parse(output[0]!)).toEqual({ ok: false, error: { code: "invalid-arguments" } });
    }
  });
});
