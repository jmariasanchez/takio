import { describe, expect, it } from "bun:test";

import {
  DEFAULT_CONVERSION_SETTINGS_V1,
  PlanningError,
  planConversion,
} from "../src/index.js";

describe("planConversion", () => {
  it("plans without touching the filesystem when an online target declares the exact pair", () => {
    const job = planConversion({
      input: "library/this-path-does-not-exist.epub",
      outputFormat: "pdf",
      targets: [
        {
          id: "target-01",
          name: "Studio Mac",
          capabilities: [{ from: "epub", to: "pdf" }],
          status: "online",
        },
      ],
    });

    expect(job).toMatchObject({
      inputFormat: "epub",
      outputFormat: "pdf",
      assignedTarget: { id: "target-01", name: "Studio Mac" },
      status: "planned",
    });
    expect(job.id).toStartWith("job_");
    expect(job.settings).toEqual(DEFAULT_CONVERSION_SETTINGS_V1);
    expect(Object.isFrozen(job.settings)).toBe(true);
  });

  it("rejects settings the current executor cannot honor", () => {
    const unsupportedSettings = [
      { version: 2, profileId: "default" },
      { version: 1, profileId: "tablet" },
      { version: 1, profileId: "default", extra: true },
    ];

    for (const settings of unsupportedSettings) {
      const plan = () => planConversion({
        input: "library/novel.epub",
        outputFormat: "pdf",
        targets: [],
        settings,
      } as unknown as Parameters<typeof planConversion>[0]);

      expect(plan).toThrow(PlanningError);
      expect(plan).toThrow("Invalid conversion request.");
    }
  });

  it("preserves a supported output profile in the deterministic plan", () => {
    const job = planConversion({
      input: "library/novel.epub",
      outputFormat: "kepub",
      targets: [{
        id: "target-01",
        name: "Kobo Mac",
        capabilities: [{ from: "epub", to: "kepub" }],
        status: "online",
      }],
      settings: { version: 1, profileId: "kobo" },
    });

    expect(job.settings).toEqual({ version: 1, profileId: "kobo" });
  });

  it("does not treat support for one input as support for every input with the same output", () => {
    expect(() =>
      planConversion({
        input: "library/novel.mobi",
        outputFormat: "pdf",
        targets: [
          {
            id: "target-01",
            name: "Studio Mac",
            capabilities: [{ from: "epub", to: "pdf" }],
            status: "online",
          },
        ],
      }),
    ).toThrow("No online execution target can convert MOBI → PDF.");
  });

  it("does not fabricate a plan for an online target with no declared capabilities", () => {
    expect(() =>
      planConversion({
        input: "library/novel.epub",
        outputFormat: "pdf",
        targets: [
          {
            id: "target-01",
            name: "Studio Mac",
            capabilities: [],
            status: "online",
          },
        ],
      }),
    ).toThrow("No online execution target can convert EPUB → PDF.");
  });

  it("does not select an offline target even when it declares the exact pair", () => {
    expect(() =>
      planConversion({
        input: "library/novel.epub",
        outputFormat: "pdf",
        targets: [
          {
            id: "target-01",
            name: "Studio Mac",
            capabilities: [{ from: "epub", to: "pdf" }],
            status: "offline",
          },
        ],
      }),
    ).toThrow("No online execution target can convert EPUB → PDF.");
  });

  it("rejects an unknown input extension before target matching", () => {
    expect(() =>
      planConversion({ input: "library/novel.unknown", outputFormat: "epub", targets: [] }),
    ).toThrow(PlanningError);
  });

  it("rejects a no-op conversion before target matching", () => {
    expect(() =>
      planConversion({ input: "library/novel.epub", outputFormat: "epub", targets: [] }),
    ).toThrow("Input and output formats must be different.");
  });

  it("maps malformed runtime requests to the stable planning error boundary", () => {
    const plan = () => planConversion({ input: "", outputFormat: "pdf", targets: [] });

    expect(plan).toThrow(PlanningError);
    expect(plan).toThrow("Invalid conversion request.");
  });
});
