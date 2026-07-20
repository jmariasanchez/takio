#!/usr/bin/env bun
import { readFile, writeFile } from "node:fs/promises";

type FakeControl = Readonly<{
  mode?: "success" | "missing" | "nonzero" | "sleep";
  opf?: string;
  opfBytes?: number;
  coverBase64?: string;
  coverBytes?: number;
  record?: string;
}>;

const [, , source, ...options] = process.argv;
if (!source) {
  process.exit(64);
}

let control: FakeControl = {};
try {
  const parsed = JSON.parse(await readFile(source, "utf8")) as {
    fakeEbookMeta?: FakeControl;
  };
  control = parsed.fakeEbookMeta ?? {};
} catch {
  // Ordinary source bytes use the default successful fixture.
}

const opfPath = options.find((option) => option.startsWith("--to-opf="))?.slice(9);
const coverPath = options.find((option) => option.startsWith("--get-cover="))?.slice(12);
if (!opfPath || !coverPath) {
  process.exit(64);
}

if (control.record) {
  await writeFile(
    control.record,
    JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      tmpdir: process.env.TMPDIR,
      environmentKeys: Object.keys(process.env).sort(),
    }),
  );
}

if (control.mode === "nonzero") {
  process.exit(7);
}
if (control.mode === "sleep") {
  await Bun.sleep(60_000);
}

if (control.mode === "missing") {
  process.exit(0);
}

await writeFile(
  opfPath,
  control.opfBytes === undefined
    ? (control.opf ?? "<package><metadata><dc:title>Default</dc:title></metadata></package>")
    : "x".repeat(control.opfBytes),
);
if (control.coverBase64 !== undefined) {
  await writeFile(coverPath, Buffer.from(control.coverBase64, "base64"));
} else if (control.coverBytes !== undefined) {
  await writeFile(coverPath, Buffer.alloc(control.coverBytes, 0xff));
}
