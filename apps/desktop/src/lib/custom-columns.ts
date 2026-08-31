import { invoke } from "./desktop";

export type CustomColumnDefinition = Readonly<{
  key: string;
  label: string;
  type: "text";
  position: number;
}>;

type CustomColumnListResult =
  | {
      readonly ok: true;
      readonly value: { readonly definitions: readonly CustomColumnDefinition[] };
    }
  | { readonly ok: false; readonly error: { readonly code: string } };

export type CustomColumnInvoker = <T>(command: string) => Promise<T>;

const keyPattern = /^[a-z][a-z0-9_]{0,63}$/;
const invokeDesktop: CustomColumnInvoker = (command) => invoke(command);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCustomColumnDefinition(value: unknown): value is CustomColumnDefinition {
  return (
    isRecord(value) &&
    typeof value.key === "string" &&
    keyPattern.test(value.key) &&
    value.key !== "takio_metadata_audit" &&
    typeof value.label === "string" &&
    value.label.trim() === value.label &&
    value.label.length > 0 &&
    value.label.length <= 120 &&
    value.type === "text" &&
    Number.isSafeInteger(value.position) &&
    (value.position as number) >= 0
  );
}

export function decodeCustomColumnListResult(result: unknown): CustomColumnListResult {
  if (
    isRecord(result) &&
    result.ok === false &&
    isRecord(result.error) &&
    typeof result.error.code === "string" &&
    result.error.code.length > 0
  ) {
    return result as CustomColumnListResult;
  }

  if (!isRecord(result) || result.ok !== true || !isRecord(result.value)) {
    return { ok: false, error: { code: "protocol-error" } };
  }
  const definitions = result.value.definitions;
  if (
    !Array.isArray(definitions) ||
    definitions.length > 64 ||
    !definitions.every(isCustomColumnDefinition) ||
    definitions.some((definition, index) => definition.position !== index) ||
    new Set(definitions.map(({ key }) => key)).size !== definitions.length
  ) {
    return { ok: false, error: { code: "protocol-error" } };
  }

  return { ok: true, value: { definitions } };
}

export async function listCustomColumnDefinitions(
  invokeCommand: CustomColumnInvoker = invokeDesktop,
): Promise<CustomColumnListResult> {
  return decodeCustomColumnListResult(
    await invokeCommand<unknown>("library_custom_columns_list"),
  );
}

export function definitionByKey(
  definitions: readonly CustomColumnDefinition[],
): ReadonlyMap<string, CustomColumnDefinition> {
  return new Map(definitions.map((definition) => [definition.key, definition]));
}
