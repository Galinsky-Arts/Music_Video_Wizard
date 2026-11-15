import { auth } from "@/lib/auth";
import { getWorkspaceUsage } from "@/lib/ops/usage-service";

export const runtime="nodejs";
export const dynamic="force-dynamic";

export async function GET(request:Request){
  const session=await auth.api.getSession({headers:request.headers});
  if(!session) return Response.json({error:"Unauthorized"},{status:401});
  try{
    return Response.json(
      await getWorkspaceUsage({userId:session.user.id,displayName:session.user.name}),
      {headers:{"Cache-Control":"no-store"}}
    );
  }catch(error){
    console.error("Usage report failed",error);
    return Response.json({error:"Usage report failed."},{status:500});
  }
}
