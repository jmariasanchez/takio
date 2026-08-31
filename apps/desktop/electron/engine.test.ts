import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { LibraryServiceClient, buildEngineArguments, parseEngineRecord } from "./engine";

function serviceDouble() {
  const children: Array<EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: () => boolean; writes: string[]; killed: boolean }> = [];
  const spawn = (args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: () => boolean; writes: string[]; killed: boolean };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.writes = [];
    child.killed = false;
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        child.writes.push(Buffer.from(chunk).toString("utf8"));
        callback();
      },
    });
    child.kill = () => { child.killed = true; return true; };
    expect(args).toEqual(["library", "service"]);
    children.push(child);
    return child;
  };
  return { children, spawn };
}

function requestId(line: string): string {
  return JSON.parse(line).id;
}

describe("Electron engine boundary", () => {
  test("maps only fixed command names and preserves JSON as one literal argument", async () => {
    const request = { query: "Le Guin; rm -rf /", page: { offset: 0, limit: 25 } };

    expect(await buildEngineArguments("library_query", { request })).toEqual([
      "library",
      "query",
      "--request-json",
      JSON.stringify(request),
    ]);
    expect(await buildEngineArguments("destination_send", {
      id: "item-1",
      format: "epub",
      destinationPath: "/Volumes/Kindle",
      convertIfNeeded: true,
    })).toEqual([
      "send",
      "--id",
      "item-1",
      "--format",
      "epub",
      "--dest",
      "/Volumes/Kindle",
      "--convert",
    ]);
    expect(await buildEngineArguments("destination_send", {
      id: "item-1",
      format: "epub",
      destinationPath: "/Volumes/Kindle",
      convertIfNeeded: false,
    })).toEqual([
      "send",
      "--id",
      "item-1",
      "--format",
      "epub",
      "--dest",
      "/Volumes/Kindle",
    ]);
    expect(await buildEngineArguments("destination_rooted_kindle_send", {
      id: "item-1",
      format: "epub",
      host: "kindle.local;rm -rf /",
      user: "root",
      remoteRoot: "/mnt/us/documents/koreader",
      identityFile: "/Users/me/.ssh/kindle",
      port: 22,
      timeoutMs: 30000,
    })).toEqual([
      "destination",
      "rooted-kindle-send",
      "--id",
      "item-1",
      "--format",
      "epub",
      "--host",
      "kindle.local;rm -rf /",
      "--user",
      "root",
      "--remote-root",
      "/mnt/us/documents/koreader",
      "--identity-file",
      "/Users/me/.ssh/kindle",
      "--port",
      "22",
      "--timeout-ms",
      "30000",
    ]);
    expect(await buildEngineArguments("destination_rooted_kindle_send", {
      id: "item-1",
      format: "epub",
      host: "kindle.local",
      user: "root",
      remoteRoot: "/mnt/us/documents/koreader",
      identityFile: "/Users/me/.ssh/kindle",
      port: "22",
      timeoutMs: 30000,
    })).toBeNull();
    expect(await buildEngineArguments("destination_rooted_kindle_send", {
      id: "item-1",
      format: "epub",
      host: "kindle.local",
      user: "root",
      remoteRoot: "/mnt/us/documents/koreader",
      identityFile: "/Users/me/.ssh/kindle",
      port: 22,
      timeoutMs: 30000,
      acceptNewHostKey: true,
    })).not.toContain("--accept-new-host-key");
    expect(await buildEngineArguments("destination_send", {
      id: "item-1",
      format: "epub",
      destinationPath: "/Volumes/Kindle",
      convertIfNeeded: "true",
    })).toBeNull();
    expect(await buildEngineArguments("shell_exec", { command: "rm" })).toBeNull();
  });

  test("rejects blank identifiers, empty request objects, and malformed job sources", async () => {
    expect(await buildEngineArguments("library_get", { id: " " })).toBeNull();
    expect(await buildEngineArguments("library_query", { request: {} })).toBeNull();
    expect(
      await buildEngineArguments("jobs_enqueue", {
        input: "/book.epub",
        libraryItemId: "item-1",
        from: "epub",
        to: "pdf",
        output: "/book.pdf",
      }),
    ).toEqual([
      "jobs",
      "enqueue",
      "--input",
      "/book.epub",
      "--to",
      "pdf",
      "--output",
      "/book.pdf",
    ]);
  });

  test("maps explicit copy and move import modes without widening the command surface", async () => {
    expect(
      await buildEngineArguments("library_import_many", {
        sourcePaths: ["/Books/A.epub", "/Books/B.pdf"],
        mode: "move",
      }),
    ).toEqual([
      "library",
      "import-many",
      "--source-path",
      "/Books/A.epub",
      "--source-path",
      "/Books/B.pdf",
      "--mode",
      "move",
    ]);
    expect(
      await buildEngineArguments("library_import_many", {
        sourcePaths: ["/Books/A.epub"],
        mode: "link",
      }),
    ).toBeNull();
  });

  test("maps library health commands to fixed sidecar arguments", async () => {
    expect(await buildEngineArguments("library_health_location", undefined)).toEqual([
      "library",
      "path",
    ]);
    expect(await buildEngineArguments("library_health_verify", undefined)).toEqual([
      "library",
      "verify",
    ]);
    expect(await buildEngineArguments("library_health_backup", { destinationPath: "/Backups/takio" })).toEqual([
      "library",
      "backup",
      "--dest",
      "/Backups/takio",
    ]);
    expect(await buildEngineArguments("library_health_backup", { destinationPath: " " })).toBeNull();
    expect(await buildEngineArguments("library_health_diagnostics", { destinationPath: "/Support/takio.json" })).toEqual([
      "library",
      "diagnostics",
      "--dest",
      "/Support/takio.json",
    ]);
    expect(await buildEngineArguments("library_health_diagnostics", { destinationPath: " " })).toBeNull();
  });

  test("maps destination inventory, reconcile, and safe removal to fixed sidecar arguments", async () => {
    expect(await buildEngineArguments("destination_inventory", { destinationPath: "/Volumes/Reader" })).toEqual([
      "destination",
      "inventory",
      "--dest",
      "/Volumes/Reader",
    ]);
    expect(await buildEngineArguments("destination_reconcile", { destinationPath: "/Volumes/Reader" })).toEqual([
      "destination",
      "reconcile",
      "--dest",
      "/Volumes/Reader",
    ]);
    expect(await buildEngineArguments("destination_inventory", { destinationPath: " " })).toBeNull();
    expect(await buildEngineArguments("destination_remove", {
      destinationPath: "/Volumes/Reader",
      itemId: "item-1",
    })).toEqual([
      "destination",
      "remove",
      "--dest",
      "/Volumes/Reader",
      "--id",
      "item-1",
    ]);
    expect(await buildEngineArguments("destination_remove", { destinationPath: "/Volumes/Reader", id: "item-1" })).toBeNull();
  });

  test("accepts only protocol records consistent with the process exit code", () => {
    expect(
      parseEngineRecord(
        0,
        Buffer.from(JSON.stringify({ ok: true, value: { items: [] } })),
        Buffer.alloc(0),
      ),
    ).toEqual({ ok: true, value: { items: [] } });
    expect(
      parseEngineRecord(
        1,
        Buffer.from(JSON.stringify({ ok: false, error: { code: "unknown-item" } })),
        Buffer.alloc(0),
      ),
    ).toEqual({ ok: false, error: { code: "unknown-item" } });
    expect(
      parseEngineRecord(
        0,
        Buffer.from(JSON.stringify({ ok: false, error: { code: "unknown-item" } })),
        Buffer.alloc(0),
      ),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
    expect(
      parseEngineRecord(0, Buffer.from("not-json"), Buffer.alloc(0)),
    ).toEqual({ ok: false, error: { code: "protocol-error" } });
  });

  test("uses one live library service child and correlates sequential responses", async () => {
    const service = serviceDouble();
    const client = new LibraryServiceClient(service.spawn);

    const first = client.invoke("library_update", { id: "item-1", patch: { title: "One" } });
    const second = client.invoke("library_update", { id: "item-1", patch: { title: "Two" } });

    expect(service.children).toHaveLength(1);
    expect(service.children[0]!.writes.map((line) => JSON.parse(line).args.patch.title)).toEqual(["One", "Two"]);
    service.children[0]!.stdout.write(JSON.stringify({ id: requestId(service.children[0]!.writes[0]!), ok: true, value: { item: { title: "One" } } }) + "\n");
    service.children[0]!.stdout.write(JSON.stringify({ id: requestId(service.children[0]!.writes[1]!), ok: true, value: { item: { title: "Two" } } }) + "\n");

    await expect(first).resolves.toEqual({ ok: true, value: { item: { title: "One" } } });
    await expect(second).resolves.toEqual({ ok: true, value: { item: { title: "Two" } } });
  });

  test("uses the same live service for trash, restore, and purge mutations", async () => {
    const service = serviceDouble();
    const client = new LibraryServiceClient(service.spawn);
    const trashed = client.invoke("library_trash", { request: { id: "item-1" } });
    const restored = client.invoke("library_restore", { request: { id: "item-1" } });
    const purged = client.invoke("library_purge", { request: { id: "item-1" } });

    expect(service.children).toHaveLength(1);
    expect(service.children[0]!.writes.map((line) => {
      const request = JSON.parse(line);
      return [request.command, request.args];
    })).toEqual([
      ["library_trash", { id: "item-1" }],
      ["library_restore", { id: "item-1" }],
      ["library_purge", { id: "item-1" }],
    ]);

    const [trashLine, restoreLine, purgeLine] = service.children[0]!.writes;
    service.children[0]!.stdout.write(JSON.stringify({
      id: requestId(trashLine!),
      ok: true,
      value: { item: { id: "item-1", trashedAt: "2026-08-19T23:00:00.000Z" } },
    }) + "\n");
    service.children[0]!.stdout.write(JSON.stringify({
      id: requestId(restoreLine!),
      ok: true,
      value: { item: { id: "item-1" } },
    }) + "\n");
    service.children[0]!.stdout.write(JSON.stringify({
      id: requestId(purgeLine!),
      ok: true,
      value: { item: { id: "item-1" }, cleanupPending: false },
    }) + "\n");

    await expect(trashed).resolves.toMatchObject({ ok: true, value: { item: { id: "item-1" } } });
    await expect(restored).resolves.toMatchObject({ ok: true, value: { item: { id: "item-1" } } });
    await expect(purged).resolves.toEqual({
      ok: true,
      value: { item: { id: "item-1" }, cleanupPending: false },
    });
  });

  test("uses the same live service for format and cover mutations", async () => {
    const service = serviceDouble();
    const client = new LibraryServiceClient(service.spawn);
    const copied = client.invoke("library_attach_format", { id: "item-1", mode: "copy", sourcePath: "/books/a.pdf" });
    const referenced = client.invoke("library_attach_format", { id: "item-1", mode: "reference", sourcePath: "/books/a.mobi" });
    const removed = client.invoke("library_remove_format", { id: "item-1", format: "mobi" });
    const coverSet = client.invoke("library_cover_set", { id: "item-1", sourcePath: "/covers/a.jpg" });
    const coverRemoved = client.invoke("library_cover_remove", { id: "item-1" });

    expect(service.children).toHaveLength(1);
    expect(service.children[0]!.writes.map((line) => {
      const request = JSON.parse(line);
      return [request.command, request.args];
    })).toEqual([
      ["library_attach_format", { id: "item-1", source: { kind: "copy", path: "/books/a.pdf" } }],
      ["library_attach_format", { id: "item-1", source: { kind: "reference", path: "/books/a.mobi" } }],
      ["library_remove_format", { id: "item-1", format: "mobi" }],
      ["library_cover_set", { id: "item-1", sourcePath: "/covers/a.jpg" }],
      ["library_cover_remove", { id: "item-1" }],
    ]);

    for (const line of service.children[0]!.writes) {
      service.children[0]!.stdout.write(JSON.stringify({ id: requestId(line), ok: true, value: { item: { id: "item-1" } } }) + "\n");
    }
    await expect(copied).resolves.toMatchObject({ ok: true });
    await expect(referenced).resolves.toMatchObject({ ok: true });
    await expect(removed).resolves.toMatchObject({ ok: true });
    await expect(coverSet).resolves.toMatchObject({ ok: true });
    await expect(coverRemoved).resolves.toMatchObject({ ok: true });
  });

  test("rejects response mismatches and lazily restarts after a crash", async () => {
    const service = serviceDouble();
    const client = new LibraryServiceClient(service.spawn);

    const mismatched = client.invoke("library_update", { id: "item-1", patch: { title: "One" } });
    service.children[0]!.stdout.write(JSON.stringify({ id: "other", ok: true, value: null }) + "\n");
    await expect(mismatched).resolves.toEqual({ ok: false, error: { code: "protocol-error" } });

    const crashed = client.invoke("library_update", { id: "item-1", patch: { title: "Two" } });
    service.children[1]!.emit("close", 1);
    await expect(crashed).resolves.toEqual({ ok: false, error: { code: "engine-unavailable" } });

    const restarted = client.invoke("library_update", { id: "item-1", patch: { title: "Three" } });
    expect(service.children).toHaveLength(3);
    service.children[2]!.stdout.write(JSON.stringify({ id: requestId(service.children[2]!.writes[0]!), ok: true, value: { item: { title: "Three" } } }) + "\n");
    await expect(restarted).resolves.toEqual({ ok: true, value: { item: { title: "Three" } } });
  });

  test("rejects malformed response shapes and spawn failures", async () => {
    const service = serviceDouble();
    const client = new LibraryServiceClient(service.spawn);
    const malformed = client.invoke("library_update", { id: "item-1", patch: { title: "One" } });
    service.children[0]!.stdout.write(JSON.stringify({ id: requestId(service.children[0]!.writes[0]!), ok: true, value: null, extra: true }) + "\n");
    await expect(malformed).resolves.toEqual({ ok: false, error: { code: "protocol-error" } });

    const truthy = client.invoke("library_update", { id: "item-1", patch: { title: "Two" } });
    service.children[1]!.stdout.write(JSON.stringify({ id: requestId(service.children[1]!.writes[0]!), ok: 1, value: null }) + "\n");
    await expect(truthy).resolves.toEqual({ ok: false, error: { code: "protocol-error" } });

    const falsy = client.invoke("library_update", { id: "item-1", patch: { title: "Three" } });
    service.children[2]!.stdout.write(JSON.stringify({ id: requestId(service.children[2]!.writes[0]!), ok: 0, error: { code: "bad" } }) + "\n");
    await expect(falsy).resolves.toEqual({ ok: false, error: { code: "protocol-error" } });

    const broken = new LibraryServiceClient(() => { throw new Error("missing binary /private/path"); });
    await expect(broken.invoke("library_update", { id: "item-1", patch: { title: "One" } })).resolves.toEqual({ ok: false, error: { code: "engine-unavailable" } });
  });

  test("close kills the service child and fails pending requests", async () => {
    const service = serviceDouble();
    const client = new LibraryServiceClient(service.spawn);
    const pending = client.invoke("library_update", { id: "item-1", patch: { title: "One" } });

    client.close();

    expect(service.children[0]!.killed).toBe(true);
    await expect(pending).resolves.toEqual({ ok: false, error: { code: "engine-unavailable" } });
  });
});
