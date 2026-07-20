import { join, tempDir } from "@tauri-apps/api/path";

export type ConversionOutputDependencies = {
  readonly getTempDirectory: () => Promise<string>;
  readonly joinPath: (directory: string, fileName: string) => Promise<string>;
  readonly randomUuid: () => string;
};

const defaultDependencies: ConversionOutputDependencies = {
  getTempDirectory: tempDir,
  joinPath: join,
  randomUuid: () => crypto.randomUUID(),
};

export async function createConversionOutputPath(
  dependencies: ConversionOutputDependencies = defaultDependencies,
): Promise<string> {
  const directory = await dependencies.getTempDirectory();
  return dependencies.joinPath(
    directory,
    `takio-conversion-${dependencies.randomUuid()}.pdf`,
  );
}
