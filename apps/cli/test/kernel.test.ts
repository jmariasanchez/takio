import { describe, expect, it } from "bun:test";

import {
  KERNEL_EXECUTABLES,
  VERIFIED_KERNEL_VERSION,
  compareKernelVersions,
  parseKernelVersion,
  resolveKernelReport,
  type KernelDiscoveries,
} from "../src/kernel.js";

const BUNDLE = "/Applications/calibre.app/Contents/MacOS";

function discoveries(
  overrides: Partial<Record<keyof KernelDiscoveries, KernelDiscoveries[keyof KernelDiscoveries]>> = {},
): KernelDiscoveries {
  return {
    conversion: { ok: true, path: `${BUNDLE}/ebook-convert` },
    metadata: { ok: true, path: `${BUNDLE}/ebook-meta` },
    onlineMetadata: { ok: true, path: `${BUNDLE}/fetch-ebook-metadata` },
    polish: { ok: true, path: `${BUNDLE}/ebook-polish` },
    ...overrides,
  } as KernelDiscoveries;
}

const neverProbed = async (): Promise<string | null> => {
  throw new Error("The version probe must not run for an unavailable kernel.");
};

describe("calibre kernel version parsing", () => {
  it("normalizes the differing version strings Calibre tools actually print", () => {
    expect(parseKernelVersion("ebook-convert (calibre 9.9.0)")).toBe("9.9.0");
    expect(parseKernelVersion("ebook-meta (calibre 9.9)")).toBe("9.9.0");
  });

  it("reports null when no version can be read", () => {
    expect(parseKernelVersion("")).toBeNull();
    expect(parseKernelVersion("command not found")).toBeNull();
  });

  it("orders versions numerically rather than lexically", () => {
    expect(compareKernelVersions("9.10.0", "9.9.0")).toBe(1);
    expect(compareKernelVersions("5.0.0", "5.0")).toBe(0);
    expect(compareKernelVersions("4.99.0", VERIFIED_KERNEL_VERSION)).toBe(-1);
  });
});

describe("calibre kernel report", () => {
  it("reports a ready kernel with resolved paths and discovery sources", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries(),
      env: {},
      platform: "darwin",
      probe: async () => "9.9.0",
      macosBundleDirectory: BUNDLE,
    });

    expect(report.status).toBe("ready");
    expect(report.version).toBe("9.9.0");
    expect(report.meetsVerifiedVersion).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.remediation).toBeNull();
    expect(report.executables).toHaveLength(KERNEL_EXECUTABLES.length);
    expect(report.executables.every((entry) => entry.source === "macos-bundle")).toBe(true);
  });

  it("reports an unavailable kernel without probing a version", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries({
        conversion: { ok: false, code: "backend-unavailable" },
        metadata: { ok: false, code: "backend-unavailable" },
        onlineMetadata: { ok: false, code: "backend-unavailable" },
        polish: { ok: false, code: "backend-unavailable" },
      }),
      env: {},
      platform: "linux",
      probe: neverProbed,
      macosBundleDirectory: BUNDLE,
    });

    expect(report.status).toBe("unavailable");
    expect(report.version).toBeNull();
    expect(report.meetsVerifiedVersion).toBeNull();
    expect(report.missing).toEqual([
      "ebook-convert",
      "ebook-meta",
      "fetch-ebook-metadata",
      "ebook-polish",
    ]);
    expect(report.remediation?.code).toBe("kernel-not-installed");
    expect(
      report.remediation?.actions.every(
        (action) => action.platform === "linux" || action.platform === "any",
      ),
    ).toBe(true);
  });

  it("keeps optional tools visible without making the required kernel unhealthy", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries({ polish: { ok: false, code: "backend-unavailable" } }),
      env: {},
      platform: "darwin",
      probe: async () => "9.9.0",
      macosBundleDirectory: BUNDLE,
    });

    expect(report.status).toBe("ready");
    expect(report.missing).toEqual(["ebook-polish"]);
    expect(report.remediation).toBeNull();
  });

  it("reports a partial required kernel as degraded even when optional tools exist", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries({ metadata: { ok: false, code: "backend-unavailable" } }),
      env: {},
      platform: "darwin",
      probe: async () => "9.9.0",
      macosBundleDirectory: BUNDLE,
    });

    expect(report.status).toBe("degraded");
    expect(report.remediation?.code).toBe("kernel-incomplete");
    expect(report.remediation?.actions).toContainEqual({
      platform: "any",
      kind: "override",
      command: "TAKIO_EBOOK_META=/absolute/path/to/ebook-meta takio doctor",
    });
  });

  it("does not mistake optional-only tools for an available conversion kernel", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries({
        conversion: { ok: false, code: "backend-unavailable" },
        metadata: { ok: false, code: "backend-unavailable" },
      }),
      env: {},
      platform: "darwin",
      probe: async () => "9.9.0",
      macosBundleDirectory: BUNDLE,
    });

    expect(report.status).toBe("unavailable");
    expect(report.remediation?.code).toBe("kernel-not-installed");
  });

  it("reports the verified-version comparison without disabling a discovered kernel", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries(),
      env: {},
      platform: "darwin",
      probe: async () => "4.23.0",
      macosBundleDirectory: BUNDLE,
    });

    expect(report.status).toBe("ready");
    expect(report.meetsVerifiedVersion).toBe(false);
    expect(report.remediation).toBeNull();
  });

  it("blames a broken override rather than a missing installation", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries({ conversion: { ok: false, code: "backend-unavailable" } }),
      env: { TAKIO_EBOOK_CONVERT: "/nope/ebook-convert" },
      platform: "darwin",
      probe: async () => "9.9.0",
      macosBundleDirectory: BUNDLE,
    });

    expect(report.status).toBe("degraded");
    expect(report.remediation?.code).toBe("kernel-override-invalid");
    expect(report.remediation?.actions[0]?.command).toBe(
      "TAKIO_EBOOK_CONVERT=/absolute/path/to/ebook-convert takio doctor",
    );
  });

  it("names the exact invalid metadata override in its remediation", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries({ metadata: { ok: false, code: "backend-unavailable" } }),
      env: { TAKIO_EBOOK_META: "/nope/ebook-meta" },
      platform: "darwin",
      probe: async () => "9.9.0",
      macosBundleDirectory: BUNDLE,
    });

    expect(report.remediation?.code).toBe("kernel-override-invalid");
    expect(report.remediation?.actions[0]?.command).toBe(
      "TAKIO_EBOOK_META=/absolute/path/to/ebook-meta takio doctor",
    );
  });

  it("distinguishes env, PATH, and bundle discovery sources", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries({ metadata: { ok: true, path: "/usr/local/bin/ebook-meta" } }),
      env: { TAKIO_FETCH_EBOOK_METADATA: `${BUNDLE}/fetch-ebook-metadata` },
      platform: "darwin",
      probe: async () => "9.9.0",
      macosBundleDirectory: BUNDLE,
    });

    const sources = Object.fromEntries(
      report.executables.map((entry) => [entry.binary, entry.source]),
    );
    expect(sources).toEqual({
      "ebook-convert": "macos-bundle",
      "ebook-meta": "path",
      "fetch-ebook-metadata": "env",
      "ebook-polish": "macos-bundle",
    });
  });

  it("keeps a complete discovered kernel ready when its version cannot be read", async () => {
    const report = await resolveKernelReport({
      discoveries: discoveries(),
      env: {},
      platform: "darwin",
      probe: async () => null,
      macosBundleDirectory: BUNDLE,
    });

    expect(report.version).toBeNull();
    expect(report.meetsVerifiedVersion).toBeNull();
    expect(report.status).toBe("ready");
    expect(report.remediation).toBeNull();
  });
});
