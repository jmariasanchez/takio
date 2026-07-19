import { expect, test } from "bun:test";

import {
  ejectDestination,
  listDestinations,
  sendLibraryItem,
  type DestinationInvoker,
} from "./destinations";

test("uses only the fixed desktop destination commands and argument names", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: DestinationInvoker = async (command, args) => {
    calls.push({ command, args });
    return { ok: true, value: {} } as never;
  };

  await listDestinations(invokeCommand);
  await sendLibraryItem("item-1", "/Volumes/Reader", invokeCommand);
  await ejectDestination("/Volumes/Reader", invokeCommand);

  expect(calls).toEqual([
    { command: "destination_list", args: undefined },
    {
      command: "destination_send",
      args: { id: "item-1", destinationPath: "/Volumes/Reader" },
    },
    {
      command: "destination_eject",
      args: { destinationPath: "/Volumes/Reader" },
    },
  ]);
});
