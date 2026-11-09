import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile,unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { db } from "../src/lib/db";
import { getEnvironment } from "../src/lib/env";
import { createAssetStorage } from "../src/lib/storage";

function run(command:string,args:string[]){
  return new Promise<{stdout:string;stderr:string}>((resolve,reject)=>{
    const child=spawn(command,args,{
      stdio:["ignore","pipe","pipe"],
      env:process.env
    });
    let stdout="";
    let stderr="";
    child.stdout.on("data",chunk=>{stdout+=String(chunk);});
    child.stderr.on("data",chunk=>{stderr+=String(chunk);});
    child.on("error",reject);
    child.on("close",code=>{
      if(code===0) resolve({stdout,stderr});
      else reject(new Error(
        command+" exited with code "+code+
        (stderr?"\n"+stderr.slice(-3000):"")
      ));
    });
  });
}

async function assertDatabase(){
  const result=await db.$queryRaw<Array<{value:number}>>`
    SELECT 1::int AS value
  `;
  assert.equal(result[0]?.value,1,"PostgreSQL preflight query failed.");
  console.log("database: ok");
}

async function assertStorage(){
  const env=getEnvironment();
  assert.equal(
    env.ASSET_STORAGE_DRIVER,
    "s3",
    "Production preflight requires shared S3-compatible asset storage."
  );

  const storage=createAssetStorage(env);
  const marker="music-video-wizard-preflight-"+randomUUID();
  const bytes=new TextEncoder().encode(marker);
  const key=[
    "preflight",
    new Date().toISOString().slice(0,10),
    randomUUID()+".txt"
  ].join("/");
  const temp=join(tmpdir(),"music-video-wizard-preflight-"+randomUUID());

  try{
    const stored=await storage.put({
      key,
      body:bytes,
      contentType:"text/plain"
    });
    assert.equal(stored.key,key);
    assert.equal(
      await storage.exists(key),
      true,
      "Storage write was not visible after upload."
    );
    await storage.downloadToFile(key,temp);
    const downloaded=await readFile(temp,"utf8");
    assert.equal(downloaded,marker,"Storage round-trip bytes changed.");
    const signed=await storage.getSignedReadUrl(key,60);
    assert.match(
      signed,
      /^https?:\/\//,
      "Storage did not produce a signed HTTP(S) read URL."
    );
    console.log("object storage: ok");
  }finally{
    await unlink(temp).catch(()=>undefined);
    await storage.delete(key).catch(()=>undefined);
  }
}

async function assertRuntime(){
  const env=getEnvironment();

  const ffmpeg=await run(env.AUDIO_ANALYSIS_FFMPEG,["-version"]);
  assert.match(ffmpeg.stdout,/ffmpeg version/i);
  const renderFfmpeg=await run(env.VIDEO_RENDER_FFMPEG,["-version"]);
  assert.match(renderFfmpeg.stdout,/ffmpeg version/i);
  const ffprobe=await run(env.VIDEO_RENDER_FFPROBE,["-version"]);
  assert.match(ffprobe.stdout,/ffprobe version/i);
  console.log("ffmpeg and ffprobe: ok");

  const python=await run(env.AUDIO_ANALYSIS_PYTHON,[
    "-c",
    [
      "import numpy",
      "import scipy",
      "import librosa",
      "print('analysis-runtime-ok')"
    ].join(";")
  ]);
  assert.match(python.stdout,/analysis-runtime-ok/);
  console.log("python analysis runtime: ok");
}

function assertProductionConfiguration(){
  const env=getEnvironment();

  assert.equal(
    env.NODE_ENV,
    "production",
    "Production preflight must run with NODE_ENV=production."
  );
  assert.match(
    env.BETTER_AUTH_URL,
    /^https:\/\//,
    "BETTER_AUTH_URL must use HTTPS in production."
  );
  assert.equal(
    env.TEXT_GENERATION_PROVIDER,
    "openai",
    "Production text generation provider is not enabled."
  );
  assert.equal(
    env.IMAGE_GENERATION_PROVIDER,
    "openai",
    "Production image generation provider is not enabled."
  );
  assert.equal(
    env.VIDEO_GENERATION_PROVIDER,
    "runway",
    "Production video generation provider is not enabled."
  );
  assert.ok(env.OPENAI_API_KEY,"OPENAI_API_KEY is required.");
  assert.ok(env.RUNWAY_API_SECRET,"RUNWAY_API_SECRET is required.");

  console.log("production configuration: ok");
}

async function main(){
  try{
    assertProductionConfiguration();
    await assertDatabase();
    await assertStorage();
    await assertRuntime();
    console.log("Production preflight passed.");
  }finally{
    await db.$disconnect();
  }
}

main().catch(error=>{
  console.error("Production preflight failed.");
  console.error(error);
  process.exit(1);
});
