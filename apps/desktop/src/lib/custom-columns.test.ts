import { expect, test } from "bun:test";

import {
  decodeCustomColumnListResult,
  listCustomColumnDefinitions,
} from "./custom-columns";

const definitions = [
  { key: "shelf", label: "Shelf", type: "text", position: 0 },
  { key: "source_note", label: "Source note", type: "text", position: 1 },
] as const;

test("decodes only bounded ordered text-column definitions", () => {
  expect(decodeCustomColumnListResult({ ok: true, value: { definitions } })).toEqual({
    ok: true,
    value: { definitions },
  });
  expect(decodeCustomColumnListResult({
    ok: true,
    value: { definitions: [definitions[1], definitions[0]] },
  })).toEqual({ ok: false, error: { code: "protocol-error" } });
  expect(decodeCustomColumnListResult({
    ok: true,
    value: { definitions: [{ ...definitions[0], key: "takio_metadata_audit" }] },
  })).toEqual({ ok: false, error: { code: "protocol-error" } });
});

test("uses one fixed renderer command without arguments", async () => {
  const calls: string[] = [];
  const result = await listCustomColumnDefinitions(async <T,>(command: string): Promise<T> => {
    calls.push(command);
    return { ok: true, value: { definitions } } as T;
  });

  expect(calls).toEqual(["library_custom_columns_list"]);
  expect(result.ok && result.value.definitions).toEqual(definitions);
});
