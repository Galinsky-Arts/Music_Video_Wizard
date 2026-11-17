import {
  DependencyRelation,
  DomainVersionKind,
  GenerationKind,
  GenerationStatus,
  MusicMapAnchorDecision,
  Prisma,
  VersionLifecycle,
  WizardStepStatus
} from "@prisma/client";
import { db } from "@/lib/db";
import { fingerprintJson } from "@/lib/dependency-graph/fingerprint";
import { registerDependencyEdgeInTransaction } from "@/lib/dependency-graph/service";
import { getEnvironment } from "@/lib/env";
import { enqueueGenerationJob } from "@/lib/jobs/service";
import { getConfiguredTextProvider, textGenerationAvailable } from "@/lib/text-generation/factory";
import { creativeLanguageDocumentSchema } from "@/lib/creative-language/schema";
import { treatmentDocumentSchema } from "@/lib/treatment/schema";
import {
  completeAutomaticWizardStepInTransaction,
  ensureWizardProgress,
  saveManagedWizardStepInTransaction,
  WizardLockedError
} from "@/lib/wizard/service";
import { queuedSongPicturePlanGenerationSchema } from "./input";
import {
  EMPTY_SONG_PICTURE_PLAN,
  songPicturePlanCompletionIssues,
  songPicturePlanDocumentSchema,
  songPicturePlanDraftSchema,
  type SongPicturePlanDraft
} from "./schema";
import { projectEditorWhere } from "@/lib/collaboration/access";

export class SongPicturePlanError extends Error {}
export class SongPicturePlanConflictError extends SongPicturePlanError {}

type Tx=Prisma.TransactionClient;
function toJson(value:unknown):Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function latestLockedSource(tx:Tx,projectId:string){
  return tx.creativeLanguageVersion.findFirst({
    where:{
      creativeLanguage:{projectId},
      lifecycle:VersionLifecycle.LOCKED,
      sourceTreatmentVersion:{lifecycle:VersionLifecycle.LOCKED}
    },
    orderBy:{versionNumber:"desc"},
    include:{
      creativeLanguage:{include:{project:true}},
      sourceTreatmentVersion:{
        include:{
          sourceConceptSetVersion:{
            include:{
              sourceCreativeBriefVersion:{
                include:{
                  sourceMusicMapVersion:{
                    include:{
                      anchors:{
                        where:{decision:MusicMapAnchorDecision.ACCEPTED},
                        orderBy:[{startMs:"asc"},{position:"asc"}]
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  });
}

function sourceMusicMap(source:NonNullable<Awaited<ReturnType<typeof latestLockedSource>>>){
  return source.sourceTreatmentVersion.sourceConceptSetVersion.sourceCreativeBriefVersion.sourceMusicMapVersion;
}

function semanticFingerprint(input:{
  sourceTreatmentVersionId:string;
  sourceCreativeLanguageVersionId:string;
  sourceMusicMapVersionId:string;
  document:SongPicturePlanDraft;
}){
  return fingerprintJson(toJson(input) as unknown as Prisma.JsonValue);
}

async function refreshFingerprint(tx:Tx,id:string){
  const v=await tx.songPicturePlanVersion.findUniqueOrThrow({where:{id}});
  const document=songPicturePlanDraftSchema.parse(v.document);
  const fingerprint=semanticFingerprint({
    sourceTreatmentVersionId:v.sourceTreatmentVersionId,
    sourceCreativeLanguageVersionId:v.sourceCreativeLanguageVersionId,
    sourceMusicMapVersionId:v.sourceMusicMapVersionId,
    document
  });
  await tx.domainVersionNode.update({where:{id:v.nodeId},data:{fingerprint}});
  return {fingerprint,document,nodeId:v.nodeId};
}

async function wizardPayload(tx:Tx,id:string){
  const v=await tx.songPicturePlanVersion.findUniqueOrThrow({
    where:{id},
    include:{
      sourceTreatmentVersion:true,
      sourceCreativeLanguageVersion:true,
      sourceMusicMapVersion:true
    }
  });
  const document=songPicturePlanDraftSchema.parse(v.document);
  return toJson({
    songPicturePlanVersionId:v.id,
    songPicturePlanNodeId:v.nodeId,
    songPicturePlanRevision:v.revision,
    sourceTreatmentVersionId:v.sourceTreatmentVersionId,
    sourceTreatmentVersionNumber:v.sourceTreatmentVersion.versionNumber,
    sourceCreativeLanguageVersionId:v.sourceCreativeLanguageVersionId,
    sourceCreativeLanguageVersionNumber:v.sourceCreativeLanguageVersion.versionNumber,
    sourceMusicMapVersionId:v.sourceMusicMapVersionId,
    sourceMusicMapVersionNumber:v.sourceMusicMapVersion.versionNumber,
    passageCount:document.passages.length
  });
}

async function syncWizard(tx:Tx,projectVersionId:string,id:string){
  const refreshed=await refreshFingerprint(tx,id);
  const wizard=await saveManagedWizardStepInTransaction(tx,{
    projectVersionId,
    stepKey:"song-map",
    payload:await wizardPayload(tx,id),
    semanticFingerprint:refreshed.fingerprint
  });
  return {...refreshed,wizard};
}

async function serializePlan(tx:Tx,id:string){
  const v=await tx.songPicturePlanVersion.findUniqueOrThrow({
    where:{id},
    include:{
      sourceTreatmentVersion:true,
      sourceCreativeLanguageVersion:true,
      sourceMusicMapVersion:{
        include:{
          anchors:{
            where:{decision:MusicMapAnchorDecision.ACCEPTED},
            orderBy:[{startMs:"asc"},{position:"asc"}]
          }
        }
      }
    }
  });
  const treatment=treatmentDocumentSchema.parse(v.sourceTreatmentVersion.document);
  const language=creativeLanguageDocumentSchema.parse(v.sourceCreativeLanguageVersion.document);
  return {
    id:v.id,
    nodeId:v.nodeId,
    versionNumber:v.versionNumber,
    lifecycle:v.lifecycle,
    revision:v.revision,
    sourceTreatmentVersionId:v.sourceTreatmentVersionId,
    sourceTreatmentVersionNumber:v.sourceTreatmentVersion.versionNumber,
    sourceCreativeLanguageVersionId:v.sourceCreativeLanguageVersionId,
    sourceCreativeLanguageVersionNumber:v.sourceCreativeLanguageVersion.versionNumber,
    sourceMusicMapVersionId:v.sourceMusicMapVersionId,
    sourceMusicMapVersionNumber:v.sourceMusicMapVersion.versionNumber,
    document:songPicturePlanDraftSchema.parse(v.document),
    sourceContext:{
      treatmentTitle:treatment.title,
      treatmentSections:treatment.sections.map((section,index)=>({
        index,
        title:section.title,
        startMs:section.startMs,
        endMs:section.endMs
      })),
      creativeLanguageTitle:language.title,
      creativeLanguageIdea:language.governingIdea,
      musicMap:{
        durationMs:v.sourceMusicMapVersion.durationMs,
        tempoBpm:v.sourceMusicMapVersion.tempoBpm,
        meterNumerator:v.sourceMusicMapVersion.meterNumerator,
        meterDenominator:v.sourceMusicMapVersion.meterDenominator,
        anchors:v.sourceMusicMapVersion.anchors.map(a=>({
          id:a.id,kind:a.kind,label:a.label,startMs:a.startMs,endMs:a.endMs
        }))
      }
    },
    generationJobId:v.generationJobId,
    createdAt:v.createdAt,
    lockedAt:v.lockedAt
  };
}

async function mutationContext(tx:Tx,input:{
  userId:string;projectId:string;projectVersionId:string;songPicturePlanVersionId:string;expectedRevision:number;
}){
  const version=await tx.songPicturePlanVersion.findFirst({
    where:{
      id:input.songPicturePlanVersionId,
      songPicturePlan:{
        projectId:input.projectId,
        project:{...projectEditorWhere(input.userId)}
      }
    }
  });
  if(!version) throw new SongPicturePlanError("Song-to-Picture Plan version not found.");
  if(version.lifecycle!==VersionLifecycle.DRAFT) throw new WizardLockedError("This Song-to-Picture Plan version is locked.");
  if(version.revision!==input.expectedRevision) throw new SongPicturePlanConflictError("Song-to-Picture Plan changed in another request. Reload before continuing.");
  const progress=await tx.wizardProgress.findFirst({
    where:{projectVersionId:input.projectVersionId},
    include:{projectVersion:true,steps:true}
  });
  if(!progress||progress.projectVersion.projectId!==input.projectId) throw new SongPicturePlanError("Wizard progress not found.");
  if(progress.projectVersion.lifecycle!==VersionLifecycle.DRAFT) throw new WizardLockedError("This project version is locked.");
  const step=progress.steps.find(x=>x.stepKey==="song-map");
  if(!step) throw new SongPicturePlanError("Song-to-Picture wizard state is unavailable.");
  if(step.lockedAt) throw new WizardLockedError("Song-to-Picture Plan is locked.");
  return {version,progress,step};
}

async function activeJob(tx:Tx,nodeId:string){
  return tx.generationJob.findFirst({
    where:{kind:GenerationKind.TEXT,status:{in:[GenerationStatus.QUEUED,GenerationStatus.RUNNING]},inputs:{some:{nodeId,role:"song-picture-plan"}}},
    orderBy:{createdAt:"desc"}
  });
}

async function completionContext(tx:Tx,version:{sourceTreatmentVersionId:string;sourceMusicMapVersionId:string}){
  const [treatment,map]=await Promise.all([
    tx.treatmentVersion.findUniqueOrThrow({where:{id:version.sourceTreatmentVersionId}}),
    tx.musicMapVersion.findUniqueOrThrow({
      where:{id:version.sourceMusicMapVersionId},
      include:{anchors:{where:{decision:MusicMapAnchorDecision.ACCEPTED}}}
    })
  ]);
  return {
    durationMs:map.durationMs,
    treatmentSectionCount:treatmentDocumentSchema.parse(treatment.document).sections.length,
    acceptedAnchorIds:new Set(map.anchors.map(a=>a.id))
  };
}

export async function initializeSongPicturePlan(input:{userId:string;projectId:string}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const source=await latestLockedSource(tx,input.projectId);
    if(!source) throw new SongPicturePlanError("Complete and lock Treatment and Creative Language before starting the Song-to-Picture Plan.");
    const map=sourceMusicMap(source);
    if(map.lifecycle!==VersionLifecycle.LOCKED) throw new SongPicturePlanError("The Music Map used by the locked Treatment must also be locked.");
    treatmentDocumentSchema.parse(source.sourceTreatmentVersion.document);
    creativeLanguageDocumentSchema.parse(source.document);

    const logical=await tx.songPicturePlan.upsert({
      where:{projectId:input.projectId},
      create:{projectId:input.projectId},
      update:{}
    });
    const latest=await tx.songPicturePlanVersion.findFirst({where:{songPicturePlanId:logical.id},orderBy:{versionNumber:"desc"}});
    if(latest&&latest.lifecycle===VersionLifecycle.DRAFT&&latest.sourceTreatmentVersionId===source.sourceTreatmentVersionId&&latest.sourceCreativeLanguageVersionId===source.id&&latest.sourceMusicMapVersionId===map.id){
      await syncWizard(tx,projectVersion.id,latest.id);
      return serializePlan(tx,latest.id);
    }
    if(latest?.lifecycle===VersionLifecycle.DRAFT){
      await tx.songPicturePlanVersion.update({where:{id:latest.id},data:{lifecycle:VersionLifecycle.SUPERSEDED}});
    }
    const node=await tx.domainVersionNode.create({data:{kind:DomainVersionKind.SONG_PICTURE_PLAN}});
    const created=await tx.songPicturePlanVersion.create({
      data:{
        songPicturePlanId:logical.id,
        nodeId:node.id,
        versionNumber:(latest?.versionNumber??0)+1,
        sourceTreatmentVersionId:source.sourceTreatmentVersionId,
        sourceCreativeLanguageVersionId:source.id,
        sourceMusicMapVersionId:map.id,
        document:toJson(EMPTY_SONG_PICTURE_PLAN),
        createdByUserId:input.userId
      }
    });
    for(const dep of [
      {nodeId:source.sourceTreatmentVersion.nodeId,reason:"Song-to-Picture Plan maps this exact locked Treatment across the song."},
      {nodeId:source.nodeId,reason:"Song-to-Picture Plan applies this exact locked Creative Language."},
      {nodeId:map.nodeId,reason:"Song-to-Picture Plan uses this exact locked Music Map for timing and anchors."}
    ]){
      await registerDependencyEdgeInTransaction(tx,{upstreamNodeId:dep.nodeId,downstreamNodeId:node.id,relation:DependencyRelation.REFERENCES,reason:dep.reason});
    }
    await syncWizard(tx,projectVersion.id,created.id);
    return serializePlan(tx,created.id);
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function saveSongPicturePlan(input:{
  userId:string;projectId:string;songPicturePlanVersionId:string;expectedRevision:number;document:SongPicturePlanDraft;
}){
  const projectVersion=await ensureWizardProgress(input);
  const document=songPicturePlanDraftSchema.parse(input.document);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeJob(tx,context.version.nodeId)) throw new SongPicturePlanError("Wait for generation to finish before editing.");
    const changed=await tx.songPicturePlanVersion.updateMany({
      where:{id:context.version.id,revision:input.expectedRevision,lifecycle:VersionLifecycle.DRAFT},
      data:{document:toJson(document),revision:{increment:1}}
    });
    if(changed.count!==1) throw new SongPicturePlanConflictError("Song-to-Picture Plan changed while saving.");
    const synced=await syncWizard(tx,projectVersion.id,context.version.id);
    return {version:await serializePlan(tx,context.version.id),impactWarnings:synced.wizard.impactWarnings};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function queueSongPicturePlanGeneration(input:{
  userId:string;projectId:string;songPicturePlanVersionId:string;expectedRevision:number;direction:string;
}){
  const projectVersion=await ensureWizardProgress(input);
  const configured=getConfiguredTextProvider(getEnvironment());
  const context=await db.$transaction(async tx=>{
    const current=await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeJob(tx,current.version.nodeId)) throw new SongPicturePlanError("A Song-to-Picture generation job is already active.");
    const [treatment,language,map]=await Promise.all([
      tx.treatmentVersion.findUniqueOrThrow({where:{id:current.version.sourceTreatmentVersionId}}),
      tx.creativeLanguageVersion.findUniqueOrThrow({where:{id:current.version.sourceCreativeLanguageVersionId}}),
      tx.musicMapVersion.findUniqueOrThrow({where:{id:current.version.sourceMusicMapVersionId}})
    ]);
    return {nodeId:current.version.nodeId,treatment,language,map};
  });
  const request=queuedSongPicturePlanGenerationSchema.parse({
    textOperation:"song-picture-plan",
    projectId:input.projectId,
    projectVersionId:projectVersion.id,
    songPicturePlanVersionId:input.songPicturePlanVersionId,
    treatmentVersionId:context.treatment.id,
    creativeLanguageVersionId:context.language.id,
    musicMapVersionId:context.map.id,
    direction:input.direction
  });
  const project=await db.project.findUniqueOrThrow({where:{id:input.projectId},select:{workspaceId:true}});
  const job=await enqueueGenerationJob({
    workspaceId:project.workspaceId,
    projectId:input.projectId,
    kind:GenerationKind.TEXT,
    providerKey:configured.provider.key+":song-picture-plan",
    modelKey:configured.model,
    requestSnapshot:toJson(request),
    requestedByUserId:input.userId,
    inputs:[
      {nodeId:context.treatment.nodeId,role:"treatment"},
      {nodeId:context.language.nodeId,role:"creative-language"},
      {nodeId:context.map.nodeId,role:"music-map"},
      {nodeId:context.nodeId,role:"song-picture-plan"}
    ],
    prepare:async(tx,jobId)=>{
      await tx.songPicturePlanVersion.update({where:{id:input.songPicturePlanVersionId},data:{generationJobId:jobId}});
    }
  });
  return {jobId:job.id,status:job.status};
}

export async function persistSongPicturePlanGeneration(input:{
  generationJobId:string;songPicturePlanVersionId:string;treatmentVersionId:string;creativeLanguageVersionId:string;musicMapVersionId:string;document:unknown;
}){
  const document=songPicturePlanDocumentSchema.parse(input.document);
  return db.$transaction(async tx=>{
    const version=await tx.songPicturePlanVersion.findUniqueOrThrow({where:{id:input.songPicturePlanVersionId}});
    if(version.sourceTreatmentVersionId!==input.treatmentVersionId||version.sourceCreativeLanguageVersionId!==input.creativeLanguageVersionId||version.sourceMusicMapVersionId!==input.musicMapVersionId||version.generationJobId!==input.generationJobId||version.lifecycle!==VersionLifecycle.DRAFT){
      throw new SongPicturePlanError("Generated plan no longer matches its pinned sources.");
    }
    const issues=songPicturePlanCompletionIssues(document,await completionContext(tx,version));
    if(issues.length) throw new SongPicturePlanError(issues.join(" "));
    const existing=await tx.generationOutput.findFirst({where:{jobId:input.generationJobId,role:"song-picture-plan"}});
    if(existing) return {songPicturePlanVersionId:version.id,nodeId:version.nodeId};
    await tx.songPicturePlanVersion.update({where:{id:version.id},data:{document:toJson(document),revision:{increment:1}}});
    await tx.generationOutput.create({data:{jobId:input.generationJobId,nodeId:version.nodeId,role:"song-picture-plan"}});
    const job=await tx.generationJob.findUniqueOrThrow({where:{id:input.generationJobId}});
    const request=queuedSongPicturePlanGenerationSchema.parse(job.requestSnapshot);
    await syncWizard(tx,request.projectVersionId,version.id);
    return {songPicturePlanVersionId:version.id,nodeId:version.nodeId};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function completeSongPicturePlan(input:{
  userId:string;projectId:string;songPicturePlanVersionId:string;expectedRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(await activeJob(tx,context.version.nodeId)) throw new SongPicturePlanError("Wait for generation to finish before completing the plan.");
    const draft=songPicturePlanDraftSchema.parse(context.version.document);
    const issues=songPicturePlanCompletionIssues(draft,await completionContext(tx,context.version));
    if(issues.length) throw new SongPicturePlanError(issues.join(" "));
    const changed=await tx.songPicturePlanVersion.updateMany({
      where:{id:context.version.id,revision:input.expectedRevision},
      data:{revision:{increment:1}}
    });
    if(changed.count!==1) throw new SongPicturePlanConflictError("Song-to-Picture Plan changed while completing.");
    const refreshed=await refreshFingerprint(tx,context.version.id);
    const wizard=await completeAutomaticWizardStepInTransaction(tx,{
      projectVersionId:projectVersion.id,
      stepKey:"song-map",
      payload:await wizardPayload(tx,context.version.id),
      semanticFingerprint:refreshed.fingerprint
    });
    return {version:await serializePlan(tx,context.version.id),impactWarnings:wizard.impactWarnings};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function reopenSongPicturePlan(input:{
  userId:string;projectId:string;songPicturePlanVersionId:string;expectedRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(context.step.status!==WizardStepStatus.COMPLETED) return {version:await serializePlan(tx,context.version.id),impactWarnings:[]};
    await tx.wizardStepState.update({where:{id:context.step.id},data:{status:WizardStepStatus.IN_PROGRESS,completedAt:null,needsReviewAt:null,reviewReason:null}});
    await tx.wizardProgress.update({where:{id:context.progress.id},data:{revision:{increment:1},currentStepKey:"song-map"}});
    return {version:await serializePlan(tx,context.version.id),impactWarnings:[]};
  });
}

export async function lockSongPicturePlan(input:{
  userId:string;projectId:string;songPicturePlanVersionId:string;expectedRevision:number;
}){
  const projectVersion=await ensureWizardProgress(input);
  return db.$transaction(async tx=>{
    const context=await mutationContext(tx,{...input,projectVersionId:projectVersion.id});
    if(context.step.status!==WizardStepStatus.COMPLETED) throw new SongPicturePlanError("Complete the Song-to-Picture Plan before locking it.");
    const now=new Date();
    const changed=await tx.songPicturePlanVersion.updateMany({
      where:{id:context.version.id,revision:input.expectedRevision,lifecycle:VersionLifecycle.DRAFT},
      data:{lifecycle:VersionLifecycle.LOCKED,revision:{increment:1},lockedAt:now}
    });
    if(changed.count!==1) throw new SongPicturePlanConflictError("Song-to-Picture Plan changed while locking.");
    await tx.wizardStepState.update({where:{id:context.step.id},data:{lockedAt:now}});
    await tx.wizardProgress.update({where:{id:context.progress.id},data:{revision:{increment:1}}});
    await refreshFingerprint(tx,context.version.id);
    return {version:await serializePlan(tx,context.version.id),impactWarnings:[]};
  },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable});
}

export async function getSongPicturePlanState(input:{userId:string;projectId:string}){
  const project=await db.project.findFirst({
    where:{id:input.projectId,...projectEditorWhere(input.userId)},
    include:{
      treatment:{include:{versions:{orderBy:{versionNumber:"desc"},take:1,include:{sourceConceptSetVersion:{include:{sourceCreativeBriefVersion:true}}}}}},
      creativeLanguage:{include:{versions:{orderBy:{versionNumber:"desc"},take:1}}},
      musicMap:{include:{versions:{orderBy:{versionNumber:"desc"},take:1}}},
      songPicturePlan:{include:{versions:{orderBy:{versionNumber:"desc"},take:1}}}
    }
  });
  if(!project) throw new SongPicturePlanError("Project not found.");
  const treatment=project.treatment?.versions[0]??null;
  const language=project.creativeLanguage?.versions[0]??null;
  const map=project.musicMap?.versions[0]??null;
  const ref=project.songPicturePlan?.versions[0]??null;
  const latest=ref?await serializePlan(db,ref.id):null;
  const recentJob=ref?await db.generationJob.findFirst({
    where:{inputs:{some:{nodeId:ref.nodeId,role:"song-picture-plan"}}},
    orderBy:{createdAt:"desc"},
    select:{id:true,status:true,progressPercent:true,progressMessage:true,errorMessage:true}
  }):null;

  const chainMapId=treatment?.sourceConceptSetVersion.sourceCreativeBriefVersion.sourceMusicMapVersionId??null;
  const sourceReady=Boolean(
    treatment&&language&&map&&
    treatment.lifecycle===VersionLifecycle.LOCKED&&
    language.lifecycle===VersionLifecycle.LOCKED&&
    map.lifecycle===VersionLifecycle.LOCKED&&
    language.sourceTreatmentVersionId===treatment.id&&
    chainMapId===map.id
  );
  let providerAvailable=false;
  try{providerAvailable=textGenerationAvailable(getEnvironment());}catch{}
  return {
    latest,recentJob,providerAvailable,sourceReady,
    latestTreatmentVersionNumber:treatment?.versionNumber??null,
    latestCreativeLanguageVersionNumber:language?.versionNumber??null,
    latestMusicMapVersionNumber:map?.versionNumber??null,
    needsRebase:Boolean(latest&&sourceReady&&(
      latest.sourceTreatmentVersionId!==treatment!.id||
      latest.sourceCreativeLanguageVersionId!==language!.id||
      latest.sourceMusicMapVersionId!==map!.id
    ))
  };
}
