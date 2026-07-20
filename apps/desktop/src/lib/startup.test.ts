import { expect, test } from "bun:test";

import { reportLibraryUsable } from "./startup";

test("reports usable only through the dedicated native startup command", async () => {
  const commands: string[] = [];

  await reportLibraryUsable(async (command) => {
    commands.push(command);
    return undefined as never;
  });

  expect(commands).toEqual(["app_report_library_usable"]);
});
