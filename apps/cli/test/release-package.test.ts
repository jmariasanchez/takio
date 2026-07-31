import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { packageCliRelease } from "../src/release-package.js";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("CLI release packaging", () => {
  it("publishes a named executable with a matching SHA-256 sidecar", async () => {
    directory = await mkdtemp(join(tmpdir(), "takio-release-"));
    const sourcePath = join(directory, "takio");
    await Bun.write(sourcePath, "standalone executable");
    const packaged = await packageCliRelease({
      sourcePath,
      outputDirectory: join(directory, "release"),
      version: "1.2.3",
      platform: "linux",
      arch: "x64",
    });

    expect(packaged.artifactPath).toEndWith("takio-v1.2.3-linux-x86_64");
    expect(packaged.sha256).toHaveLength(64);
    expect(await Bun.file(packaged.checksumPath).text()).toBe(
      `${packaged.sha256}  takio-v1.2.3-linux-x86_64\n`,
    );

    await expect(packageCliRelease({
      sourcePath,
      outputDirectory: join(directory, "release"),
      version: "1.2.3",
      platform: "linux",
      arch: "x64",
    })).rejects.toMatchObject({ code: "output-file-exists" });
    expect(await Bun.file(packaged.artifactPath).text()).toBe("standalone executable");
  });
});
