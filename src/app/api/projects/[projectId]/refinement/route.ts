import { ZodError } from "zod";
import { auth } from "@/lib/auth";
import { refinementActionSchema } from "@/lib/refinement/input";
import {
  completeRefinement,
  getRefinementState,
  initializeRefinement,
  lockRefinement,
  RefinementConflictError,
  RefinementError,
  replaceRefinementClip,
  retimeRefinementBoundary,
  updateRefinementFraming,
  updateRefinementOverlays,
  updateRefinementTransition
} from "@/lib/refinement/service";
import { WizardError,WizardLockedError } from "@/lib/wizard/service";

export const runtime="nodejs";

function handled(error:unknown){
  if(error instanceof RefinementConflictError){
    return Response.json({error:error.message},{status:409});
  }
  if(
    error instanceof ZodError||
    error instanceof RefinementError||
    error instanceof WizardError||
    error instanceof WizardLockedError
  ){
    return Response.json({
      error:error instanceof ZodError
        ?error.issues.map(issue=>issue.message).join(" ")
        :error.message
    },{status:400});
  }
  console.error("Refinement request failed",error);
  return Response.json(
    {error:"Refinement request failed."},
    {status:500}
  );
}

export async function GET(
  request:Request,
  context:{params:Promise<{projectId:string}>}
){
  const session=await auth.api.getSession({headers:request.headers});
  if(!session) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const {projectId}=await context.params;
    return Response.json(await getRefinementState({
      userId:session.user.id,
      projectId
    }));
  }catch(error){
    return handled(error);
  }
}

export async function POST(
  request:Request,
  context:{params:Promise<{projectId:string}>}
){
  const session=await auth.api.getSession({headers:request.headers});
  if(!session) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const {projectId}=await context.params;
    const body=refinementActionSchema.parse(await request.json());
    const base={
      userId:session.user.id,
      projectId,
      expectedWizardRevision:body.expectedWizardRevision
    };

    if(body.action==="initialize"){
      return Response.json(await initializeRefinement(base));
    }
    if(body.action==="retime"){
      return Response.json(await retimeRefinementBoundary({
        ...base,
        expectedTimelineVersionId:body.expectedTimelineVersionId,
        boundaryPosition:body.boundaryPosition,
        timelineMs:body.timelineMs
      }));
    }
    if(body.action==="replace-clip"){
      return Response.json(await replaceRefinementClip({
        ...base,
        expectedTimelineVersionId:body.expectedTimelineVersionId,
        position:body.position,
        assetVersionId:body.assetVersionId
      }));
    }
    if(body.action==="transition"){
      return Response.json(await updateRefinementTransition({
        ...base,
        expectedTimelineVersionId:body.expectedTimelineVersionId,
        fromPosition:body.fromPosition,
        kind:body.kind,
        durationMs:body.durationMs,
        note:body.note
      }));
    }
    if(body.action==="framing"){
      return Response.json(await updateRefinementFraming({
        ...base,
        expectedTimelineVersionId:body.expectedTimelineVersionId,
        position:body.position,
        framing:body.framing
      }));
    }
    if(body.action==="overlays"){
      return Response.json(await updateRefinementOverlays({
        ...base,
        expectedTimelineVersionId:body.expectedTimelineVersionId,
        kind:body.kind,
        overlays:body.overlays
      }));
    }
    if(body.action==="complete"){
      return Response.json(await completeRefinement({
        ...base,
        expectedTimelineVersionId:body.expectedTimelineVersionId
      }));
    }
    return Response.json(await lockRefinement({
      ...base,
      expectedTimelineVersionId:body.expectedTimelineVersionId
    }));
  }catch(error){
    return handled(error);
  }
}
