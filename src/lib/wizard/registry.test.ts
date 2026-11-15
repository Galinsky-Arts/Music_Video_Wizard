import { describe, expect, it } from "vitest";
import {
  downstreamWizardSteps,
  getWizardStepDefinition,
  WIZARD_STEPS
} from "./registry";

describe("wizard registry", () => {
  it("uses stable unique keys and ordinals", () => {
    expect(new Set(WIZARD_STEPS.map((step) => step.key)).size).toBe(
      WIZARD_STEPS.length
    );
    expect(new Set(WIZARD_STEPS.map((step) => step.ordinal)).size).toBe(
      WIZARD_STEPS.length
    );
    expect(
      WIZARD_STEPS.map((step) => step.ordinal)
    ).toEqual(
      [...WIZARD_STEPS].map((step) => step.ordinal).sort((a, b) => a - b)
    );
  });

  it("puts the complete automatic first cut after generated clips", () => {
    const clips = getWizardStepDefinition("video-clips");
    const firstCut = getWizardStepDefinition("first-cut");
    expect(clips).not.toBeNull();
    expect(firstCut).not.toBeNull();
    expect(firstCut!.ordinal).toBeGreaterThan(clips!.ordinal);
  });

  it("places the animatic between approved stills and video generation", () => {
    const frames = getWizardStepDefinition("initial-frames")!;
    const animatic = getWizardStepDefinition("animatic")!;
    const clips = getWizardStepDefinition("video-clips")!;
    expect(animatic.editor).toBe("animatic");
    expect(animatic.ordinal).toBeGreaterThan(frames.ordinal);
    expect(animatic.ordinal).toBeLessThan(clips.ordinal);
  });

  it("finds downstream stages for impact warnings", () => {
    const downstream = downstreamWizardSteps("creative-brief");
    expect(downstream[0]?.key).toBe("concepts");
    expect(downstream.at(-1)?.key).toBe("finish-export");
  });
});
