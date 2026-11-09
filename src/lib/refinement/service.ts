import {
  AssetKind,
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
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import { parseVideoClipMetadata } from "@/lib/video-clips/source";
import {
  replaceClip,
  retimeBoundary,
  updateTransition,
  validateWorkingTimeline,
  type WorkingTimelineSnapshot
} from "./timeline";

export class RefinementError extends Error{}
export class RefinementConflictError extends RefinementError{}

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
  if(!progress) throw new RefinementError("Refinement wizard state not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("This project version is locked.");
  }
  if(progress.revision!==input.expectedWizardRevision){
    throw new RefinementConflictError(
      "Refinement changed in another request. Reload before continuing."
    );
  }
  const step=progress.steps.find(item=>item.stepKey==="refinement");
  if(!step) throw new RefinementError("Refinement wizard step is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("Refinement is locked.");
  const sourceStep=progress.steps.find(item=>item.stepKey==="first-cut");
  if(!sourceStep?.lockedAt){
    throw new RefinementError(
      "Lock the Automatic First Cut before starting Refinement."
    );
  }
  return {progress,step};
}

async function lockedFirstCut(tx:Tx,projectId:string){
  const timeline=await tx.timeline.findFirst({
    where:{projectId,kind:TimelineKind.FIRST_CUT},
    orderBy:{createdAt:"asc"}
  });
  if(!timeline) return null;
  return tx.timelineVersion.findFirst({
    where:{
      timelineId:timeline.id,
      lifecycle:VersionLifecycle.LOCKED
    },
    orderBy:{versionNumber:"desc"},
    include:{
      node:true,
      items:{
        orderBy:[{trackIndex:"asc"},{position:"asc"}],
        include:{assetVersion:true}
      },
      transitions:true
    }
  });
}

async function workingTimeline(tx:Tx,projectId:string){
  return tx.timeline.findFirst({
    where:{projectId,kind:TimelineKind.WORKING},
    orderBy:{createdAt:"asc"}
  });
}

async function latestWorkingVersion(tx:Tx,projectId:string){
  const timeline=await workingTimeline(tx,projectId);
  if(!timeline) return {timeline:null,version:null};
  const version=await tx.timelineVersion.findFirst({
    where:{timelineId:timeline.id},
    orderBy:{versionNumber:"desc"},
    include:{
      node:true,
      items:{
        orderBy:[{trackIndex:"asc"},{position:"asc"}],
        include:{assetVersion:true}
      },
      transitions:true
    }
  });
  return {timeline,version};
}

function snapshotFromVersion(input:{
  items:Array<{
    id:string;
    position:number;
    shotVersionId:string|null;
    assetVersionId:string|null;
    timelineStartMs:number;
    timelineEndMs:number;
    sourceStartMs:number;
    sourceEndMs:number|null;
    manualOverride:boolean;
    parameters:Prisma.JsonValue|null;
    assetVersion:{
      nodeId:string;
      durationMs:number|null;
    }|null;
  }>;
  transitions:Array<{
    fromItemId:string;
    toItemId:string;
    kind:string;
    durationMs:number;
    parameters:Prisma.JsonValue|null;
  }>;
}):WorkingTimelineSnapshot{
  const idToPosition=new Map(
    input.items.map(item=>[item.id,item.position])
  );
  const items=input.items.map(item=>{
    if(!item.shotVersionId||!item.assetVersionId||!item.assetVersion){
      throw new RefinementError(
        "Refinement source contains an incomplete video timeline item."
      );
    }
    if(item.sourceEndMs===null){
      throw new RefinementError(
        "Refinement source requires explicit source-end timing."
      );
    }
    return {
      position:item.position,
      shotVersionId:item.shotVersionId,
      assetVersionId:item.assetVersionId,
      assetNodeId:item.assetVersion.nodeId,
      timelineStartMs:item.timelineStartMs,
      timelineEndMs:item.timelineEndMs,
      sourceStartMs:item.sourceStartMs,
      sourceEndMs:item.sourceEndMs,
      manualOverride:item.manualOverride,
      parameters:item.parameters,
      availableDurationMs:item.assetVersion.durationMs
    };
  });
  const transitions=input.transitions.map(transition=>{
    const fromPosition=idToPosition.get(transition.fromItemId);
    const toPosition=idToPosition.get(transition.toItemId);
    if(fromPosition===undefined||toPosition===undefined){
      throw new RefinementError(
        "Refinement source transition references a missing item."
      );
    }
    return {
      fromPosition,
      toPosition,
      kind:transition.kind,
      durationMs:transition.durationMs,
      parameters:transition.parameters
    };
  }).sort((a,b)=>a.fromPosition-b.fromPosition);
  const snapshot={items,transitions};
  validateWorkingTimeline(snapshot);
  return snapshot;
}

function fingerprint(snapshot:WorkingTimelineSnapshot){
  return fingerprintJson(
    toJson({
      items:snapshot.items.map(item=>({
        position:item.position,
        shotVersionId:item.shotVersionId,
        assetVersionId:item.assetVersionId,
        timelineStartMs:item.timelineStartMs,
        timelineEndMs:item.timelineEndMs,
        sourceStartMs:item.sourceStartMs,
        sourceEndMs:item.sourceEndMs,
        manualOverride:item.manualOverride,
        parameters:item.parameters
      })),
      transitions:snapshot.transitions
    }) as unknown as Prisma.JsonValue
  );
}

async function sourceDependencyExists(
  tx:Tx,
  sourceNodeId:string,
  workingNodeId:string
){
  return Boolean(await tx.dependencyEdge.findFirst({
    where:{
      upstreamNodeId:sourceNodeId,
      downstreamNodeId:workingNodeId,
      relation:DependencyRelation.DERIVED_FROM
    },
    select:{id:true}
  }));
}

async function persistWorkingVersion(tx:Tx,input:{
  projectId:string;
  projectVersionId:string;
  userId:string;
  sourceFirstCut:{
    id:string;
    nodeId:string;
    audioMasterAssetVersionId:string;
    basisProjectVersionId:string;
  };
  parentVersion:{
    id:string;
    nodeId:string;
    timelineId:string;
    versionNumber:number;
  };
  snapshot:WorkingTimelineSnapshot;
  reason:string;
}){
  validateWorkingTimeline(input.snapshot);
  const semanticFingerprint=fingerprint(input.snapshot);
  const timeline=await tx.timeline.findUniqueOrThrow({
    where:{id:input.parentVersion.timelineId}
  });

  const priorDrafts=await tx.timelineVersion.findMany({
    where:{
      timelineId:timeline.id,
      lifecycle:VersionLifecycle.DRAFT
    },
    select:{id:true}
  });
  if(priorDrafts.length){
    await tx.timelineVersion.updateMany({
      where:{id:{in:priorDrafts.map(item=>item.id)}},
      data:{lifecycle:VersionLifecycle.SUPERSEDED}
    });
  }

  const node=await tx.domainVersionNode.create({
    data:{
      kind:DomainVersionKind.TIMELINE,
      fingerprint:semanticFingerprint
    }
  });
  const version=await tx.timelineVersion.create({
    data:{
      timelineId:timeline.id,
      nodeId:node.id,
      versionNumber:input.parentVersion.versionNumber+1,
      lifecycle:VersionLifecycle.DRAFT,
      basisProjectVersionId:input.projectVersionId,
      audioMasterAssetVersionId:
        input.sourceFirstCut.audioMasterAssetVersionId,
      parentTimelineVersionId:input.parentVersion.id,
      compiledAutomatically:false,
      notes:input.reason,
      createdByUserId:input.userId
    }
  });

  const itemIds:string[]=[];
  for(const item of input.snapshot.items){
    const created=await tx.timelineItem.create({
      data:{
        timelineVersionId:version.id,
        trackKind:TimelineTrackKind.VIDEO,
        trackIndex:0,
        position:item.position,
        origin:item.manualOverride
          ?TimelineItemOrigin.MANUAL
          :TimelineItemOrigin.AUTOMATIC,
        shotVersionId:item.shotVersionId,
        assetVersionId:item.assetVersionId,
        timelineStartMs:item.timelineStartMs,
        timelineEndMs:item.timelineEndMs,
        sourceStartMs:item.sourceStartMs,
        sourceEndMs:item.sourceEndMs,
        manualOverride:item.manualOverride,
        parameters:toJson(item.parameters??{})
      }
    });
    itemIds.push(created.id);
  }

  for(const transition of input.snapshot.transitions){
    await tx.timelineTransition.create({
      data:{
        timelineVersionId:version.id,
        fromItemId:itemIds[transition.fromPosition]!,
        toItemId:itemIds[transition.toPosition]!,
        kind:transition.kind,
        durationMs:transition.durationMs,
        parameters:toJson(transition.parameters??{})
      }
    });
  }

  const upstreamNodes=new Set<string>([
    input.sourceFirstCut.nodeId,
    input.parentVersion.nodeId
  ]);
  for(const upstreamNodeId of upstreamNodes){
    await registerDependencyEdgeInTransaction(tx,{
      upstreamNodeId,
      downstreamNodeId:node.id,
      relation:DependencyRelation.DERIVED_FROM,
      reason:
        upstreamNodeId===input.sourceFirstCut.nodeId
          ?"Working refinement remains derived from this locked First Cut."
          :"Working refinement version derives from the immediately prior timeline version."
    });
  }

  const audio=await tx.assetVersion.findUniqueOrThrow({
    where:{id:input.sourceFirstCut.audioMasterAssetVersionId}
  });
  await registerDependencyEdgeInTransaction(tx,{
    upstreamNodeId:audio.nodeId,
    downstreamNodeId:node.id,
    relation:DependencyRelation.REFERENCES,
    reason:"Working refinement remains synchronized to the immutable audio master."
  });

  for(const item of input.snapshot.items){
    await registerDependencyEdgeInTransaction(tx,{
      upstreamNodeId:item.assetNodeId,
      downstreamNodeId:node.id,
      relation:DependencyRelation.REFERENCES,
      reason:"Working refinement uses this exact Video Clip AssetVersion."
    });
  }

  await saveManagedWizardStepInTransaction(tx,{
    projectVersionId:input.projectVersionId,
    stepKey:"refinement",
    payload:toJson({
      timelineId:timeline.id,
      timelineVersionId:version.id,
      timelineNodeId:node.id,
      sourceFirstCutTimelineVersionId:input.sourceFirstCut.id,
      versionNumber:version.versionNumber,
      itemCount:input.snapshot.items.length,
      transitionCount:input.snapshot.transitions.length
    }),
    semanticFingerprint
  });

  return version;
}

export async function initializeWorkingTimeline(tx:Tx,input:{
  projectId:string;
  projectVersionId:string;
  userId:string;
  sourceFirstCut:NonNullable<Awaited<ReturnType<typeof lockedFirstCut>>>;
}){
  const existing=await latestWorkingVersion(tx,input.projectId);
  if(
    existing.version&&
    existing.timeline&&
    existing.version.lifecycle===VersionLifecycle.DRAFT&&
    existing.version.basisProjectVersionId===input.projectVersionId&&
    await sourceDependencyExists(
      tx,input.sourceFirstCut.nodeId,existing.version.nodeId
    )
  ){
    const snapshot=snapshotFromVersion(existing.version);
    await saveManagedWizardStepInTransaction(tx,{
      projectVersionId:input.projectVersionId,
      stepKey:"refinement",
      payload:toJson({
        timelineId:existing.timeline.id,
        timelineVersionId:existing.version.id,
        timelineNodeId:existing.version.nodeId,
        sourceFirstCutTimelineVersionId:input.sourceFirstCut.id,
        versionNumber:existing.version.versionNumber,
        itemCount:snapshot.items.length,
        transitionCount:snapshot.transitions.length
      }),
      semanticFingerprint:fingerprint(snapshot)
    });
    return {version:existing.version,changed:false};
  }

  let timeline=existing.timeline;
  if(!timeline){
    timeline=await tx.timeline.create({
      data:{
        projectId:input.projectId,
        kind:TimelineKind.WORKING,
        name:"Refinement"
      }
    });
  }

  const sourceSnapshot=snapshotFromVersion(input.sourceFirstCut);
  validateWorkingTimeline(sourceSnapshot);

  const node=await tx.domainVersionNode.create({
    data:{
      kind:DomainVersionKind.TIMELINE,
      fingerprint:fingerprint(sourceSnapshot)
    }
  });
  const version=await tx.timelineVersion.create({
    data:{
      timelineId:timeline.id,
      nodeId:node.id,
      versionNumber:(existing.version?.versionNumber??0)+1,
      lifecycle:VersionLifecycle.DRAFT,
      basisProjectVersionId:input.projectVersionId,
      audioMasterAssetVersionId:
        input.sourceFirstCut.audioMasterAssetVersionId,
      parentTimelineVersionId:input.sourceFirstCut.id,
      compiledAutomatically:false,
      notes:"Initialized non-destructively from the locked Automatic First Cut.",
      createdByUserId:input.userId
    }
  });

  const itemIds:string[]=[];
  for(const item of sourceSnapshot.items){
    const created=await tx.timelineItem.create({
      data:{
        timelineVersionId:version.id,
        trackKind:TimelineTrackKind.VIDEO,
        trackIndex:0,
        position:item.position,
        origin:TimelineItemOrigin.AUTOMATIC,
        shotVersionId:item.shotVersionId,
        assetVersionId:item.assetVersionId,
        timelineStartMs:item.timelineStartMs,
        timelineEndMs:item.timelineEndMs,
        sourceStartMs:item.sourceStartMs,
        sourceEndMs:item.sourceEndMs,
        manualOverride:false,
        parameters:toJson(item.parameters??{})
      }
    });
    itemIds.push(created.id);
  }
  for(const transition of sourceSnapshot.transitions){
    await tx.timelineTransition.create({
      data:{
        timelineVersionId:version.id,
        fromItemId:itemIds[transition.fromPosition]!,
        toItemId:itemIds[transition.toPosition]!,
        kind:transition.kind,
        durationMs:transition.durationMs,
        parameters:toJson(transition.parameters??{})
      }
    });
  }

  await registerDependencyEdgeInTransaction(tx,{
    upstreamNodeId:input.sourceFirstCut.nodeId,
    downstreamNodeId:node.id,
    relation:DependencyRelation.DERIVED_FROM,
    reason:"Refinement begins as a non-destructive copy of this locked First Cut."
  });
  const audio=await tx.assetVersion.findUniqueOrThrow({
    where:{id:input.sourceFirstCut.audioMasterAssetVersionId}
  });
  await registerDependencyEdgeInTransaction(tx,{
    upstreamNodeId:audio.nodeId,
    downstreamNodeId:node.id,
    relation:DependencyRelation.REFERENCES,
    reason:"Refinement remains synchronized to the immutable audio master."
  });
  for(const item of sourceSnapshot.items){
    await registerDependencyEdgeInTransaction(tx,{
      upstreamNodeId:item.assetNodeId,
      downstreamNodeId:node.id,
      relation:DependencyRelation.REFERENCES,
      reason:"Refinement begins with this exact locked Video Clip AssetVersion."
    });
  }

  await saveManagedWizardStepInTransaction(tx,{
    projectVersionId:input.projectVersionId,
    stepKey:"refinement",
    payload:toJson({
      timelineId:timeline.id,
      timelineVersionId:version.id,
      timelineNodeId:node.id,
      sourceFirstCutTimelineVersionId:input.sourceFirstCut.id,
      versionNumber:version.versionNumber,
      itemCount:sourceSnapshot.items.length,
      transitionCount:sourceSnapshot.transitions.length
    }),
    semanticFingerprint:fingerprint(sourceSnapshot)
  });

  return {version,changed:true};
}

async function requireCurrentWorking(tx:Tx,input:{
  projectId:string;
  expectedTimelineVersionId:string;
}){
  const current=await latestWorkingVersion(tx,input.projectId);
  if(!current.timeline||!current.version){
    throw new RefinementError("Initialize Refinement before editing.");
  }
  if(current.version.id!==input.expectedTimelineVersionId){
    throw new RefinementConflictError(
      "Refinement timeline changed in another request. Reload before continuing."
    );
  }
  if(current.version.lifecycle!==VersionLifecycle.DRAFT){
    throw new WizardLockedError("The current Refinement timeline is not editable.");
  }
  return {timeline:current.timeline,version:current.version};
}

export async function initializeRefinement(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const source=await lockedFirstCut(tx,input.projectId);
    if(!source){
      throw new RefinementError("Locked Automatic First Cut timeline not found.");
    }
    const result=await initializeWorkingTimeline(tx,{
      projectId:input.projectId,
      projectVersionId:projectVersion.id,
      userId:input.userId,
      sourceFirstCut:source
    });
    return {
      timelineVersionId:result.version.id,
      versionNumber:result.version.versionNumber,
      changed:result.changed
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function retimeRefinementBoundary(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  expectedTimelineVersionId:string;
  boundaryPosition:number;
  timelineMs:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const source=await lockedFirstCut(tx,input.projectId);
    if(!source) throw new RefinementError("Locked First Cut not found.");
    const current=await requireCurrentWorking(tx,input);
    let snapshot=snapshotFromVersion(current.version);
    try{
      snapshot=retimeBoundary(
        snapshot,input.boundaryPosition,input.timelineMs
      );
    }catch(error){
      throw new RefinementError(
        error instanceof Error?error.message:"Refinement retiming failed."
      );
    }
    const version=await persistWorkingVersion(tx,{
      projectId:input.projectId,
      projectVersionId:projectVersion.id,
      userId:input.userId,
      sourceFirstCut:source,
      parentVersion:{
        id:current.version.id,
        nodeId:current.version.nodeId,
        timelineId:current.timeline.id,
        versionNumber:current.version.versionNumber
      },
      snapshot,
      reason:
        "Manual refinement: moved cut boundary after item "+
        String(input.boundaryPosition+1)+"."
    });
    return {
      timelineVersionId:version.id,
      versionNumber:version.versionNumber
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function replaceRefinementClip(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  expectedTimelineVersionId:string;
  position:number;
  assetVersionId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const source=await lockedFirstCut(tx,input.projectId);
    if(!source) throw new RefinementError("Locked First Cut not found.");
    const current=await requireCurrentWorking(tx,input);
    const snapshot=snapshotFromVersion(current.version);
    const item=snapshot.items[input.position];
    if(!item) throw new RefinementError("Selected timeline item does not exist.");

    const replacement=await tx.assetVersion.findFirst({
      where:{
        id:input.assetVersionId,
        status:AssetStatus.READY,
        asset:{
          projectId:input.projectId,
          kind:AssetKind.GENERATED_VIDEO
        }
      }
    });
    if(!replacement){
      throw new RefinementError("Selected replacement clip is unavailable.");
    }
    const metadata=parseVideoClipMetadata(replacement.metadata);
    if(
      !metadata||
      metadata.sourceShotSpecificationVersionId!==item.shotVersionId
    ){
      throw new RefinementError(
        "Replacement clip must come from the same locked Shot Specification."
      );
    }

    let next:WorkingTimelineSnapshot;
    try{
      next=replaceClip(snapshot,input.position,{
        assetVersionId:replacement.id,
        assetNodeId:replacement.nodeId,
        availableDurationMs:
          metadata.generatedDurationMs??replacement.durationMs
      });
    }catch(error){
      throw new RefinementError(
        error instanceof Error?error.message:"Clip replacement failed."
      );
    }

    const version=await persistWorkingVersion(tx,{
      projectId:input.projectId,
      projectVersionId:projectVersion.id,
      userId:input.userId,
      sourceFirstCut:source,
      parentVersion:{
        id:current.version.id,
        nodeId:current.version.nodeId,
        timelineId:current.timeline.id,
        versionNumber:current.version.versionNumber
      },
      snapshot:next,
      reason:
        "Manual refinement: replaced clip at position "+
        String(input.position+1)+"."
    });
    return {
      timelineVersionId:version.id,
      versionNumber:version.versionNumber
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function updateRefinementTransition(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  expectedTimelineVersionId:string;
  fromPosition:number;
  kind:string;
  durationMs:number;
  note:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const source=await lockedFirstCut(tx,input.projectId);
    if(!source) throw new RefinementError("Locked First Cut not found.");
    const current=await requireCurrentWorking(tx,input);
    let snapshot=snapshotFromVersion(current.version);
    try{
      snapshot=updateTransition(snapshot,{
        fromPosition:input.fromPosition,
        kind:input.kind,
        durationMs:input.durationMs,
        note:input.note
      });
    }catch(error){
      throw new RefinementError(
        error instanceof Error?error.message:"Transition refinement failed."
      );
    }

    const version=await persistWorkingVersion(tx,{
      projectId:input.projectId,
      projectVersionId:projectVersion.id,
      userId:input.userId,
      sourceFirstCut:source,
      parentVersion:{
        id:current.version.id,
        nodeId:current.version.nodeId,
        timelineId:current.timeline.id,
        versionNumber:current.version.versionNumber
      },
      snapshot,
      reason:
        "Manual refinement: updated transition after item "+
        String(input.fromPosition+1)+"."
    });
    return {
      timelineVersionId:version.id,
      versionNumber:version.versionNumber
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function completeRefinement(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  expectedTimelineVersionId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    const current=await requireCurrentWorking(tx,input);
    const snapshot=snapshotFromVersion(current.version);
    validateWorkingTimeline(snapshot);
    const source=await lockedFirstCut(tx,input.projectId);
    if(!source) throw new RefinementError("Locked First Cut not found.");

    await completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:projectVersion.id,
      stepKey:"refinement",
      payload:toJson({
        timelineId:current.timeline.id,
        timelineVersionId:current.version.id,
        timelineNodeId:current.version.nodeId,
        sourceFirstCutTimelineVersionId:source.id,
        versionNumber:current.version.versionNumber,
        itemCount:snapshot.items.length,
        transitionCount:snapshot.transitions.length
      }),
      semanticFingerprint:fingerprint(snapshot)
    });
    return {
      timelineVersionId:current.version.id,
      versionNumber:current.version.versionNumber
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function lockRefinement(input:{
  userId:string;
  projectId:string;
  expectedWizardRevision:number;
  expectedTimelineVersionId:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{
      ...input,
      projectVersionId:projectVersion.id
    });
    if(context.step.status!==WizardStepStatus.COMPLETED){
      throw new RefinementError(
        "Complete Refinement before locking the working timeline."
      );
    }
    const current=await requireCurrentWorking(tx,input);
    validateWorkingTimeline(snapshotFromVersion(current.version));

    const now=new Date();
    await tx.timelineVersion.update({
      where:{id:current.version.id},
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
      timelineVersionId:current.version.id,
      versionNumber:current.version.versionNumber
    };
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getRefinementState(input:{
  userId:string;
  projectId:string;
}){
  const projectVersion=await ensureWizardProgress(input);

  const snapshot=await db.$transaction(async tx=>{
    const progress=await tx.wizardProgress.findUniqueOrThrow({
      where:{projectVersionId:projectVersion.id},
      include:{steps:true}
    });
    const sourceStep=progress.steps.find(step=>step.stepKey==="first-cut");
    const refinementStep=progress.steps.find(step=>step.stepKey==="refinement");
    const source=await lockedFirstCut(tx,input.projectId);
    const current=await latestWorkingVersion(tx,input.projectId);
    const currentMatchesSource=Boolean(
      source&&
      current.version&&
      await sourceDependencyExists(
        tx,source.nodeId,current.version.nodeId
      )
    );

    const alternatives=await tx.assetVersion.findMany({
      where:{
        status:AssetStatus.READY,
        asset:{
          projectId:input.projectId,
          kind:AssetKind.GENERATED_VIDEO
        }
      },
      orderBy:{createdAt:"desc"},
      include:{asset:true}
    });
    const history=current.timeline
      ?await tx.timelineVersion.findMany({
        where:{timelineId:current.timeline.id},
        orderBy:{versionNumber:"desc"},
        select:{
          id:true,
          versionNumber:true,
          lifecycle:true,
          notes:true,
          createdAt:true,
          lockedAt:true
        }
      })
      :[];

    return {
      sourceReady:Boolean(sourceStep?.lockedAt&&source),
      needsInitialize:Boolean(
        sourceStep?.lockedAt&&source&&!currentMatchesSource
      ),
      source,
      timeline:current.timeline,
      version:current.version,
      wizardRevision:progress.revision,
      wizardStatus:refinementStep?.status??WizardStepStatus.NOT_STARTED,
      wizardLocked:Boolean(refinementStep?.lockedAt),
      alternatives,
      history
    };
  });

  const storage=createAssetStorage();
  const version=snapshot.version;
  const items=version
    ?await Promise.all(version.items.map(async item=>{
      const metadata=item.assetVersion
        ?parseVideoClipMetadata(item.assetVersion.metadata)
        :null;
      const alternatives=snapshot.alternatives.filter(candidate=>{
        const candidateMetadata=parseVideoClipMetadata(candidate.metadata);
        return Boolean(
          item.shotVersionId&&
          candidateMetadata?.sourceShotSpecificationVersionId===
            item.shotVersionId
        );
      });
      return {
        id:item.id,
        position:item.position,
        shotVersionId:item.shotVersionId,
        assetVersionId:item.assetVersionId,
        timelineStartMs:item.timelineStartMs,
        timelineEndMs:item.timelineEndMs,
        sourceStartMs:item.sourceStartMs,
        sourceEndMs:item.sourceEndMs,
        manualOverride:item.manualOverride,
        parameters:item.parameters,
        clipUrl:item.assetVersion
          ?await storage.getSignedReadUrl(
            item.assetVersion.storageKey,60*30
          )
          :null,
        currentClipVersionNumber:
          item.assetVersion?.versionNumber??null,
        currentGeneratedDurationMs:
          metadata?.generatedDurationMs??
          item.assetVersion?.durationMs??null,
        alternatives:await Promise.all(
          alternatives.map(async candidate=>({
            assetVersionId:candidate.id,
            versionNumber:candidate.versionNumber,
            createdAt:candidate.createdAt,
            durationMs:
              parseVideoClipMetadata(candidate.metadata)?.generatedDurationMs??
              candidate.durationMs,
            url:await storage.getSignedReadUrl(
              candidate.storageKey,60*30
            )
          }))
        )
      };
    }))
    :[];

  return {
    sourceReady:snapshot.sourceReady,
    needsInitialize:snapshot.needsInitialize,
    wizardRevision:snapshot.wizardRevision,
    wizardStatus:snapshot.wizardStatus,
    wizardLocked:snapshot.wizardLocked,
    sourceFirstCut:snapshot.source
      ?{
        id:snapshot.source.id,
        versionNumber:snapshot.source.versionNumber
      }
      :null,
    timeline:snapshot.timeline
      ?{
        id:snapshot.timeline.id,
        name:snapshot.timeline.name
      }
      :null,
    version:version
      ?{
        id:version.id,
        versionNumber:version.versionNumber,
        lifecycle:version.lifecycle,
        createdAt:version.createdAt,
        lockedAt:version.lockedAt,
        items,
        transitions:version.transitions.map(transition=>({
          id:transition.id,
          fromItemId:transition.fromItemId,
          toItemId:transition.toItemId,
          kind:transition.kind,
          durationMs:transition.durationMs,
          parameters:transition.parameters
        }))
      }
      :null,
    history:snapshot.history
  };
}
