import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  DomainVersionKind,
  GenerationKind,
  WorkspaceRole
} from "@prisma/client";
import { db } from "../src/lib/db";
import {
  generationHandlers,
  GenerationHandlerRegistry
} from "../src/lib/jobs/registry";
import { registerBuiltInGenerationHandlers } from "../src/lib/music-analysis/register";
import { registerConceptGenerationHandlers } from "../src/lib/concepts/register";
import { registerTreatmentGenerationHandlers } from "../src/lib/treatment/register";
import { registerCreativeLanguageGenerationHandlers } from "../src/lib/creative-language/register";
import { registerSongPicturePlanGenerationHandlers } from "../src/lib/song-picture-plan/register";
import { registerStoryboardGenerationHandlers } from "../src/lib/storyboard/register";
import { registerShotSpecificationsGenerationHandlers } from "../src/lib/shot-specifications/register";
import { registerInitialFrameGenerationHandlers } from "../src/lib/initial-frames/register";
import { registerVideoClipGenerationHandlers } from "../src/lib/video-clips/register";
import { registerFinalMasterRenderHandler } from "../src/lib/finish-export/register";
import { getConfiguredMediaGenerationAdapters } from "../src/lib/media-generation/factory";
import { getEnvironment } from "../src/lib/env";
import {
  ensureWizardProgress,
  getWizardView
} from "../src/lib/wizard/service";
import { WIZARD_STEPS } from "../src/lib/wizard/registry";

const expectedSteps=[
  "project-setup",
  "music-analysis",
  "music-map",
  "creative-brief",
  "concepts",
  "treatment",
  "creative-language",
  "song-map",
  "sequence-map",
  "storyboard",
  "shot-specifications",
  "initial-frames",
  "video-clips",
  "first-cut",
  "refinement",
  "finish-export"
] as const;

function assertWizardRegistry(){
  assert.deepEqual(
    WIZARD_STEPS.map(step=>step.key),
    expectedSteps,
    "Release wizard stages changed unexpectedly."
  );
  assert.equal(
    WIZARD_STEPS.filter(step=>step.editor===null).length,
    0,
    "Every release wizard stage must have an executable editor."
  );
  for(let index=1;index<WIZARD_STEPS.length;index+=1){
    assert.ok(
      WIZARD_STEPS[index]!.ordinal>WIZARD_STEPS[index-1]!.ordinal,
      "Wizard ordinals must remain strictly increasing."
    );
  }
}

function assertWorkerRegistry(){
  generationHandlers.clear();
  registerBuiltInGenerationHandlers();
  registerConceptGenerationHandlers();
  registerTreatmentGenerationHandlers();
  registerCreativeLanguageGenerationHandlers();
  registerSongPicturePlanGenerationHandlers();
  registerStoryboardGenerationHandlers();
  registerShotSpecificationsGenerationHandlers();
  registerInitialFrameGenerationHandlers();
  registerVideoClipGenerationHandlers();
  registerFinalMasterRenderHandler();

  const required:Array<[GenerationKind,string]>=[
    [GenerationKind.ANALYSIS,"local-librosa"],
    [GenerationKind.TEXT,"openai-responses"],
    [GenerationKind.TEXT,"openai-responses:treatment"],
    [GenerationKind.TEXT,"openai-responses:creative-language"],
    [GenerationKind.TEXT,"openai-responses:song-picture-plan"],
    [GenerationKind.TEXT,"openai-responses:storyboard"],
    [GenerationKind.TEXT,"openai-responses:storyboard-shot"],
    [GenerationKind.TEXT,"openai-responses:shot-specifications"],
    [GenerationKind.IMAGE,"openai-images:initial-frame"],
    [GenerationKind.VIDEO,"runway:video-clip"],
    [GenerationKind.VIDEO,"comfyui:video-clip"],
    [GenerationKind.RENDER,"ffmpeg:finish-export"]
  ];

  for(const [kind,key] of required){
    assert.ok(
      generationHandlers.get(kind,key),
      "Missing release generation handler: "+kind+":"+key
    );
  }

  const isolated=new GenerationHandlerRegistry();
  const noop=async()=>undefined;
  isolated.register(GenerationKind.TEXT,"acceptance",noop);
  assert.equal(isolated.get(GenerationKind.TEXT,"acceptance"),noop);
  assert.throws(
    ()=>isolated.register(GenerationKind.TEXT,"acceptance",noop),
    /already registered/
  );
}

async function assertProviderConfiguration(){
  const env=getEnvironment({
    ...process.env,
    AUDIO_TRANSCRIPTION_PROVIDER:"none",
    TEXT_GENERATION_PROVIDER:"none",
    IMAGE_GENERATION_PROVIDER:"none",
    VIDEO_GENERATION_PROVIDER:"none",
    OPENAI_API_KEY:"",
    RUNWAY_API_SECRET:""
  });
  const adapters=getConfiguredMediaGenerationAdapters(env);
  assert.deepEqual(adapters,[]);
}

async function assertMigratedWizardInitialization(){
  const userId=randomUUID();
  const workspaceId=randomUUID();
  const projectId=randomUUID();
  const projectVersionId=randomUUID();
  const projectNodeId=randomUUID();

  try{
    await db.user.create({
      data:{
        id:userId,
        email:"release-acceptance-"+userId+"@example.test",
        displayName:"Release Acceptance"
      }
    });
    await db.workspace.create({
      data:{
        id:workspaceId,
        name:"Release Acceptance Workspace",
        memberships:{
          create:{userId,role:WorkspaceRole.OWNER}
        }
      }
    });
    await db.project.create({
      data:{
        id:projectId,
        workspaceId,
        title:"Release Acceptance Project"
      }
    });
    await db.domainVersionNode.create({
      data:{id:projectNodeId,kind:DomainVersionKind.PROJECT}
    });
    await db.projectVersion.create({
      data:{
        id:projectVersionId,
        projectId,
        nodeId:projectNodeId,
        versionNumber:1,
        title:"Release Acceptance Project",
        aspectRatio:"16:9",
        outputWidth:1920,
        outputHeight:1080,
        frameRate:24
      }
    });

    const initialized=await ensureWizardProgress({userId,projectId});
    assert.ok(initialized.wizardProgress);
    assert.equal(
      initialized.wizardProgress.steps.length,
      expectedSteps.length,
      "Migrated database did not initialize every release wizard stage."
    );
    assert.deepEqual(
      initialized.wizardProgress.steps
        .sort((a,b)=>a.ordinal-b.ordinal)
        .map(step=>step.stepKey),
      expectedSteps
    );

    const firstView=await getWizardView({
      userId,
      projectId,
      selectedStepKey:"project-setup"
    });
    assert.equal(firstView.selected.definition.editor,"project-setup");

    const finalView=await getWizardView({
      userId,
      projectId,
      selectedStepKey:"finish-export"
    });
    assert.equal(finalView.selected.definition.editor,"finish-export");
    assert.equal(finalView.selected.definition.key,"finish-export");
  }finally{
    await db.projectVersion.deleteMany({where:{projectId}});
    await db.project.deleteMany({where:{id:projectId}});
    await db.domainVersionNode.deleteMany({where:{id:projectNodeId}});
    await db.workspace.deleteMany({where:{id:workspaceId}});
    await db.user.deleteMany({where:{id:userId}});
  }
}

async function main(){
  try{
    assertWizardRegistry();
    assertWorkerRegistry();
    await assertProviderConfiguration();
    await assertMigratedWizardInitialization();
    console.log("Release acceptance smoke test passed.");
  }finally{
    await db.$disconnect();
  }
}

main().catch(error=>{
  console.error(error);
  process.exit(1);
});
