import { GenerationKind } from "@prisma/client";
import { generationHandlers } from "@/lib/jobs/registry";
import { handleInitialFrameGeneration } from "./handler";

let registered=false;

export function registerInitialFrameGenerationHandlers(){
  if(registered) return;
  generationHandlers.register(
    GenerationKind.IMAGE,
    "openai-images:initial-frame",
    handleInitialFrameGeneration
  );
  generationHandlers.register(GenerationKind.IMAGE, "stability-images:initial-frame", handleInitialFrameGeneration);
  registered=true;
}
