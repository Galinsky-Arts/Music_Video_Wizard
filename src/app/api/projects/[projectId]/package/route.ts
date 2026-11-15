import { Readable } from "node:stream";
import { auth } from "@/lib/auth";
import {
  prepareProjectPackage,
  ProjectPackageError,
  projectPackageStream
} from "@/lib/project-package/service";

export const runtime="nodejs";
export const dynamic="force-dynamic";

/** Streams a portable project package (manifest + media + checksums) as tar. */
export async function GET(
  request:Request,
  context:{params:Promise<{projectId:string}>}
){
  const session=await auth.api.getSession({headers:request.headers});
  if(!session) return Response.json({error:"Unauthorized"},{status:401});
  try{
    const {projectId}=await context.params;
    const prepared=await prepareProjectPackage({userId:session.user.id,projectId});
    const stream=Readable.toWeb(projectPackageStream(prepared)) as ReadableStream<Uint8Array>;
    return new Response(stream,{headers:{
      "content-type":"application/x-tar",
      "content-disposition":"attachment; filename=\""+prepared.fileName+"\"",
      "cache-control":"no-store",
      "x-missing-media-count":String(prepared.manifest.missingMedia.length)
    }});
  }catch(error){
    if(error instanceof ProjectPackageError){
      return Response.json({error:error.message},{status:404});
    }
    console.error("Project package export failed",error);
    return Response.json({error:"Project package export failed."},{status:500});
  }
}
