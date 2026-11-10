import { GenerationKind } from "@prisma/client";
import { generationHandlers } from "@/lib/jobs/registry";
import { handleVideoClipGeneration } from "./handler";

let registered=false;

export function registerVideoClipGenerationHandlers(){
  if(registered) return;
  generationHandlers.register(
    GenerationKind.VIDEO,
    "runway:video-clip",
    handleVideoClipGeneration
  );
  generationHandlers.register(GenerationKind.VIDEO, "comfyui:video-clip", handleVideoClipGeneration);
  registered=true;
}
