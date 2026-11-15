import { afterEach,describe,expect,it } from "vitest";
import { resolveOverlayFont } from "./fonts";

afterEach(()=>{delete process.env.VIDEO_RENDER_FONT_FILE;});

describe("resolveOverlayFont",()=>{
  it("prefers a configured font, then the first installed candidate",()=>{
    process.env.VIDEO_RENDER_FONT_FILE="/custom.ttf";
    expect(resolveOverlayFont(["/a.ttf"],path=>path==="/custom.ttf")).toBe("/custom.ttf");
    expect(resolveOverlayFont(["/a.ttf","/b.ttf"],path=>path==="/b.ttf")).toBe("/b.ttf");
    expect(resolveOverlayFont(["/a.ttf"],()=>false)).toBeNull();
  });
});
