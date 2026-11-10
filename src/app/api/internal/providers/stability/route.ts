import { timingSafeEqual } from "node:crypto";
import { getEnvironment } from "@/lib/env";
import { getStabilityCreditBalance } from "@/lib/media-generation/stability-images";
import { MediaProviderError } from "@/lib/media-generation/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Operator-only, read-only probe. It cannot generate media or change provider settings. */
export async function POST(request: Request) {
  const env = getEnvironment(), expected = env.JOB_DRAIN_SECRET, provided = request.headers.get("x-job-drain-secret");
  if (!expected || !provided || Buffer.byteLength(expected) !== Buffer.byteLength(provided) || !timingSafeEqual(Buffer.from(expected),Buffer.from(provided))) return Response.json({error:"Unauthorized"},{status:401});
  const headers = { "cache-control": "no-store" };
  if (!env.STABILITY_API_KEY) return Response.json({configured:false,authenticated:false,generationEnabled:env.IMAGE_GENERATION_PROVIDER === "stability",videoApiAvailable:false},{headers});
  try {
    const balance = await getStabilityCreditBalance(env.STABILITY_API_KEY);
    return Response.json({configured:true,authenticated:true,credits:balance.credits,generationEnabled:env.IMAGE_GENERATION_PROVIDER === "stability",videoApiAvailable:false},{headers});
  } catch (error) {
    return Response.json({configured:true,authenticated:false,providerStatus:error instanceof MediaProviderError?error.status??null:null,error:"Stability account verification failed. No generation was requested."},{status:502,headers});
  }
}
