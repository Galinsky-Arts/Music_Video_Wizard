import type { AppEnvironment } from "@/lib/env";
import { OpenAIImageAdapter } from "./openai-images";
import { ComfyUIVideoAdapter } from "./comfyui-video";
import { RunwayVideoAdapter } from "./runway-video";
import type { MediaGenerationAdapter } from "./types";

export function getConfiguredMediaGenerationAdapters(
  env:AppEnvironment
):MediaGenerationAdapter[]{
  const adapters:MediaGenerationAdapter[]=[];

  if(env.IMAGE_GENERATION_PROVIDER==="openai"){
    if(!env.OPENAI_API_KEY){
      throw new Error("OpenAI image generation requires OPENAI_API_KEY.");
    }
    adapters.push(
      new OpenAIImageAdapter(env.OPENAI_API_KEY,env.OPENAI_BASE_URL)
    );
  }

  if(env.VIDEO_GENERATION_PROVIDER==="runway"){
    if(!env.RUNWAY_API_SECRET){
      throw new Error("Runway video generation requires RUNWAY_API_SECRET.");
    }
    adapters.push(
      new RunwayVideoAdapter(
        env.RUNWAY_API_SECRET,
        env.RUNWAY_BASE_URL,
        env.RUNWAY_API_VERSION
      )
    );
  }

  if (env.VIDEO_GENERATION_PROVIDER === "comfyui") {
    if (!env.COMFYUI_BASE_URL || !env.COMFYUI_WORKFLOW_PATH) throw new Error("ComfyUI requires a GPU endpoint and API workflow path.");
    adapters.push(new ComfyUIVideoAdapter(env.COMFYUI_BASE_URL, env.COMFYUI_WORKFLOW_PATH, env.COMFYUI_API_KEY));
  }

  return adapters;
}
