import {
  AssetStatus,
  DependencyRelation,
  DomainVersionKind,
  Prisma,
  TimelineItemOrigin,
  TimelineKind,
  TimelineTrackKind,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { createAssetStorage } from "@/lib/storage";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  WizardLockedError
} from "@/lib/wizard/service";
import {
  currentVideoClipVersions,
  lockedVideoClipSources,
  parseVideoClipMetadata,
  videoClipAssetsForProject
} from "@/lib/video-clips/source";
import {
  compileFirstCutPlan,
  type FirstCutPlan,
  type FirstCutSource
} from "./compiler";

export class FirstCutError extends Error{}
export class FirstCutConflictError extends FirstCutError{}

type Tx=Prisma.TransactionClient;

function toJson(value:unknown):Prisma.InputJsonValue{
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function mutationContext(tx:Tx,input:{
  userId:string;
  projectId:string;
  projectVersionId:string;
  expectedWizardRevision:number;
}){
  const progress=await tx.wizardProgress.findFirst({
    where:{
      projectVersionId:input.projectVersionId,
      projectVersion:{
        projectId:input.projectId,
        project:{workspace:{memberships:{some:{userId:input.userId}}}}
      }
    },
    include:{projectVersion:true,steps:true}
  });
  if(!progress) throw new FirstCutError("Automatic First Cut wizard state not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new FirstCutConflictError(
      "Automatic First Cut changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(item=>item.stepKey==="first-cut");
  if(!step) throw new FirstCutError("Automatic First Cut wizard step is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("Automatic First Cut is locked.");
  const sourceStep=progress.steps.find(item=>item.stepKey==="video-clips");
  if(!sourceStep?.lockedAt){
    throw new FirstCutError(
      "Lock Video Clips before compiling the Automatic First Cut."
    );
  }
  if(!progress.projectVersion.audioMasterAssetVersionId){
    throw new FirstCutError(
      "The project has no immutable audio master for the First Cut."
    );
  }
  return {progress,step};
}

async function currentClipSources(
  tx:Tx,
  projectId:string,
  projectVersionId:string
){
  const lockedSources=await lockedVideoClipSources(
    tx,projectId,projectVersionId
  );
  const clipAssets=await videoClipAssetsForProject(tx,projectId);
  return currentVideoClipVersions(lockedSources,clipAssets);
}

function asCompilerSources(
  current:Awaited<ReturnType<typeof currentClipSources>>
):FirstCutSource[]{
  return current.map(item=>{
    const specificationVersion=item.source.source.specificationVersion;
    const specification=item.source.source.specification;
    const clip=item.version;
    if(!specificationVersion||!specification||!clip){
      throw new FirstCutError(
        "Every locked Video Clip requires current Shot Specification provenance."
      );
    }
    const start=item.source.source.storyboardVersion.plannedStartMs;
    const end=item.source.source.storyboardVersion.plannedEndMs;
    if(start===null||end===null){
      throw new FirstCutError(
        "Every First Cut shot requires exact locked Storyboard timing."
      );
    }
    const metadata=parseVideoClipMetadata(clip.metadata);
    return {
      sequencePosition:item.source.source.sequencePosition,
      shotPosition:item.source.source.shotPosition,
      label:item.source.source.storyboardVersion.label,
      shotSpecificationVersionId:specificationVersion.id,
      shotSpecificationNodeId:specificationVersion.nodeId,
      clipAssetVersionId:clip.id,
      clipNodeId:clip.nodeId,
      timelineStartMs:start,
      timelineEndMs:end,
      generatedDurationMs:
        metadata?.generatedDurationMs??clip.durationMs??null,
      transitionIn:specification.transitionIn,
      transitionOut:specification.transitionOut
    };
  });
}

function semanticInput(input:{
  audioMasterAssetVersionId:string;
  plan:FirstCutPlan;
}){
  return {
    audioMasterAssetVersionId:input.audioMasterAssetVersionId,
    items:input.plan.items.map(item=>({
      shotSpecificationVersionId:item.shotSpecificationVersionId,
      clipAssetVersionId:item.clipAssetVersionId,
      timelineStartMs:item.timelineStartMs,
      timelineEndMs:item.timelineEndMs,
      sourceStartMs:item.sourceStartMs,
      sourceEndMs:item.sourceEndMs
    })),
    transitions:input.plan.transitions
  };
}

async function latestFirstCut(
  tx:Tx,
  projectId:string
){
  const timeline=await tx.timeline.findFirst({
    where:{projectId,kind:TimelineKind.FIRST_CUT},
    orderBy:{createdAt:"asc"}
  });
  if(!timeline) return {timeline:null,version:null};
  const version=await tx.timelineVersion.findFirst({
    where:{timelineId:timeline.id},
    orderBy:{versionNumber:"desc"},
    include:{
      node:true,
      items:{
        orderBy:[{trackIndex:"asc"},{position:"asc"}],
        include:{assetVersion:true,shotVersion:true}
      },
      transitions:{
        orderBy:{id:"asc"}
      }
    }
  });
  return {timeline,version};
}

function versionMatchesPlan(input:{
  version:Awaited<ReturnType<typeof latestFirstCut>>["version"];
  projectVersionId:string;
  audioMasterAssetVersionId:string;
  plan:FirstCutPlan;
}){
  const version=input.version;
  if(!version) return false;
  if(
    version.basisProjectVersionId!==input.projectVersionId||
    version.audioMasterAssetVersionId!==input.audioMasterAssetVersionId||
    version.items.length!==input.plan.items.length
  ) return false;

  for(let index=0;index<input.plan.items.length;index++){
    const item=input.plan.items[index]!;
    const stored=version.items[index]!;
    if(
      stored.trackKind!==TimelineTrackKind.VIDEO||
      stored.trackIndex!==0||
      stored.position!==index||
      stored.shotVersionId!==item.shotSpecificationVersionId||
      stored.assetVersionId!==item.clipAssetVersionId||
      stored.timelineStartMs!==item.timelineStartMs||
      stored.timelineEndMs!==item.timelineEndMs||
      stored.sourceStartMs!==item.sourceStartMs||
      stored.sourceEndMs!==item.sourceEndMs
    ) return false;
  }
  return true;
}

export async function buildAutomaticFirstCut(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);

  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const current=await currentClipSources(
      tx,input.projectId,projectVersion.id
    );
    if(!current.length||current.some(item=>!item.version)){
      throw new FirstCutError(
        "Every locked Video Clip must have a current generated asset."
      );
    }

    const compilerSources=asCompilerSources(current);
    let plan:FirstCutPlan;
    try{
      plan=compileFirstCutPlan(compilerSources);
    }catch(error){
      throw new FirstCutError(
        error instanceof Error?error.message:"First Cut compilation failed."
      );
    }

    const audioMasterAssetVersionId=
      context.progress.projectVersion.audioMasterAssetVersionId!;
    const audioMaster=await tx.assetVersion.findFirst({
      where:{
        id:audioMasterAssetVersionId,
        status:AssetStatus.READY,
        asset:{projectId:input.projectId}
      }
    });
    if(!audioMaster){
      throw new FirstCutError(
        "The immutable audio master is not ready for First Cut compilation."
      );
    }

    let timeline=await tx.timeline.findFirst({
      where:{projectId:input.projectId,kind:TimelineKind.FIRST_CUT},
      orderBy:{createdAt:"asc"}
    });
    if(!timeline){
      timeline=await tx.timeline.create({
        data:{
          projectId:input.projectId,
          kind:TimelineKind.FIRST_CUT,
          name:"Automatic First Cut"
        }
      });
    }

    const priorVersions=await tx.timelineVersion.findMany({
      where:{timelineId:timeline.id},
      orderBy:{versionNumber:"desc"},
      include:{node:true}
    });
    const semanticValue=toJson(
      semanticInput({audioMasterAssetVersionId,plan})
    ) as unknown as Prisma.JsonValue;
    const fingerprint=fingerprintJson(semanticValue);

    const latest=priorVersions[0]??null;
    if(
      latest?.node.fingerprint===fingerprint&&
      latest.lifecycle!==VersionLifecycle.SUPERSEDED
    ){
      await completeAutomaticWizardStepInTransaction(tx,{
        projectVersionId:projectVersion.id,
        stepKey:"first-cut",
        payload:toJson({
          timelineId:timeline.id,
          timelineVersionId:latest.id,
          timelineNodeId:latest.nodeId,
          versionNumber:latest.versionNumber,
          audioMasterAssetVersionId,
          videoClipAssetVersionIds:plan.items.map(
            item=>item.clipAssetVersionId
          ),
          shotSpecificationVersionIds:plan.items.map(
            item=>item.shotSpecificationVersionId
          ),
          durationMs:plan.durationMs,
          itemCount:plan.items.length,
          transitionCount:plan.transitions.length
        }),
        semanticFingerprint:fingerprint
      });
      return {
        timelineId:timeline.id,
        timelineVersionId:latest.id,
        versionNumber:latest.versionNumber,
        changed:false
      };
    }

    const draftIds=priorVersions
      .filter(version=>version.lifecycle===VersionLifecycle.DRAFT)
      .map(version=>version.id);
    if(draftIds.length){
      await tx.timelineVersion.updateMany({
        where:{id:{in:draftIds}},
        data:{lifecycle:VersionLifecycle.SUPERSEDED}
      });
    }

    const node=await tx.domainVersionNode.create({
      data:{
        kind:DomainVersionKind.TIMELINE,
        fingerprint
      }
    });
    const version=await tx.timelineVersion.create({
      data:{
        timelineId:timeline.id,
        nodeId:node.id,
        versionNumber:(latest?.versionNumber??0)+1,
        lifecycle:VersionLifecycle.DRAFT,
        basisProjectVersionId:projectVersion.id,
        audioMasterAssetVersionId,
        parentTimelineVersionId:latest?.id??null,
        compiledAutomatically:true,
        notes:
          "Automatically compiled from the locked Video Clips stage and immutable audio master.",
        createdByUserId:input.userId
      }
    });

    const createdItems=[];
    for(const item of plan.items){
      const created=await tx.timelineItem.create({
        data:{
          timelineVersionId:version.id,
          trackKind:TimelineTrackKind.VIDEO,
          trackIndex:0,
          position:item.position,
          origin:TimelineItemOrigin.AUTOMATIC,
          shotVersionId:item.shotSpecificationVersionId,
          assetVersionId:item.clipAssetVersionId,
          timelineStartMs:item.timelineStartMs,
          timelineEndMs:item.timelineEndMs,
          sourceStartMs:item.sourceStartMs,
          sourceEndMs:item.sourceEndMs,
          manualOverride:false,
          parameters:toJson({
            sequencePosition:item.sequencePosition,
            shotPosition:item.shotPosition,
            label:item.label,
            generatedDurationMs:item.generatedDurationMs
          })
        }
      });
      createdItems.push(created);
    }

    for(const transition of plan.transitions){
      const fromItem=createdItems[transition.fromPosition]!;
      const toItem=createdItems[transition.toPosition]!;
      await tx.timelineTransition.create({
        data:{
          timelineVersionId:version.id,
          fromItemId:fromItem.id,
          toItemId:toItem.id,
          kind:transition.kind,
          durationMs:transition.durationMs,
          parameters:toJson({
            outgoingIntent:transition.outgoingIntent,
            incomingIntent:transition.incomingIntent,
            durationSpecified:transition.durationSpecified
          })
        }
      });
    }

    await registerDependencyEdgeInTransaction(tx,{
      upstreamNodeId:audioMaster.nodeId,
      downstreamNodeId:node.id,
      relation:DependencyRelation.REFERENCES,
      reason:
        "Automatic First Cut is synchronized to this exact immutable audio master AssetVersion."
    });

    for(const item of plan.items){
      await registerDependencyEdgeInTransaction(tx,{
        upstreamNodeId:item.clipNodeId,
        downstreamNodeId:node.id,
        relation:DependencyRelation.COMPILED_FROM,
        reason:
          "Automatic First Cut uses this exact generated Video Clip AssetVersion."
      });
      await registerDependencyEdgeInTransaction(tx,{
        upstreamNodeId:item.shotSpecificationNodeId,
        downstreamNodeId:node.id,
        relation:DependencyRelation.COMPILED_FROM,
        reason:
          "Automatic First Cut preserves timing and transition intent from this locked Shot Specification."
      });
    }

    await completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:projectVersion.id,
      stepKey:"first-cut",
      payload:toJson({
        timelineId:timeline.id,
        timelineVersionId:version.id,
        timelineNodeId:node.id,
        versionNumber:version.versionNumber,
        audioMasterAssetVersionId,
        videoClipAssetVersionIds:plan.items.map(
          item=>item.clipAssetVersionId
        ),
        shotSpecificationVersionIds:plan.items.map(
          item=>item.shotSpecificationVersionId
        ),
        durationMs:plan.durationMs,
        itemCount:plan.items.length,
        transitionCount:plan.transitions.length
      }),
      semanticFingerprint:fingerprint
    });

    return {
      timelineId:timeline.id,
      timelineVersionId:version.id,
      versionNumber:version.versionNumber,
      changed:true
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function lockAutomaticFirstCut(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);

  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(context.step.status!==WizardStepStatus.COMPLETED){
      throw new FirstCutError(
        "Build a complete Automatic First Cut before locking it."
      );
    }

    const current=await currentClipSources(
      tx,input.projectId,projectVersion.id
    );
    if(!current.length||current.some(item=>!item.version)){
      throw new FirstCutError(
        "The locked Video Clip set is incomplete."
      );
    }
    let plan:FirstCutPlan;
    try{
      plan=compileFirstCutPlan(asCompilerSources(current));
    }catch(error){
      throw new FirstCutError(
        error instanceof Error?error.message:"First Cut source validation failed."
      );
    }

    const latest=await latestFirstCut(tx,input.projectId);
    const audioMasterAssetVersionId=
      context.progress.projectVersion.audioMasterAssetVersionId!;
    if(!versionMatchesPlan({
      version:latest.version,
      projectVersionId:projectVersion.id,
      audioMasterAssetVersionId,
      plan
    })){
      throw new FirstCutError(
        "Rebuild the Automatic First Cut from the current locked Video Clips before locking."
      );
    }
    if(!latest.version){
      throw new FirstCutError("Automatic First Cut timeline not found.");
    }

    const now=new Date();
    await tx.timelineVersion.update({
      where:{id:latest.version.id},
      data:{
        lifecycle:VersionLifecycle.LOCKED,
        lockedAt:now
      }
    });
    await tx.wizardStepState.update({
      where:{id:context.step.id},
      data:{lockedAt:now}
    });
    await tx.wizardProgress.update({
      where:{id:context.progress.id},
      data:{revision:{increment:1}}
    });

    return {
      timelineVersionId:latest.version.id,
      versionNumber:latest.version.versionNumber
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getAutomaticFirstCutState(input:{
  userId:string;
  projectId:string;
}){
  const projectVersion=await ensureWizardProgress(input);

  const snapshot=await db.$transaction(async tx=>{
    const progress=await tx.wizardProgress.findUniqueOrThrow({
      where:{projectVersionId:projectVersion.id},
      include:{projectVersion:true,steps:true}
    });
    const sourceStep=progress.steps.find(step=>step.stepKey==="video-clips");
    const firstCutStep=progress.steps.find(step=>step.stepKey==="first-cut");
    const current=await currentClipSources(
      tx,input.projectId,projectVersion.id
    );

    let plan:FirstCutPlan|null=null;
    let sourceError:string|null=null;
    if(
      sourceStep?.lockedAt&&
      current.length&&
      current.every(item=>Boolean(item.version))
    ){
      try{
        plan=compileFirstCutPlan(asCompilerSources(current));
      }catch(error){
        sourceError=error instanceof Error?error.message:"First Cut source validation failed.";
      }
    }

    const latest=await latestFirstCut(tx,input.projectId);
    const audioMasterAssetVersionId=
      progress.projectVersion.audioMasterAssetVersionId;
    const currentVersion=Boolean(
      plan&&
      audioMasterAssetVersionId&&
      versionMatchesPlan({
        version:latest.version,
        projectVersionId:projectVersion.id,
        audioMasterAssetVersionId,
        plan
      })
    );

    const importedPayload=firstCutStep?.payload as Record<string,unknown>|null;
    const imported=Boolean(importedPayload?.origin==="IMPORTED_ASSEMBLY"&&
      importedPayload.timelineVersionId===latest.version?.id&&
      latest.version?.basisProjectVersionId===projectVersion.id&&firstCutStep?.lockedAt);
    return {
      sourceReady:imported||Boolean(
        sourceStep?.lockedAt&&
        plan&&
        audioMasterAssetVersionId
      ),
      sourceError,
      needsRebuild:Boolean(sourceStep?.lockedAt&&plan&&!currentVersion),
      wizardRevision:progress.revision,
      wizardStatus:firstCutStep?.status??WizardStepStatus.NOT_STARTED,
      wizardLocked:Boolean(firstCutStep?.lockedAt),
      timeline:latest.timeline,
      version:latest.version,
      plan
    };
  });

  const storage=createAssetStorage();
  const timelineVersion=snapshot.version;
  const items=timelineVersion
    ?await Promise.all(timelineVersion.items.map(async item=>({
      id:item.id,
      position:item.position,
      shotSpecificationVersionId:item.shotVersionId,
      clipAssetVersionId:item.assetVersionId,
      timelineStartMs:item.timelineStartMs,
      timelineEndMs:item.timelineEndMs,
      sourceStartMs:item.sourceStartMs,
      sourceEndMs:item.sourceEndMs,
      parameters:item.parameters,
      clipUrl:item.assetVersion
        ?await storage.getSignedReadUrl(
          item.assetVersion.storageKey,
          60*30
        )
        :null
    })))
    :[];

  return {
    sourceReady:snapshot.sourceReady,
    sourceError:snapshot.sourceError,
    needsRebuild:snapshot.needsRebuild,
    wizardRevision:snapshot.wizardRevision,
    wizardStatus:snapshot.wizardStatus,
    wizardLocked:snapshot.wizardLocked,
    timeline:snapshot.timeline
      ?{
        id:snapshot.timeline.id,
        name:snapshot.timeline.name
      }
      :null,
    version:timelineVersion
      ?{
        id:timelineVersion.id,
        versionNumber:timelineVersion.versionNumber,
        lifecycle:timelineVersion.lifecycle,
        compiledAutomatically:timelineVersion.compiledAutomatically,
        audioMasterAssetVersionId:
          timelineVersion.audioMasterAssetVersionId,
        createdAt:timelineVersion.createdAt,
        lockedAt:timelineVersion.lockedAt,
        items,
        transitions:timelineVersion.transitions.map(transition=>({
          id:transition.id,
          fromItemId:transition.fromItemId,
          toItemId:transition.toItemId,
          kind:transition.kind,
          durationMs:transition.durationMs,
          parameters:transition.parameters
        }))
      }
      :null,
    durationMs:snapshot.plan?.durationMs??timelineVersion?.items.at(-1)?.timelineEndMs??null
  };
}
