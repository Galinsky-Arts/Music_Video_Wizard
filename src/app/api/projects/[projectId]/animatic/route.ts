import { z, ZodError } from "zod";
import { auth } from "@/lib/auth";
import {
  AnimaticConflictError,
  AnimaticError,
  completeAnimaticReview,
  getAnimaticState
} from "@/lib/animatic/service";
import { WizardError, WizardLockedError } from "@/lib/wizard/service";

export const runtime="nodejs";

const actionSchema=z.object({
  action:z.literal("complete"),
  expectedWizardRevision:z.number().int().min(0)
});

function handled(error:unknown){
  if(error instanceof AnimaticConflictError){
    return Response.json({error:error.message},{status:409});
  }
  if(
    error instanceof ZodError||
    error instanceof AnimaticError||
    error instanceof WizardError||
    error instanceof WizardLockedError
  ){
    return Response.json({
      error:error instanceof ZodError
        ?error.issues.map(issue=>issue.message).join(" ")
        :error.message
    },{status:400});
  }
  console.error("Animatic request failed",error);
  return Response.json({error:"Animatic request failed."},{status:500});
}

export async function GET(
  request:Request,
  context:{params:Promise<{projectId:string}>}
){
  const session=await auth.api.getSession({headers:request.headers});
  if(!session) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const {projectId}=await context.params;
    return Response.json(
      await getAnimaticState({userId:session.user.id,projectId}),
      {headers:{"Cache-Control":"no-store"}}
    );
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
    const body=actionSchema.parse(await request.json());
    return Response.json(await completeAnimaticReview({
      userId:session.user.id,
      projectId,
      expectedWizardRevision:body.expectedWizardRevision
    }));
  }catch(error){
    return handled(error);
  }
}
