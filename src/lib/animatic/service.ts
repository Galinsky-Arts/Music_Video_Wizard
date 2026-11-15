import { Prisma, VersionLifecycle, WizardStepStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import {
  currentFrameVersions,
  initialFrameAssetsForProject,
  lockedShotSpecificationSources
} from "@/lib/initial-frames/source";
import { createAssetStorage } from "@/lib/storage";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  WizardLockedError
} from "@/lib/wizard/service";
import { compileAnimaticPlan, type AnimaticPlan, type AnimaticSource } from "./compiler";

export class AnimaticError extends Error{}
export class AnimaticConflictError extends AnimaticError{}

type Tx=Prisma.TransactionClient;

async function animaticSources(tx:Tx,projectId:string,projectVersionId:string){
  const sources=await lockedShotSpecificationSources(tx,projectVersionId);
  const assets=await initialFrameAssetsForProject(tx,projectId);
  const current=currentFrameVersions(sources,assets);
  const compilerSources:AnimaticSource[]=[];
  const storageKeys=new Map<string,string>();
  for(const item of current){
    const specificationVersion=item.source.specificationVersion;
    const specification=item.source.specification;
    if(!specificationVersion||!specification||specificationVersion.lifecycle!==VersionLifecycle.LOCKED){
      throw new AnimaticError("Lock every Shot Specification before building the animatic.");
    }
    const start=item.source.storyboardVersion.plannedStartMs;
    const end=item.source.storyboardVersion.plannedEndMs;
    if(start===null||end===null){
      throw new AnimaticError("Every animatic shot requires exact locked Storyboard timing.");
    }
    if(item.version) storageKeys.set(item.version.id,item.version.storageKey);
    compilerSources.push({
      sequencePosition:item.source.sequencePosition,
      shotPosition:item.source.shotPosition,
      label:item.source.storyboardVersion.label,
      shotSpecificationVersionId:specificationVersion.id,
      shotSpecificationNodeId:specificationVersion.nodeId,
      imageAssetVersionId:item.version?.id??null,
      timelineStartMs:start,
      timelineEndMs:end,
      transitionIn:specification.transitionIn,
      transitionOut:specification.transitionOut
    });
  }
  return {compilerSources,storageKeys};
}

function semanticPayload(plan:AnimaticPlan,audioMasterAssetVersionId:string|null):Prisma.InputJsonValue{
  return toJson({
    audioMasterAssetVersionId,
    durationMs:plan.durationMs,
    items:plan.items.map(item=>({
      shotSpecificationVersionId:item.shotSpecificationVersionId,
      imageAssetVersionId:item.imageAssetVersionId,
      timelineStartMs:item.timelineStartMs,
      timelineEndMs:item.timelineEndMs
    })),
    transitions:plan.transitions
  });
}

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

/** Read-only: compiles the animatic on demand; nothing is rendered server-side. */
export async function getAnimaticState(input:{userId:string;projectId:string}){
  const projectVersion=await ensureWizardProgress(input);
  const snapshot=await db.$transaction(async tx=>{
    const progress=await tx.wizardProgress.findUniqueOrThrow({
      where:{projectVersionId:projectVersion.id},
      include:{steps:true}
    });
    const sourceStep=progress.steps.find(step=>step.stepKey==="shot-specifications");
    const step=progress.steps.find(step=>step.stepKey==="animatic");
    let plan:AnimaticPlan|null=null;
    let sourceError:string|null=null;
    let storageKeys=new Map<string,string>();
    if(!sourceStep?.lockedAt){
      sourceError="Lock Shot Specifications to build the animatic.";
    }else{
      try{
        const sources=await animaticSources(tx,input.projectId,projectVersion.id);
        storageKeys=sources.storageKeys;
        plan=compileAnimaticPlan(sources.compilerSources);
      }catch(error){
        sourceError=error instanceof Error?error.message:"The animatic could not be compiled.";
      }
    }
    const fingerprint=plan
      ?fingerprintJson(semanticPayload(plan,projectVersion.audioMasterAssetVersionId) as Prisma.JsonValue)
      :null;
    return {
      plan,
      sourceError,
      storageKeys,
      wizardRevision:progress.revision,
      wizardStatus:step?.status??WizardStepStatus.NOT_STARTED,
      wizardLocked:Boolean(step?.lockedAt),
      reviewedCurrent:Boolean(fingerprint&&step?.payloadFingerprint===fingerprint&&step.status===WizardStepStatus.COMPLETED)
    };
  });

  const storage=createAssetStorage();
  const stillUrls:Record<string,string>={};
  await Promise.all([...snapshot.storageKeys].map(async([versionId,key])=>{
    stillUrls[versionId]=await storage.getSignedReadUrl(key,60*30);
  }));
  return {
    sourceReady:Boolean(snapshot.plan),
    sourceError:snapshot.sourceError,
    plan:snapshot.plan,
    stillUrls,
    wizardRevision:snapshot.wizardRevision,
    wizardStatus:snapshot.wizardStatus,
    wizardLocked:snapshot.wizardLocked,
    reviewedCurrent:snapshot.reviewedCurrent
  };
}

/** Records that the owner reviewed the current animatic (timing + stills). */
export async function completeAnimaticReview(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const progress=await tx.wizardProgress.findFirst({
      where:{
        projectVersionId:projectVersion.id,
        projectVersion:{
          projectId:input.projectId,
          project:{workspace:{memberships:{some:{userId:input.userId}}}}
        }
      },
      include:{projectVersion:true,steps:true}
    });
    if(!progress) throw new AnimaticError("Animatic wizard state not found.");
    if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
      throw new WizardLockedError("This project version is locked.");
    }
    if(progress.revision!==input.expectedWizardRevision){
      throw new AnimaticConflictError("The animatic changed in another request. Reload before continuing.");
    }
    if(!progress.steps.find(step=>step.stepKey==="shot-specifications")?.lockedAt){
      throw new AnimaticError("Lock Shot Specifications to build the animatic.");
    }
    const sources=await animaticSources(tx,input.projectId,projectVersion.id);
    const plan=compileAnimaticPlan(sources.compilerSources);
    if(plan.missingStillCount>0){
      throw new AnimaticError(
        "Approve or import an Initial Frame for every shot before completing the animatic review."
      );
    }
    const payload=semanticPayload(plan,progress.projectVersion.audioMasterAssetVersionId);
    return completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:projectVersion.id,
      stepKey:"animatic",
      payload
    });
  });
}
