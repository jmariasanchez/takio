#!/usr/bin/env bun
import { writeFile } from "node:fs/promises";

const options = process.argv.slice(2);
const cover = options.find((option) => option.startsWith("--cover="))?.slice(8);
const expected = [
  "--opf",
  "--title=Literal [title] $HOME",
  "--authors=First Author & Second Author",
  "--isbn=9780000000001",
  "--identifier=doi:10.1/example",
];

if (
  !expected.every((option, index) => options[index] === option) ||
  !cover ||
  options[6] !== "--timeout=5"
) {
  process.exit(64);
}

await writeFile(cover, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));
process.stdout.write(`<package><metadata>
  <dc:title>Fetched Title</dc:title>
  <dc:creator opf:role="aut">Fetched Author</dc:creator>
  <dc:identifier opf:scheme="ISBN">9780000000001</dc:identifier>
  <dc:description>Review before applying.</dc:description>
</metadata></package>`);
