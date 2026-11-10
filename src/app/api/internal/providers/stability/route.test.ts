import { afterEach,describe,expect,it,vi } from "vitest";
import { getEnvironment } from "@/lib/env";
import { getStabilityCreditBalance } from "@/lib/media-generation/stability-images";
import { POST } from "./route";
vi.mock("@/lib/env",()=>({getEnvironment:vi.fn()}));
vi.mock("@/lib/media-generation/stability-images",()=>({getStabilityCreditBalance:vi.fn()}));
afterEach(()=>vi.resetAllMocks());
function env(key="private-key") {vi.mocked(getEnvironment).mockReturnValue({STABILITY_API_KEY:key,JOB_DRAIN_SECRET:"0123456789abcdef0123456789abcdef",IMAGE_GENERATION_PROVIDER:"none"} as ReturnType<typeof getEnvironment>);}
function req(secret?:string){return new Request("https://app.example/api/internal/providers/stability",{method:"POST",headers:secret?{"x-job-drain-secret":secret}:{}});}
describe("private Stability diagnostic",()=>{
  it("denies missing or incorrect operator secrets before querying the provider",async()=>{
    env();for(const s of [undefined,"wrong","x".repeat(32)])expect((await POST(req(s))).status).toBe(401);expect(getStabilityCreditBalance).not.toHaveBeenCalled();
  });
  it("reports a missing key without making any provider call",async()=>{
    env("");const r=await POST(req("0123456789abcdef0123456789abcdef"));expect(await r.json()).toMatchObject({configured:false,authenticated:false,generationEnabled:false});expect(getStabilityCreditBalance).not.toHaveBeenCalled();
  });
  it("returns balance and presence without revealing the key or enabling generation",async()=>{
    env();vi.mocked(getStabilityCreditBalance).mockResolvedValue({credits:50});const r=await POST(req("0123456789abcdef0123456789abcdef"));const body=await r.text();expect(body).not.toContain("private-key");expect(JSON.parse(body)).toMatchObject({configured:true,authenticated:true,credits:50,generationEnabled:false,videoApiAvailable:false});expect(r.headers.get("cache-control")).toBe("no-store");
  });
  it("does not expose raw provider errors",async()=>{
    env();vi.mocked(getStabilityCreditBalance).mockRejectedValue(new Error("private-key details"));const r=await POST(req("0123456789abcdef0123456789abcdef"));expect(r.status).toBe(502);expect(await r.text()).not.toContain("private-key");
  });
});
