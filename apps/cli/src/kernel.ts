import { discoverEbookConvert, type EbookConvertDiscovery } from "./convert.js";
import { discoverEbookPolish, type EbookPolishDiscovery } from "./calibre-maintenance.js";
import {
  discoverEbookMeta,
  discoverFetchEbookMetadata,
  type EbookMetaDiscovery,
} from "./metadata.js";

export const KERNEL_NAME = "calibre";
export const VERIFIED_KERNEL_VERSION = "9.9.0";
export const KERNEL_VERSION_PROBE_TIMEOUT_MS = 5_000;

const MACOS_BUNDLE_DIRECTORY = "/Applications/calibre.app/Contents/MacOS";

export const KERNEL_ROLES = [
  "conversion",
  "metadata",
  "onlineMetadata",
  "polish",
] as const;

export type KernelRole = (typeof KERNEL_ROLES)[number];

export type KernelBinaryName =
  | "ebook-convert"
  | "ebook-meta"
  | "fetch-ebook-metadata"
  | "ebook-polish";

export type KernelOverrideVariable =
  | "TAKIO_EBOOK_CONVERT"
  | "TAKIO_EBOOK_META"
  | "TAKIO_FETCH_EBOOK_METADATA"
  | "TAKIO_EBOOK_POLISH";

type KernelExecutableDefinition = {
  readonly role: KernelRole;
  readonly binary: KernelBinaryName;
  readonly override: KernelOverrideVariable;
  readonly purpose: string;
  readonly required: boolean;
};

export const KERNEL_EXECUTABLES: readonly KernelExecutableDefinition[] = [
  {
    role: "conversion",
    binary: "ebook-convert",
    override: "TAKIO_EBOOK_CONVERT",
    purpose: "Convert between the advertised format pairs.",
    required: true,
  },
  {
    role: "metadata",
    binary: "ebook-meta",
    override: "TAKIO_EBOOK_META",
    purpose: "Read embedded metadata and write it into delivery copies.",
    required: true,
  },
  {
    role: "onlineMetadata",
    binary: "fetch-ebook-metadata",
    override: "TAKIO_FETCH_EBOOK_METADATA",
    purpose: "Fetch reviewable online metadata candidates.",
    required: false,
  },
  {
    role: "polish",
    binary: "ebook-polish",
    override: "TAKIO_EBOOK_POLISH",
    purpose: "Publish polished same-format artifacts.",
    required: false,
  },
];

export type KernelDiscoverySource = "env" | "path" | "macos-bundle";

export type KernelExecutableReport = {
  readonly role: KernelRole;
  readonly binary: KernelBinaryName;
  readonly purpose: string;
  readonly required: boolean;
  readonly override: KernelOverrideVariable;
  readonly available: boolean;
  readonly path: string | null;
  readonly source: KernelDiscoverySource | null;
  readonly code: "invalid-arguments" | "backend-unavailable" | null;
};

export const KERNEL_STATUSES = ["ready", "degraded", "unavailable"] as const;

export type KernelStatus = (typeof KERNEL_STATUSES)[number];

export const KERNEL_REMEDIATION_CODES = [
  "kernel-not-installed",
  "kernel-incomplete",
  "kernel-override-invalid",
] as const;

export type KernelRemediationCode = (typeof KERNEL_REMEDIATION_CODES)[number];

export type KernelRemediationAction = {
  readonly platform: NodeJS.Platform | "any";
  readonly kind: "install" | "download" | "override" | "upgrade" | "verify";
  readonly command: string;
};

export type KernelRemediation = {
  readonly code: KernelRemediationCode;
  readonly summary: string;
  readonly docs: string;
  readonly actions: readonly KernelRemediationAction[];
};

export type KernelReport = {
  readonly name: typeof KERNEL_NAME;
  readonly role: "conversion-kernel";
  readonly status: KernelStatus;
  readonly version: string | null;
  readonly verifiedVersion: typeof VERIFIED_KERNEL_VERSION;
  readonly meetsVerifiedVersion: boolean | null;
  readonly executables: readonly KernelExecutableReport[];
  readonly missing: readonly KernelBinaryName[];
  readonly remediation: KernelRemediation | null;
};

export type KernelDiscoveries = {
  readonly conversion: EbookConvertDiscovery;
  readonly metadata: EbookMetaDiscovery;
  readonly onlineMetadata: EbookMetaDiscovery;
  readonly polish: EbookPolishDiscovery;
};

export type KernelVersionProbe = (executablePath: string) => Promise<string | null>;

const INSTALL_ACTIONS: readonly KernelRemediationAction[] = [
  { platform: "darwin", kind: "install", command: "brew install --cask calibre" },
  {
    platform: "darwin",
    kind: "download",
    command: "open https://calibre-ebook.com/download_osx",
  },
  {
    platform: "linux",
    kind: "install",
    command:
      "sudo -v && wget -nv -O- https://download.calibre-ebook.com/linux-installer.sh | sudo sh /dev/stdin",
  },
  { platform: "win32", kind: "install", command: "winget install --id calibre.calibre" },
  { platform: "any", kind: "verify", command: "takio doctor" },
];

function overrideAction(
  executable: Pick<KernelExecutableReport, "binary" | "override">,
): KernelRemediationAction {
  return {
    platform: "any",
    kind: "override",
    command: `${executable.override}=/absolute/path/to/${executable.binary} takio doctor`,
  };
}

const DOCS_URL = "https://calibre-ebook.com/download";

export function kernelRemediation(
  code: KernelRemediationCode,
  executables: readonly Pick<KernelExecutableReport, "binary" | "override">[],
  platform: NodeJS.Platform = process.platform,
): KernelRemediation {
  const forPlatform = (actions: readonly KernelRemediationAction[]) =>
    actions.filter((action) => action.platform === "any" || action.platform === platform);
  const overrideActions = executables.map(overrideAction);

  switch (code) {
    case "kernel-not-installed":
      return {
        code,
        summary:
          "Takio uses Calibre as its conversion kernel; the required Calibre executable was not found.",
        docs: DOCS_URL,
        actions: forPlatform([...INSTALL_ACTIONS, ...overrideActions]),
      };
    case "kernel-incomplete":
      return {
        code,
        summary:
          "Calibre was found but at least one required executable is missing from this installation.",
        docs: DOCS_URL,
        actions: forPlatform([...INSTALL_ACTIONS, ...overrideActions]),
      };
    case "kernel-override-invalid":
      return {
        code,
        summary:
          "A TAKIO_* kernel override is set but does not point at a readable executable file.",
        docs: DOCS_URL,
        actions: forPlatform([...overrideActions, ...INSTALL_ACTIONS]),
      };
  }
}

function normalizeKernelVersion(version: string): string {
  const parts = version.split(".").slice(0, 3);
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

export function parseKernelVersion(output: string): string | null {
  const labelled = /calibre[^0-9]*([0-9]+(?:\.[0-9]+)*)/i.exec(output);
  if (labelled?.[1]) return normalizeKernelVersion(labelled[1]);
  const bare = /([0-9]+(?:\.[0-9]+){1,3})/.exec(output);
  return bare?.[1] ? normalizeKernelVersion(bare[1]) : null;
}

export function compareKernelVersions(left: string, right: string): number {
  const leftParts = left.split(".");
  const rightParts = right.split(".");
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = Number(leftParts[index] ?? "0");
    const rightPart = Number(rightParts[index] ?? "0");
    if (!Number.isFinite(leftPart) || !Number.isFinite(rightPart)) return 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export async function probeKernelVersion(executablePath: string): Promise<string | null> {
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([executablePath, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return null;
  }

  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The awaited exit status stays authoritative after a best-effort kill.
    }
  }, KERNEL_VERSION_PROBE_TIMEOUT_MS);
  timer.unref();

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) return null;
    return parseKernelVersion(`${stdout}\n${stderr}`);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function discoverySource(
  definition: KernelExecutableDefinition,
  path: string,
  env: NodeJS.ProcessEnv,
  macosBundleDirectory: string,
): KernelDiscoverySource {
  if (Object.hasOwn(env, definition.override)) return "env";
  if (path === `${macosBundleDirectory}/${definition.binary}`) return "macos-bundle";
  return "path";
}

export async function discoverKernel(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<KernelDiscoveries> {
  const [conversion, metadata, onlineMetadata, polish] = await Promise.all([
    discoverEbookConvert(env, platform),
    discoverEbookMeta(env, platform),
    discoverFetchEbookMetadata(env, platform),
    discoverEbookPolish(env, platform),
  ]);
  return { conversion, metadata, onlineMetadata, polish };
}

export async function resolveKernelReport({
  discoveries,
  env = process.env,
  platform = process.platform,
  probe = probeKernelVersion,
  macosBundleDirectory = MACOS_BUNDLE_DIRECTORY,
}: {
  readonly discoveries: KernelDiscoveries;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly probe?: KernelVersionProbe;
  readonly macosBundleDirectory?: string;
}): Promise<KernelReport> {
  const executables = KERNEL_EXECUTABLES.map((definition): KernelExecutableReport => {
    const discovery = discoveries[definition.role];
    return {
      role: definition.role,
      binary: definition.binary,
      purpose: definition.purpose,
      required: definition.required,
      override: definition.override,
      available: discovery.ok,
      path: discovery.ok ? discovery.path : null,
      source: discovery.ok
        ? discoverySource(definition, discovery.path, env, macosBundleDirectory)
        : null,
      code: discovery.ok ? null : discovery.code,
    };
  });

  const available = executables.filter((executable) => executable.available);
  const required = executables.filter((executable) => executable.required);
  const availableRequired = required.filter((executable) => executable.available);
  const missingRequired = required.filter((executable) => !executable.available);
  const missing = executables
    .filter((executable) => !executable.available)
    .map((executable) => executable.binary);
  const invalidOverrides = executables.filter(
    (executable) =>
      executable.required && !executable.available && Object.hasOwn(env, executable.override),
  );

  const probeTarget =
    available.find((executable) => executable.role === "conversion") ?? available[0];
  const version = probeTarget?.path ? await probe(probeTarget.path) : null;
  const meetsVerifiedVersion =
    version === null
      ? null
      : compareKernelVersions(version, VERIFIED_KERNEL_VERSION) >= 0;

  const status: KernelStatus =
    availableRequired.length === 0
      ? "unavailable"
      : missingRequired.length === 0
        ? "ready"
        : "degraded";

  const remediationCode: KernelRemediationCode | null =
    status === "ready"
      ? null
      : invalidOverrides.length > 0
        ? "kernel-override-invalid"
        : status === "unavailable"
          ? "kernel-not-installed"
          : "kernel-incomplete";

  return {
    name: KERNEL_NAME,
    role: "conversion-kernel",
    status,
    version,
    verifiedVersion: VERIFIED_KERNEL_VERSION,
    meetsVerifiedVersion,
    executables,
    missing,
    remediation:
      remediationCode === null
        ? null
        : kernelRemediation(
            remediationCode,
            remediationCode === "kernel-override-invalid" ? invalidOverrides : missingRequired,
            platform,
          ),
  };
}
