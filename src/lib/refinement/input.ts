import { z } from "zod";

const revision=z.number().int().min(0);
const versionId=z.string().uuid();

export const refinementInitializeSchema=z.object({
  action:z.literal("initialize"),
  expectedWizardRevision:revision
}).strict();

export const refinementRetimeSchema=z.object({
  action:z.literal("retime"),
  expectedWizardRevision:revision,
  expectedTimelineVersionId:versionId,
  boundaryPosition:z.number().int().min(0),
  timelineMs:z.number().int().min(1)
}).strict();

export const refinementReplaceClipSchema=z.object({
  action:z.literal("replace-clip"),
  expectedWizardRevision:revision,
  expectedTimelineVersionId:versionId,
  position:z.number().int().min(0),
  assetVersionId:versionId
}).strict();

export const refinementTransitionSchema=z.object({
  action:z.literal("transition"),
  expectedWizardRevision:revision,
  expectedTimelineVersionId:versionId,
  fromPosition:z.number().int().min(0),
  kind:z.string().trim().min(1).max(80),
  durationMs:z.number().int().min(0).max(60000),
  note:z.string().trim().max(4000).default("")
}).strict();

export const refinementFramingSchema=z.object({
  action:z.literal("framing"),
  expectedWizardRevision:revision,
  expectedTimelineVersionId:versionId,
  position:z.number().int().min(0),
  framing:z.object({
    mode:z.enum(["fit","fill"]),
    zoom:z.number().min(1).max(4),
    focusX:z.number().min(0).max(1),
    focusY:z.number().min(0).max(1)
  }).strict().nullable()
}).strict();

const overlayCue=z.object({
  text:z.string().trim().min(1).max(200),
  startMs:z.number().int().min(0),
  endMs:z.number().int().min(1),
  placement:z.enum(["top","center","bottom"])
}).strict();

export const refinementOverlaysSchema=z.object({
  action:z.literal("overlays"),
  expectedWizardRevision:revision,
  expectedTimelineVersionId:versionId,
  kind:z.enum(["title","caption"]),
  overlays:z.array(overlayCue).max(600)
}).strict();

export const refinementCompleteSchema=z.object({
  action:z.literal("complete"),
  expectedWizardRevision:revision,
  expectedTimelineVersionId:versionId
}).strict();

export const refinementLockSchema=z.object({
  action:z.literal("lock"),
  expectedWizardRevision:revision,
  expectedTimelineVersionId:versionId
}).strict();

export const refinementActionSchema=z.discriminatedUnion("action",[
  refinementInitializeSchema,
  refinementRetimeSchema,
  refinementReplaceClipSchema,
  refinementTransitionSchema,
  refinementFramingSchema,
  refinementOverlaysSchema,
  refinementCompleteSchema,
  refinementLockSchema
]);
