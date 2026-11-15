import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

describe("next.config", () => {
  it("uses the stable top-level typedRoutes option (Next 15.5+)", () => {
    expect(nextConfig.typedRoutes).toBe(true);
    expect((nextConfig.experimental as Record<string, unknown> | undefined)?.typedRoutes).toBeUndefined();
  });

  it("keeps security headers on every route", async () => {
    const rules = await nextConfig.headers!();
    expect(rules[0]?.source).toBe("/:path*");
    expect(rules[0]?.headers.map((header) => header.key)).toContain("Content-Security-Policy");
  });
});
