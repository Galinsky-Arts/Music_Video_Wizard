import { afterEach,describe,expect,it,vi } from "vitest";
import { StabilityImageAdapter,getStabilityCreditBalance } from "./stability-images";
import { getConfiguredMediaGenerationAdapters } from "./factory";
import { getEnvironment } from "@/lib/env";
import type { CompiledGenerationRequest } from "@/lib/prompt-compiler/schema";
const request = { mediaKind:"IMAGE",aspectRatio:"16:9",prompt:"Kirk and Spock study a crystalline signal.",negativeConstraints:["No additional characters"] } as CompiledGenerationRequest;
// A real one-pixel PNG is a transport fixture, not evidence of live inference.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXtEAAAAASUVORK5CYII=","base64");
afterEach(()=>vi.restoreAllMocks());
describe("Stability image integration",()=>{
  it("submits multipart Core generation and keeps credentials out of snapshots",async()=>{
    const fetch = vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(png,{headers:{"content-type":"image/png",seed:"42","finish-reason":"SUCCESS"}}));
    const a = new StabilityImageAdapter("private-key"), model=(await a.listModels())[0]!;
    const result=await a.submit({model,request});
    expect(fetch.mock.calls[0]![0]).toBe("https://api.stability.ai/v2beta/stable-image/generate/core");
    const options=fetch.mock.calls[0]![1]!, form=options.body as FormData;
    expect(options.headers).toMatchObject({authorization:"Bearer private-key",accept:"image/*"});
    expect(options.redirect).toBe("error");
    expect(form.get("prompt")).toBe(request.prompt);expect(form.get("aspect_ratio")).toBe("16:9");
    expect(form.get("negative_prompt")).toBe("No additional characters");expect(form.get("output_format")).toBe("png");
    expect(result.immediateResult).toMatchObject({status:"SUCCEEDED",outputs:[{contentType:"image/png",base64:png.toString("base64")}],providerSnapshot:{seed:"42",width:1,height:1}});
    expect(JSON.stringify(result)).not.toContain("private-key");
    expect(model.capabilities.imageToVideo).toBe(false);
  });
  it("rejects video, unsupported ratios and too-long prompts before spending credits",async()=>{
    const fetch=vi.spyOn(globalThis,"fetch"),a=new StabilityImageAdapter("key"),model=(await a.listModels())[0]!;
    await expect(a.submit({model,request:{...request,mediaKind:"VIDEO"}})).rejects.toThrow(/image requests only/);
    await expect(a.submit({model,request:{...request,aspectRatio:"4:3"}})).rejects.toThrow(/aspect ratio/);
    await expect(a.submit({model,request:{...request,prompt:"x".repeat(10001)}})).rejects.toThrow(/10,000/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not accept filtered or malformed output as a generated keyframe",async()=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(new Response(png,{headers:{"finish-reason":"CONTENT_FILTERED"}})).mockResolvedValueOnce(new Response("not an image"));
    const a=new StabilityImageAdapter("key"),model=(await a.listModels())[0]!;
    await expect(a.submit({model,request})).rejects.toThrow(/filtered/);
    await expect(a.submit({model,request})).rejects.toThrow(/usable PNG/);
  });
  it("bounds returned image bytes",async()=>{
    vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(png,{headers:{"content-length":String(21*1024*1024)}}));
    const a=new StabilityImageAdapter("key");await expect(a.submit({model:(await a.listModels())[0]!,request})).rejects.toThrow(/oversized/);
  });
  it("checks credit balance using GET without any generation request",async()=>{
    const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({credits:123.5})));
    expect(await getStabilityCreditBalance("key")).toEqual({credits:123.5});
    expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]![0]).toBe("https://api.stability.ai/v1/user/balance");expect(fetch.mock.calls[0]![1]?.method).toBe("GET");
  });
  it("classifies invalid keys and insufficient credits as permanent, rate limits as retryable",async()=>{
    const fetch=vi.spyOn(globalThis,"fetch");
    for(const status of [401,402,429]) {fetch.mockResolvedValueOnce(new Response("secret provider text",{status}));await expect(getStabilityCreditBalance("key")).rejects.toMatchObject({status,permanent:status!==429});}
  });
  it("does not enable paid generation just because a key was saved",()=>{
    const base={NODE_ENV:"test" as const,DATABASE_URL:"postgresql://localhost/test",BETTER_AUTH_SECRET:"0123456789abcdef0123456789abcdef",BETTER_AUTH_URL:"http://localhost:3000",ASSET_STORAGE_BUCKET:"test",STABILITY_API_KEY:"key"};
    expect(getConfiguredMediaGenerationAdapters(getEnvironment(base))).toHaveLength(0);
    expect(getConfiguredMediaGenerationAdapters(getEnvironment({...base,IMAGE_GENERATION_PROVIDER:"stability"})).map(a=>a.providerId)).toEqual(["stability-images"]);
    expect(()=>getEnvironment({...base,IMAGE_GENERATION_PROVIDER:"stability",STABILITY_API_KEY:""})).toThrow(/STABILITY_API_KEY/);
  });
});
