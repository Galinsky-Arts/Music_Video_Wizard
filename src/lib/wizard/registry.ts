export interface WizardStepDefinition {
  key: string;
  ordinal: number;
  phase: string;
  title: string;
  description: string;
  editor: "project-setup" | "music-analysis" | "music-map" | "creative-brief" | "concepts" | "treatment" | "creative-language" | "song-picture-plan" | "sequence-map" | "storyboard" | "shot-specifications" | "initial-frames" | "animatic" | "video-clips" | "first-cut" | "refinement" | "finish-export" | null;
}

export const WIZARD_STEPS: readonly WizardStepDefinition[] = [
  {
    key: "project-setup",
    ordinal: 0,
    phase: "Foundation",
    title: "Project setup",
    description:
      "Confirm the finished master, project identity, aspect ratio, and delivery frame rate.",
    editor: "project-setup"
  },
  {
    key: "music-analysis",
    ordinal: 10,
    phase: "Understand the music",
    title: "Music analysis",
    description:
      "Derive objective timing, beat, section, energy, and structural information from the finished song.",
    editor: "music-analysis"
  },
  {
    key: "music-map",
    ordinal: 20,
    phase: "Understand the music",
    title: "Music map",
    description:
      "Turn analysis into a navigable musical map for creative and editorial decisions.",
    editor: "music-map"
  },
  {
    key: "creative-brief",
    ordinal: 30,
    phase: "Creative direction",
    title: "Creative brief",
    description:
      "Define objectives, audience, emotional targets, form, tone, imagery, arc, references, and constraints.",
    editor: "creative-brief"
  },
  {
    key: "concepts",
    ordinal: 40,
    phase: "Creative direction",
    title: "Concepts",
    description:
      "Generate, compare, revise, combine, and select complete music-video concepts against the locked Creative Brief.",
    editor: "concepts"
  },
  {
    key: "treatment",
    ordinal: 50,
    phase: "Creative direction",
    title: "Treatment",
    description:
      "Turn the selected concept into a complete, editable visual and dramatic treatment mapped across the finished song.",
    editor: "treatment"
  },
  {
    key: "creative-language",
    ordinal: 60,
    phase: "Creative direction",
    title: "Creative language",
    description:
      "Set reusable aesthetics, characters, locations, lighting, camera, motion, performance, editing, continuity, and exclusions.",
    editor: "creative-language"
  },
  {
    key: "song-map",
    ordinal: 70,
    phase: "Plan the video",
    title: "Song-to-picture plan",
    description:
      "Map the locked Treatment and Creative Language continuously across the approved Music Map before individual shots are designed.",
    editor: "song-picture-plan"
  },
  {
    key: "sequence-map",
    ordinal: 75,
    phase: "Plan the video",
    title: "Sequence map",
    description:
      "Materialize the locked Song-to-Picture Plan into exact, versioned sequences with continuous music timing and source provenance.",
    editor: "sequence-map"
  },
  {
    key: "storyboard",
    ordinal: 80,
    phase: "Plan the video",
    title: "Storyboard",
    description:
      "Design the complete visual sequence against the music with explicit timing and transition intent.",
    editor: "storyboard"
  },
  {
    key: "shot-specifications",
    ordinal: 90,
    phase: "Plan the video",
    title: "Shot specifications",
    description:
      "Specify every shot precisely enough to drive reproducible image and video generation.",
    editor: "shot-specifications"
  },
  {
    key: "initial-frames",
    ordinal: 100,
    phase: "Generate",
    title: "Initial frames",
    description:
      "Create and approve the starting image for each planned generated shot.",
    editor: "initial-frames"
  },
  {
    key: "animatic",
    ordinal: 105,
    phase: "Generate",
    title: "Animatic",
    description:
      "Play approved stills against the finished song with the First Cut's exact timing and transitions before spending on video generation.",
    editor: "animatic"
  },
  {
    key: "video-clips",
    ordinal: 110,
    phase: "Generate",
    title: "Video clips",
    description:
      "Generate the required moving-image clips from approved frames and shot specifications.",
    editor: "video-clips"
  },
  {
    key: "first-cut",
    ordinal: 120,
    phase: "Assemble",
    title: "Automatic first cut",
    description:
      "Compile the complete first edit automatically from the approved plan, timing, clips, transitions, and music.",
    editor: "first-cut"
  },
  {
    key: "refinement",
    ordinal: 130,
    phase: "Refine",
    title: "Refinement",
    description:
      "Retiming, replacement, regeneration, transition changes, and manual editorial refinement after the complete first cut exists.",
    editor: "refinement"
  },
  {
    key: "finish-export",
    ordinal: 140,
    phase: "Deliver",
    title: "Finish & export",
    description:
      "Finalize the master, verify delivery settings, render, export, and preserve the reproducible project archive.",
    editor: "finish-export"
  }
] as const;

const STEP_BY_KEY = new Map(WIZARD_STEPS.map((step) => [step.key, step]));

export function getWizardStepDefinition(
  stepKey: string
): WizardStepDefinition | null {
  return STEP_BY_KEY.get(stepKey) ?? null;
}

export function requireWizardStepDefinition(
  stepKey: string
): WizardStepDefinition {
  const step = getWizardStepDefinition(stepKey);
  if (!step) {
    throw new Error("Unknown wizard step: " + stepKey);
  }
  return step;
}

export function downstreamWizardSteps(
  stepKey: string
): readonly WizardStepDefinition[] {
  const step = requireWizardStepDefinition(stepKey);
  return WIZARD_STEPS.filter((candidate) => candidate.ordinal > step.ordinal);
}
