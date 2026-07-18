import { describe, expect, it } from "bun:test";

import { PlanningError, localDevice, planConversion } from "../src/index.js";

describe("planConversion", () => {
  it("detects the input format and assigns an online compatible device", () => {
    const job = planConversion({
      input: "library/novel.epub",
      outputFormat: "pdf",
      devices: [
        { ...localDevice, id: "reader-01", name: "Studio Mac", supportedOutputs: ["pdf"] },
      ],
    });

    expect(job).toMatchObject({
      inputFormat: "epub",
      outputFormat: "pdf",
      assignedDevice: { id: "reader-01", name: "Studio Mac" },
      status: "planned",
    });
    expect(job.id).toStartWith("job_");
  });

  it("rejects an unknown input extension", () => {
    expect(() =>
      planConversion({ input: "library/novel.unknown", outputFormat: "epub", devices: [localDevice] }),
    ).toThrow(PlanningError);
  });

  it("rejects work when no online device supports the requested output", () => {
    expect(() =>
      planConversion({
        input: "library/novel.epub",
        outputFormat: "pdf",
        devices: [{ ...localDevice, status: "offline" }],
      }),
    ).toThrow("No online device can produce PDF");
  });
});
