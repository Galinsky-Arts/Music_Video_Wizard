import importlib.util
import http.client
import json
import os
import platform
import subprocess
import tempfile
import shutil
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
spec=importlib.util.spec_from_file_location("gpu_gateway",Path(__file__).with_name("gateway.py"))
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
TOKEN="test-private-token-for-local-gpu-0123456789"
class Upstream(BaseHTTPRequestHandler):
    calls=[]
    def log_message(self,*args): pass
    def do_GET(self): self.reply()
    def do_POST(self): self.reply()
    def reply(self):
        body=self.rfile.read(int(self.headers.get("Content-Length","0")))
        self.calls.append((self.command,self.path,dict(self.headers),body))
        if self.path.endswith("000000000001"):
            self.send_response(302);self.send_header("Location","https://example.invalid");self.end_headers();return
        content=b"x"*(2*1024*1024+1) if self.path.endswith("000000000002") else b'{"ok":true}'
        self.send_response(200);self.send_header("Content-Type","application/json");self.send_header("Content-Length",str(len(content)));self.end_headers()
        try: self.wfile.write(content)
        except BrokenPipeError: pass
class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream=ThreadingHTTPServer(("127.0.0.1",0),Upstream)
        cls.gateway=module.make_server(TOKEN,port=0,comfy_port=cls.upstream.server_address[1])
        for server in (cls.upstream,cls.gateway):threading.Thread(target=server.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        for server in (cls.gateway,cls.upstream):server.shutdown();server.server_close()
    def setUp(self): Upstream.calls=[]
    def req(self,path,method="GET",auth=True,body=None,headers=None):
        connection=http.client.HTTPConnection(*self.gateway.server_address,timeout=5)
        fields={"Authorization":"Bearer "+TOKEN} if auth else {}
        fields.update(headers or {})
        connection.request(method,path,body=body,headers=fields)
        response=connection.getresponse();data=response.read();status=response.status;connection.close();return status,data
    def test_unauthorized_requests_never_reach_comfy(self):
        self.assertEqual(self.req("/prompt",method="POST",auth=False)[0],401)
        self.assertEqual(self.req("/view",headers={"Authorization":"Bearer wrong"})[0],401)
        self.assertEqual(Upstream.calls,[])
    def test_only_selected_routes_are_exposed(self):
        for path in ("/","/system_stats","/object_info","/history","/queue","https://example.invalid/"):
            self.assertIn(self.req(path)[0],(400,403))
        self.assertEqual(Upstream.calls,[])
    def test_valid_prompt_forwards_no_private_gateway_credential(self):
        payload=b'{"prompt":{"1":{"class_type":"SyntheticTransportTest","inputs":{}}}}'
        status,_=self.req("/prompt",method="POST",body=payload,headers={"Content-Type":"application/json"})
        self.assertEqual(status,200)
        self.assertEqual(Upstream.calls[0][3],payload)
        self.assertFalse(any(k.lower()=="authorization" for k in Upstream.calls[0][2]))
    def test_private_history_and_output_routes(self):
        self.assertEqual(self.req("/history/11111111-1111-4111-8111-111111111111")[0],200)
        self.assertEqual(self.req("/view?filename=clip.mp4&subfolder=mvw&type=output")[0],200)
        for query in ("filename=../private&subfolder=&type=output","filename=private&subfolder=&type=input","filename=x&subfolder=..%2Finput&type=output","filename=x&subfolder=C%3Aprivate&type=output","filename=x&subfolder=&type=output&extra=x"):
            self.assertEqual(self.req("/view?"+query)[0],403)
    def test_oversized_upload_is_rejected_before_body_or_upstream(self):
        self.assertEqual(self.req("/upload/image",method="POST",headers={"Content-Length":str(13*1024*1024)})[0],413)
        self.assertEqual(Upstream.calls,[])
    def test_redirects_and_oversized_history_are_not_forwarded(self):
        for end in ("000000000001","000000000002"):
            self.assertEqual(self.req("/history/11111111-1111-4111-8111-"+end)[0],502)
    @unittest.skipIf(platform.system()=="Darwin","Do not run the installer in a Mac unit test")
    def test_installer_refuses_non_mac_hardware_before_creating_runtime_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/"not-created"
            run=subprocess.run(["bash",str(Path(__file__).with_name("setup.sh"))],env={**os.environ,"MVW_GPU_HOME":str(root)},capture_output=True,text=True,timeout=5)
            self.assertEqual(run.returncode,1)
            self.assertIn("Apple-silicon Mac",run.stdout)
            self.assertFalse(root.exists())
    def test_short_tokens_are_not_accepted(self):
        with self.assertRaises(ValueError):module.make_server("short",port=0)
class StoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec=importlib.util.spec_from_file_location("local_story",Path(__file__).with_name("story.py"))
        cls.story=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.story)
    def test_actual_story_has_exact_total_frames_and_supported_local_generation_lengths(self):
        plan=json.loads((Path(__file__).resolve().parents[2]/"config"/"controlled-chaos-story.json").read_text())
        self.story.validate_plan(plan)
        self.assertEqual(sum(self.story.frame_count(s) for s in plan["shots"]),5521)
        for shot in plan["shots"]:
            frames=self.story.graph_for(shot)["3"]["inputs"]["num_frames"]
            self.assertEqual((frames-1)%8,0);self.assertGreaterEqual(frames,self.story.frame_count(shot));self.assertLessEqual(frames,257)
    def test_story_paths_and_gaps_are_rejected(self):
        for shot in ({"id":"../private","startMs":0,"endMs":1000,"prompt":"x"},{"id":"ok","startMs":1,"endMs":1000,"prompt":"x"}):
            with self.assertRaises(ValueError):self.story.validate_plan({"schemaVersion":1,"durationMs":1000,"shots":[shot]})
    @unittest.skipUnless(shutil.which("ffmpeg"),"FFmpeg is required for real assembly acceptance")
    def test_real_assembly_keeps_frame_timing_and_original_audio_immutable(self):
        import hashlib
        import av
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);clips=[]
            for name,color,length in (("a","red",1.5),("b","blue",2.5)):
                path=root/(name+".mp4")
                subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i",f"color=c={color}:s=160x96:r=24:d={length}","-threads","1","-y",str(path)],check=True)
                clips.append(path)
            audio=root/"original.wav"
            subprocess.run(["ffmpeg","-v","error","-f","lavfi","-i","sine=frequency=440:duration=3.003","-y",str(audio)],check=True)
            before=hashlib.sha256(audio.read_bytes()).hexdigest()
            plan={"schemaVersion":1,"durationMs":3003,"shots":[{"id":"a","startMs":0,"endMs":1007,"prompt":"red"},{"id":"b","startMs":1007,"endMs":3003,"prompt":"blue"}]}
            self.story.validate_plan(plan)
            visual,movie=self.story.assemble(Path(shutil.which("ffmpeg")),plan,clips,audio,root)
            self.assertEqual(self.story.inspect_video(visual)["frames"],72)
            self.assertEqual(hashlib.sha256(audio.read_bytes()).hexdigest(),before)
            with av.open(str(movie)) as container:
                self.assertEqual(len(container.streams.audio),1)
                self.assertAlmostEqual(float(container.streams.audio[0].duration*container.streams.audio[0].time_base),3.003,places=2)
                samples=list(container.decode(video=0))
                self.assertEqual(len(samples),72)
                first=samples[0].to_ndarray(format="rgb24")[360,640]
                second=samples[24].to_ndarray(format="rgb24")[360,640]
                self.assertGreater(first[0],first[2]);self.assertGreater(second[2],second[0])
if __name__=="__main__":unittest.main()
