import {
  classifyDestinationKind,
  type Destination,
} from "@takio/core";
import { readdir, realpath, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

export async function listDestinations(
  volumesRoot: string,
): Promise<readonly Destination[]> {
  const entries = await readdir(volumesRoot);
  const destinations: Destination[] = [];

  for (const name of entries) {
    const candidatePath = join(volumesRoot, name);

    try {
      const canonicalPath = await realpath(candidatePath);
      if (canonicalPath === "/" || !(await stat(canonicalPath)).isDirectory()) {
        continue;
      }

      const rootEntries = await readdir(canonicalPath);
      let freeBytes: number | undefined;
      try {
        const filesystem = await statfs(canonicalPath);
        freeBytes = filesystem.bavail * filesystem.bsize;
      } catch {
        // Capacity is optional when a mounted filesystem does not expose it.
      }

      destinations.push({
        id: name,
        name,
        path: canonicalPath,
        kind: classifyDestinationKind(rootEntries),
        ...(freeBytes === undefined ? {} : { freeBytes }),
      });
    } catch {
      // A stale, unreadable, or non-directory volume entry is not a destination.
    }
  }

  return destinations.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}
