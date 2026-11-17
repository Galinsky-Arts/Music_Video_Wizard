import { GenerationKind } from "@prisma/client";
import { generationHandlers } from "@/lib/jobs/registry";
import { handleDeliveryVariantRender, handleFinalMasterRender } from "./handler";

let registered=false;

export function registerFinalMasterRenderHandler(){
  if(registered) return;
  generationHandlers.register(
    GenerationKind.RENDER,
    "ffmpeg:finish-export",
    handleFinalMasterRender
  );
  generationHandlers.register(
    GenerationKind.RENDER,
    "ffmpeg:delivery-variant",
    handleDeliveryVariantRender
  );
  registered=true;
}
