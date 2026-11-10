#!/usr/bin/env python3
"""Generate the narrative locally on an Apple GPU, then assemble the original song."""
import argparse
import fcntl
import re
import hashlib
import json
import math
import shutil
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
BASE="http://127.0.0.1:8288"
ROOT=Path(__file__).resolve().parent

def frame_count(shot, fps=24):
    # Round absolute boundaries, not each duration, so 35 cuts cannot accumulate drift.
    return round(shot["endMs"]*fps/1000)-round(shot["startMs"]*fps/1000)

def validate_plan(plan):
    if plan.get("schemaVersion")!=1 or not isinstance(plan.get("shots"),list) or not 1<=len(plan["shots"])<=160:
        raise ValueError("Invalid narrative plan")
    if type(plan.get("durationMs")) is not int or not 1000<=plan["durationMs"]<=600000:
        raise ValueError("Invalid soundtrack duration")
    end=0
    ids=set()
    for shot in plan["shots"]:
        if not isinstance(shot.get("id"),str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,40}",shot["id"]) or type(shot.get("startMs")) is not int or type(shot.get("endMs")) is not int:
            raise ValueError("Invalid shot identifier or timing")
        if shot["id"] in ids or shot["startMs"]!=end or not 0<shot["endMs"]-end<=10000 or not isinstance(shot.get("prompt"),str) or not 0<len(shot["prompt"])<=16000:
            raise ValueError("Shots must be unique, contiguous, and at most ten seconds long")
        ids.add(shot["id"]);end=shot["endMs"]
        if frame_count(shot)<=0:
            raise ValueError("Empty shot")
    if end!=plan.get("durationMs"):
        raise ValueError("The story does not cover its soundtrack")
    return plan

def fingerprint(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":")).encode()).hexdigest()

def file_hash(path):
    with open(path,"rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()

def save_json(path,data):
    temp=path.with_suffix(".tmp")
    temp.write_text(json.dumps(data,indent=2));temp.replace(path)

def api(path,data=None):
    request=urllib.request.Request(BASE+path,data=json.dumps(data).encode() if data is not None else None,
        headers={"Content-Type":"application/json"} if data is not None else {},method="POST" if data is not None else "GET")
    with urllib.request.urlopen(request,timeout=60) as response:
        return json.load(response)

def original_duration(ffmpeg,path):
    process=subprocess.Popen([str(ffmpeg),"-nostdin","-v","error","-i",str(path),"-map","0:a:0","-ac","1","-ar","48000","-f","f32le","pipe:1"],stdout=subprocess.PIPE)
    total=0
    while True:
        chunk=process.stdout.read(1024*1024)
        if not chunk:break
        total+=len(chunk)
    if process.wait()!=0:raise RuntimeError("The selected original song could not be decoded")
    return round(total/4/48000*1000)

def inspect_video(path,required_frames=None):
    import av
    with av.open(str(path)) as container:
        videos=container.streams.video
        if len(videos)!=1:raise RuntimeError("Expected one video stream")
        stream=videos[0];fps=float(stream.average_rate)
        if abs(fps-24)>0.001:raise RuntimeError("Unexpected generated frame rate")
        count=0
        for frame in container.decode(stream):count+=1
        if not count or (required_frames is not None and count<required_frames):raise RuntimeError("Generated clip is incomplete")
        return {"frames":count,"fps":fps,"width":stream.codec_context.width,"height":stream.codec_context.height}

def graph_for(shot):
    frames=math.ceil((frame_count(shot)-1)/8)*8+1
    return {
        "1":{"class_type":"LTX2MLXModelLoader","inputs":{"model_dir":"dgrauet/ltx-2.3-mlx-q4","pipeline_type":"distilled","low_ram":False,"custom_model_dir":""}},
        "3":{"class_type":"LTX2MLXGenerate","inputs":{"pipeline":["1",0],"prompt":shot["prompt"],"width":1024,"height":576,"num_frames":frames,"seed":42,"cfg_scale":3.0,"frame_rate":24.0,"filename_prefix":"music-video-wizard/story"}}
    }

def wait_video(prompt_id):
    started=time.monotonic();missing=0
    while time.monotonic()-started<7200:
        task=api("/history/"+prompt_id).get(prompt_id)
        if task and task.get("status",{}).get("status_str")=="error":raise RuntimeError("ComfyUI failed this shot. Inspect logs/comfyui.log before retrying")
        if task and task.get("status",{}).get("completed"):
            files=task.get("outputs",{}).get("3",{}).get("images",[])
            video=next((v for v in files if v.get("filename","").endswith(".mp4")),None)
            if not video:raise RuntimeError("ComfyUI completed without an MP4")
            output=(ROOT/"ComfyUI"/"output").resolve()
            result=(output/video.get("subfolder","")/video["filename"]).resolve()
            if not result.is_relative_to(output) or not result.is_file():raise RuntimeError("Invalid generated output path")
            return result
        if not task:
            queue=api("/queue")
            active=any(item[1]==prompt_id for name in ("queue_running","queue_pending") for item in queue.get(name,[]) if len(item)>1)
            missing=0 if active else missing+1
            if missing>=3:raise RuntimeError("The saved task is absent from this ComfyUI server. Use --retry-missing only if the old worker has stopped")
        print("Waiting for local GPU…",flush=True);time.sleep(15)
    raise RuntimeError("Local generation timed out; inspect the log before retrying")

def assemble(ffmpeg,plan,clips,audio,directory):
    args=[str(ffmpeg),"-nostdin","-v","error"]
    filters=[]
    for i,(shot,path) in enumerate(zip(plan["shots"],clips)):
        args += ["-threads","1","-i",str(path)]
        filters.append(f"[{i}:v]trim=start_frame=0:end_frame={frame_count(shot)},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=24,format=yuv420p[v{i}]")
    filters.append("".join(f"[v{i}]" for i in range(len(clips)))+f"concat=n={len(clips)}:v=1:a=0[out]")
    visual=directory/"Controlled_Chaos_Visual_Edit.mp4"
    args += ["-filter_complex_threads","1","-filter_complex",";".join(filters),"-map","[out]","-an","-c:v","libx264","-threads","4","-preset","veryfast","-b:v","1200k","-maxrate","1600k","-bufsize","3200k","-movflags","+faststart","-y",str(visual)]
    subprocess.run(args,check=True)
    expected=round(plan["durationMs"]*24/1000)
    measured=inspect_video(visual,expected)
    if measured["frames"]!=expected or (measured["width"],measured["height"])!=(1280,720):raise RuntimeError("Assembly does not match the complete frame plan")
    movie=directory/"Controlled_Chaos_Music_Video.mp4"
    subprocess.run([str(ffmpeg),"-nostdin","-v","error","-i",str(visual),"-i",str(audio),"-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","aac","-b:a","320k","-t",str(plan["durationMs"]/1000),"-movflags","+faststart","-y",str(movie)],check=True)
    subprocess.run([str(ffmpeg),"-nostdin","-v","error","-xerror","-i",str(movie),"-f","null","-"],check=True)
    return visual,movie

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--story",default=str(ROOT/"story.json"))
    parser.add_argument("--audio",help="Original finished song; a file chooser opens if omitted")
    parser.add_argument("--limit",type=int,help="Generate only this many missing shots as a preview")
    parser.add_argument("--production-name",default="controlled-chaos",help="A new name preserves earlier takes when changing the story")
    parser.add_argument("--retry-failed",action="store_true",help="Explicitly retry failed tasks after fixing the local worker")
    parser.add_argument("--retry-missing",action="store_true",help="Explicitly retry tasks lost after a worker restart")
    args=parser.parse_args()
    if Path(args.story).stat().st_size>256*1024:raise ValueError("Story file exceeds 256 KB")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}",args.production_name):raise ValueError("Invalid production folder name")
    plan=validate_plan(json.loads(Path(args.story).read_text()))
    audio=args.audio
    if not audio:
        audio=subprocess.check_output(["/usr/bin/osascript","-e",'POSIX path of (choose file with prompt "Choose the original Controlled Chaos audio file")'],text=True).strip()
    audio=Path(audio).expanduser().resolve()
    if not audio.is_file():raise RuntimeError("Original song not found")
    ffmpeg=ROOT/"venv"/"bin"/"ffmpeg"
    duration=original_duration(ffmpeg,audio)
    if abs(duration-plan["durationMs"])>20:raise RuntimeError("The selected song does not match this timed story. Choose the original Controlled Chaos master")
    directory=ROOT/"productions"/args.production_name;directory.mkdir(parents=True,exist_ok=True)
    lock=(directory/".run.lock").open("w")
    try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:raise RuntimeError("This local production is already running")
    manifest_path=directory/"manifest.json"
    identity={"planSha256":fingerprint(plan),"audioSha256":file_hash(audio)}
    manifest=json.loads(manifest_path.read_text()) if manifest_path.exists() else {**identity,"model":"dgrauet/ltx-2.3-mlx-q4","origin":"LOCAL_MLX_AI","shots":{}}
    if any(manifest.get(k)!=v for k,v in identity.items()):raise RuntimeError("This production contains a different story or audio master; choose a new --production-name")
    save_json(manifest_path,manifest)
    generated=0;clips=[]
    for shot in plan["shots"]:
        record=manifest["shots"].get(shot["id"],{})
        target=directory/(shot["id"]+".mp4")
        if target.is_file() and record.get("sha256")==file_hash(target):
            inspect_video(target,frame_count(shot));clips.append(target);continue
        if args.limit is not None and generated>=args.limit:
            print("Preview limit reached. Rerun without --limit to continue the same production.",flush=True);return
        prompt_id=record.get("promptId")
        if prompt_id and args.retry_failed:
            old=api("/history/"+prompt_id).get(prompt_id)
            if old and old.get("status",{}).get("status_str")=="error":prompt_id=None
        if prompt_id and args.retry_missing:
            queue=api("/queue")
            if not api("/history/"+prompt_id).get(prompt_id) and not any(item[1]==prompt_id for key in ("queue_running","queue_pending") for item in queue.get(key,[]) if len(item)>1):prompt_id=None
        if not prompt_id:
            submitted=api("/prompt",{"prompt":graph_for(shot)})
            if submitted.get("node_errors") or not submitted.get("prompt_id"):raise RuntimeError("The installed workflow rejected this shot: "+json.dumps(submitted.get("node_errors",{})))
            prompt_id=submitted["prompt_id"];manifest["shots"][shot["id"]]={"promptId":prompt_id,"state":"QUEUED"};save_json(manifest_path,manifest)
        print("Generating",shot["id"],"on the local Apple GPU",flush=True)
        source=wait_video(prompt_id);measured=inspect_video(source,frame_count(shot));shutil.copy2(source,target)
        manifest["shots"][shot["id"]]={"promptId":prompt_id,"state":"VERIFIED","sha256":file_hash(target),**measured};save_json(manifest_path,manifest)
        clips.append(target);generated+=1
    visual,movie=assemble(ffmpeg,plan,clips,audio,directory)
    manifest["delivery"]={"movie":str(movie),"visual":str(visual),"sha256":file_hash(movie),"durationMs":duration,"origin":"LOCAL_MLX_AI","allShotsVerified":True};save_json(manifest_path,manifest)
    print("Finished local AI music video:",movie,flush=True)
    print("For the web wizard, import the original song and this complete visual edit:",visual,flush=True)
    subprocess.run(["/usr/bin/open","-R",str(movie)],check=False)
if __name__=="__main__":
    try:main()
    except (RuntimeError,ValueError,urllib.error.URLError,subprocess.CalledProcessError) as error:raise SystemExit(str(error))
