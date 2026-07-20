import { describe, expect, test } from "bun:test";

import {
  assertMatchingBunVersion,
  createCompileCommand,
  nonportableMacOsDependencies,
} from "./build-library-engine-helpers";

describe("macOS sidecar portability", () => {
  test("accepts dependencies provided by macOS for an official Bun runtime", () => {
    const dependencies = nonportableMacOsDependencies(`/path/to/bun:
\t/usr/lib/libicucore.A.dylib (compatibility version 1.0.0, current version 74.2.0)
\t/usr/lib/libresolv.9.dylib (compatibility version 1.0.0, current version 1.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)`);

    expect(dependencies).toEqual([]);
  });

  test("rejects Nix and other machine-local dylibs that cannot ship in the app bundle", () => {
    const dependencies = nonportableMacOsDependencies(`/path/to/bun:
\t/nix/store/icu/lib/libicucore.A.dylib (compatibility version 1.0.0, current version 76.1.0)
\t/opt/homebrew/lib/libexample.dylib (compatibility version 1.0.0, current version 1.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)`);

    expect(dependencies).toEqual([
      "/nix/store/icu/lib/libicucore.A.dylib",
      "/opt/homebrew/lib/libexample.dylib",
    ]);
  });
});

describe("Bun compile runtime selection", () => {
  test("accepts an exact version match and rejects a different compiler runtime", () => {
    expect(() => assertMatchingBunVersion("1.3.13", "1.3.13")).not.toThrow();
    expect(() => assertMatchingBunVersion("1.3.13", "1.3.14")).toThrow(
      "Bun compile executable version mismatch: expected 1.3.13, got 1.3.14",
    );
  });

  test("constructs compile arguments with and without an explicit portable runtime", () => {
    expect(createCompileCommand("/usr/bin/bun", "/src/main.ts", "/out/engine")).toEqual([
      "/usr/bin/bun",
      "build",
      "--compile",
      "/src/main.ts",
      "--outfile",
      "/out/engine",
    ]);
    expect(
      createCompileCommand(
        "/nix/store/bun/bin/bun",
        "/src/main.ts",
        "/out/engine",
        "/opt/official-bun/bin/bun",
      ),
    ).toEqual([
      "/nix/store/bun/bin/bun",
      "build",
      "--compile",
      "--compile-executable-path=/opt/official-bun/bin/bun",
      "/src/main.ts",
      "--outfile",
      "/out/engine",
    ]);
  });
});
