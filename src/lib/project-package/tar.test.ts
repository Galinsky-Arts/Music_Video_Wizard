import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { extractTar, isSafeEntryName, tarEnd, tarHeader, tarPadding } from "./tar";
import { extensionForContentType, mediaEntryName, projectPackageManifestSchema } from "./manifest";

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});

function archive(files:Array<[string,Buffer]>){
  return Buffer.concat(files.flatMap(([name,body])=>[tarHeader(name,body.length),body,tarPadding(body.length)]).concat(tarEnd()));
}
function chunked(buffer:Buffer,size=97){
  const parts:Buffer[]=[];
  for(let i=0;i<buffer.length;i+=size) parts.push(buffer.subarray(i,i+size));
  return Readable.from(parts);
}
async function extract(buffer:Buffer,limits:Partial<{maxEntries:number;maxTotalBytes:number;maxEntryBytes:number}>={}){
  const directory=await mkdtemp(join(tmpdir(),"tar-test-"));
  directories.push(directory);
  return extractTar(chunked(buffer),{directory,maxEntries:10,maxTotalBytes:1e6,maxEntryBytes:1e6,...limits});
}

const media="media/0b6f8f4e-2a52-4c1c-9d7e-6a3c1b2f0d11.png";

describe("project package tar",()=>{
  it("round-trips entries across arbitrary chunk boundaries",async()=>{
    const png=Buffer.alloc(1300,7);
    const entries=await extract(archive([["manifest.json",Buffer.from("{}")],[media,png],["checksums.json",Buffer.from("{}")]]));
    expect(entries.map(entry=>[entry.name,entry.size])).toEqual([["manifest.json",2],[media,1300],["checksums.json",2]]);
    expect(await readFile(entries[1]!.path)).toEqual(png);
    expect(entries[1]!.path).toMatch(/entry-1$/);
  });

  it("only allows flat known entry names",()=>{
    for(const name of ["../etc/passwd","/abs","media/../x.png","media/x.png","media/"+"z".repeat(36)+".png","other.json"]){
      expect(isSafeEntryName(name)).toBe(false);
    }
    expect(isSafeEntryName(media)).toBe(true);
    expect(()=>tarHeader("../evil",1)).toThrow(/Unsafe/);
  });

  it("rejects unsafe, duplicate, oversized, corrupt and truncated archives",async()=>{
    const evil=tarHeader("manifest.json",1);
    evil.write("../../evil\0",0,"utf8");
    let sum=0;evil.fill(" ",148,156);for(const b of evil)sum+=b;evil.write(sum.toString(8).padStart(6,"0")+"\0 ",148,8,"ascii");
    await expect(extract(Buffer.concat([evil,Buffer.alloc(512),tarEnd()]))).rejects.toThrow(/unsafe/);
    await expect(extract(archive([["manifest.json",Buffer.from("a")],["manifest.json",Buffer.from("b")]]))).rejects.toThrow(/duplicate/);
    await expect(extract(archive([[media,Buffer.alloc(600)]]),{maxEntryBytes:500})).rejects.toThrow(/size limit/);
    await expect(extract(archive([[media,Buffer.alloc(400)],["manifest.json",Buffer.alloc(400)]]),{maxTotalBytes:500})).rejects.toThrow(/total size/);
    await expect(extract(archive([["manifest.json",Buffer.from("{}")]]),{maxEntries:0})).rejects.toThrow(/too many/);
    const corrupt=archive([["manifest.json",Buffer.from("{}")]]);corrupt[0]=0x41;
    await expect(extract(corrupt)).rejects.toThrow(/checksum/);
    const full=archive([[media,Buffer.alloc(1300)]]);
    await expect(extract(full.subarray(0,900))).rejects.toThrow(/truncated/);
  });
});

describe("project package manifest",()=>{
  it("maps content types to stable media entry names",()=>{
    expect(extensionForContentType("image/png")).toBe("png");
    expect(extensionForContentType("video/mp4; codecs=avc1")).toBe("mp4");
    expect(extensionForContentType("text/html")).toBe("bin");
    expect(mediaEntryName("0b6f8f4e-2a52-4c1c-9d7e-6a3c1b2f0d11","image/png")).toBe(media);
  });

  it("rejects manifests from other formats",()=>{
    expect(projectPackageManifestSchema.safeParse({format:"other"}).success).toBe(false);
  });
});
