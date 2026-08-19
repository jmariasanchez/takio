import { invoke } from "./desktop";

export type StartupInvoker = <T>(command: string) => Promise<T>;

export async function reportLibraryUsable(
  invokeCommand: StartupInvoker = invoke,
): Promise<void> {
  await invokeCommand<void>("app_report_library_usable");
}
