#!/usr/bin/env bun
import { copyFile, readFile, writeFile } from "node:fs/promises";

const arguments_ = process.argv.slice(2);
const input = arguments_.at(-2);
const output = arguments_.at(-1);
if (!input || !output) process.exit(64);

let control: { mode?: "nonzero"; record?: string; mutateInput?: string } = {};
try {
  control = (JSON.parse((await readFile(input)).toString()) as { fakeEbookPolish?: typeof control })
    .fakeEbookPolish ?? {};
} catch {
  // Ordinary input content is copied as a successful polished artifact.
}
if (control.record) await writeFile(control.record, JSON.stringify({ argv: arguments_ }));
if (control.mode === "nonzero") process.exit(7);
if (control.mutateInput) await writeFile(input, control.mutateInput);
await copyFile(input, output);
