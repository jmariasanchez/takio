import { createHash } from "node:crypto";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { candidateCoverResponse, candidateCoverUrl, localCoverResponse } from "./candidate-cover-protocol";

const token = "0123456789abcdef0123456789abcdef";
const otherToken = "fedcba9876543210fedcba9876543210";
const bytes = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]);

async function fixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "takio-cover-test-"));
  const covers = join(root, "candidate-covers");
  await mkdir(covers);
  const manifest = {
    schemaVersion: 1,
    artifactId: token,
    itemId: "book-1",
    candidateId: "embedded:1",
    source: "embedded",
    provenance: "ebook-meta",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    mediaType: "image/jpeg",
    extension: ".jpg",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
  await writeFile(join(covers, `${token}.json`), JSON.stringify(manifest));
  await writeFile(join(covers, `${token}.bin`), bytes);
  return { root, covers };
}

describe("candidate cover protocol", () => {
  test("local covers never follow a file or directory symlink outside the cover root", async () => {
    const root = await mkdtemp(join(tmpdir(), "takio-local-cover-test-"));
    const covers = join(root, "covers");
    const outside = await mkdtemp(join(tmpdir(), "takio-local-cover-outside-"));
    await mkdir(covers);
    await writeFile(join(covers, "safe.jpg"), bytes);
    await writeFile(join(outside, "secret.jpg"), bytes);
    expect((await localCoverResponse(`takio-cover://local/${encodeURIComponent(join(covers, "safe.jpg"))}`, root)).status).toBe(200);

    await symlink(join(outside, "secret.jpg"), join(covers, "linked-file.jpg"));
    await symlink(outside, join(covers, "linked-directory"));
    for (const path of [join(covers, "linked-file.jpg"), join(covers, "linked-directory", "secret.jpg"), join(outside, "secret.jpg")]) {
      expect((await localCoverResponse(`takio-cover://local/${encodeURIComponent(path)}`, root)).status).toBe(404);
    }
  });

  test("builds path-free URLs and serves an exact verified media response", async () => {
    const { root } = await fixture();
    expect(candidateCoverUrl(token)).toBe(`takio-cover://candidate/${token}`);
    expect(candidateCoverUrl("../cover.jpg")).toBeNull();
    const response = await candidateCoverResponse(`takio-cover://candidate/${token}`, root);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  });

  test("denies malformed, forged, path-bearing, expired, changed, and cross-token artifacts", async () => {
    const malformed = await fixture({ extension: ".png" });
    const expired = await fixture({ expiresAt: new Date(Date.now() - 1).toISOString() });
    const crossToken = await fixture({ artifactId: otherToken });
    const changed = await fixture();
    await writeFile(join(changed.covers, `${token}.bin`), Buffer.from("changed"));
    for (const [url, root] of [
      [`takio-cover://candidate/${token}`, malformed.root],
      [`takio-cover://candidate/${token}`, expired.root],
      [`takio-cover://candidate/${token}`, crossToken.root],
      [`takio-cover://candidate/${token}`, changed.root],
      ["takio-cover://candidate/../cover.jpg", changed.root],
      [`takio-cover://candidate/${token}?path=/private/cover.jpg`, changed.root],
      [`takio-cover://local/${token}`, changed.root],
      [`takio-cover://candidate/${token.toUpperCase()}`, changed.root],
    ] as const) {
      expect((await candidateCoverResponse(url, root)).status).toBe(404);
    }
  });

  test("denies symlinked, nonregular, oversized, and unknown-manifest inputs", async () => {
    const linked = await fixture();
    await unlink(join(linked.covers, `${token}.bin`));
    await symlink(join(linked.covers, `${token}.json`), join(linked.covers, `${token}.bin`));
    expect((await candidateCoverResponse(`takio-cover://candidate/${token}`, linked.root)).status).toBe(404);

    const unknown = await fixture({ unexpected: true });
    expect((await candidateCoverResponse(`takio-cover://candidate/${token}`, unknown.root)).status).toBe(404);

    const oversized = await fixture({ bytes: 32 * 1024 * 1024 + 1 });
    expect((await candidateCoverResponse(`takio-cover://candidate/${token}`, oversized.root)).status).toBe(404);
  });
});
