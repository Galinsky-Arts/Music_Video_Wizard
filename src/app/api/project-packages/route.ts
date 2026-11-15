import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { auth } from "@/lib/auth";
import { MAX_PACKAGE_BYTES } from "@/lib/project-package/manifest";
import { ProjectPackageError, restoreProjectPackage } from "@/lib/project-package/service";

export const runtime="nodejs";
export const dynamic="force-dynamic";

/** Restores an uploaded package (raw tar body) as a new project. */
export async function POST(request:Request){
  const session=await auth.api.getSession({headers:request.headers});
  if(!session) return Response.json({error:"Unauthorized"},{status:401});
  const declared=Number(request.headers.get("content-length")??"0");
  if(declared>MAX_PACKAGE_BYTES){
    return Response.json({error:"Project package is too large."},{status:413});
  }
  if(!request.body){
    return Response.json({error:"Upload a project package (.mvwpkg.tar)."},{status:400});
  }
  try{
    const report=await restoreProjectPackage({
      userId:session.user.id,
      displayName:session.user.name,
      body:Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>)
    });
    return Response.json(report,{status:201});
  }catch(error){
    if(error instanceof ProjectPackageError){
      return Response.json({error:error.message},{status:400});
    }
    console.error("Project package restore failed",error);
    return Response.json({error:"Project package restore failed."},{status:500});
  }
}
