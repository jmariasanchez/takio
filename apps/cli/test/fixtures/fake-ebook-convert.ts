#!/usr/bin/env bun
import { copyFile, readFile, symlink, writeFile } from "node:fs/promises";

type FakeControl = {
  readonly mode?: "success" | "nonzero" | "empty" | "symlink" | "sleep";
  readonly record?: string;
  readonly started?: string;
  readonly finished?: string;
  readonly raceOutput?: string;
};

const [, , input, output] = process.argv;
if (!input || !output) {
  process.exit(64);
}

const inputBytes = await readFile(input);
let control: FakeControl = {};
try {
  const parsed = JSON.parse(inputBytes.toString()) as { fakeEbookConvert?: FakeControl };
  control = parsed.fakeEbookConvert ?? {};
} catch {
  // Ordinary input content means a successful byte-for-byte fake conversion.
}

if (control.record) {
  await writeFile(
    control.record,
    JSON.stringify({
      argv: process.argv.slice(2),
      tmpdir: process.env.TMPDIR,
      tmp: process.env.TMP,
      temp: process.env.TEMP,
      environmentKeys: Object.keys(process.env).sort(),
    }),
  );
}

if (control.started) {
  await writeFile(control.started, "started");
}

if (control.mode === "nonzero") {
  process.exit(7);
}

if (control.mode === "empty") {
  await writeFile(output, "");
  process.exit(0);
}

if (control.mode === "symlink") {
  await symlink(input, output);
  process.exit(0);
}

if (control.mode === "sleep") {
  await Bun.sleep(60_000);
}

await copyFile(input, output);

if (control.raceOutput) {
  await writeFile(control.raceOutput, "competing output");
}

if (control.finished) {
  await writeFile(control.finished, "finished");
}
