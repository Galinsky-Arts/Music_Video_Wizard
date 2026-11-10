import { describe, expect, it } from "vitest";
import { createResonancePlan, narrativePlanSchema } from "./plan";
describe("narrative production plan", () => {
  it("covers the actual soundtrack, assigns every shot to a beat and keeps shots under nine seconds", () => {
    const p = createResonancePlan(); expect(p.durationMs).toBe(230023); expect(p.shots.length).toBeGreaterThan(30);
    expect(p.shots.every(s => s.endMs - s.startMs <= 9000)).toBe(true);
    expect(p.beats.find(b => b.title === "The quiet decision")).toMatchObject({ startMs: 154947, endMs: 166951 });
    expect(p.cast.map(c => c.name)).toEqual(["James T. Kirk", "Spock", "Nyota Uhura"]);
    expect(p.shots.every(s => s.prompt.includes("Character continuity:") && s.consequence.length > 0)).toBe(true);
  });
  it("scales to another song without gaps, duplicates or overlong generated shots", () => {
    for (const duration of [30000,180001,600000]) expect(narrativePlanSchema.safeParse(createResonancePlan(duration)).success).toBe(true);
    expect(() => createResonancePlan(0)).toThrow();
  });
  it("rejects gaps, overlapping timing and misplaced shots", () => {
    const p = createResonancePlan(); p.shots[0]!.endMs += 1; expect(narrativePlanSchema.safeParse(p).success).toBe(false);
    const q = createResonancePlan(); q.shots[0]!.beat = "An answered signal"; expect(narrativePlanSchema.safeParse(q).success).toBe(false);
  });
});
