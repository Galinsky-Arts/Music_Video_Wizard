import { describe, expect, it } from "vitest";
import { capabilitiesFor, resolveProjectRole } from "./access";
import { formatTimecode, parseTimecode } from "./timecode";
import { safeNextPath } from "@/lib/safe-next-path";

describe("project roles", () => {
  const now = new Date("2026-11-17T00:00:00Z");
  it("maps workspace roles and unexpired collaborator grants", () => {
    expect(resolveProjectRole({ workspaceRole: "OWNER", collaborator: null, now })).toBe("OWNER");
    expect(resolveProjectRole({ workspaceRole: "ADMIN", collaborator: null, now })).toBe("OWNER");
    expect(resolveProjectRole({ workspaceRole: "MEMBER", collaborator: null, now })).toBe("EDITOR");
    expect(resolveProjectRole({ workspaceRole: null, collaborator: { role: "REVIEWER", expiresAt: null }, now })).toBe("REVIEWER");
    expect(resolveProjectRole({ workspaceRole: null, collaborator: { role: "EDITOR", expiresAt: new Date("2026-11-18") }, now })).toBe("EDITOR");
    expect(resolveProjectRole({ workspaceRole: null, collaborator: { role: "EDITOR", expiresAt: now }, now })).toBeNull();
    expect(resolveProjectRole({ workspaceRole: null, collaborator: null, now })).toBeNull();
  });

  it("grants capabilities by role", () => {
    expect(capabilitiesFor("OWNER")).toMatchObject({ canEdit: true, canComment: true, canDecideApproval: true, canManageCollaborators: true });
    expect(capabilitiesFor("EDITOR")).toMatchObject({ canEdit: true, canComment: true, canRequestApproval: true, canDecideApproval: false, canManageCollaborators: false });
    expect(capabilitiesFor("REVIEWER")).toMatchObject({ canEdit: false, canComment: true, canRequestApproval: false, canDecideApproval: true });
    expect(capabilitiesFor("VIEWER")).toMatchObject({ canView: true, canEdit: false, canComment: false, canDecideApproval: false });
  });
});

describe("timecodes", () => {
  it("round-trips m:ss.mmm and rejects malformed input", () => {
    expect(parseTimecode("")).toBeNull();
    expect(parseTimecode("1:23.5")).toBe(83500);
    expect(parseTimecode("0:07")).toBe(7000);
    expect(parseTimecode("95")).toBe(95000);
    expect(parseTimecode("1:75")).toBeNaN();
    expect(parseTimecode("abc")).toBeNaN();
    expect(formatTimecode(83500)).toBe("1:23.500");
    expect(formatTimecode(null)).toBe("");
  });
});

describe("post-auth redirect", () => {
  it("accepts only same-site relative paths", () => {
    expect(safeNextPath("/app/invite/abc")).toBe("/app/invite/abc");
    expect(safeNextPath("//evil.example")).toBe("/app");
    expect(safeNextPath("https://evil.example")).toBe("/app");
    expect(safeNextPath("/\\evil.example")).toBe("/app");
    expect(safeNextPath(null)).toBe("/app");
  });
});
