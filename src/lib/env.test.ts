import { describe, expect, it } from "vitest";
import { getEnvironment } from "./env";

const validEnvironment = {
  NODE_ENV: "development",
  DATABASE_URL: "postgresql://localhost/test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  ASSET_STORAGE_DRIVER: "local",
  ASSET_STORAGE_BUCKET: "test-assets"
} as const;

describe("getEnvironment", () => {
  it("accepts a complete development environment", () => {
    const env = getEnvironment(validEnvironment);

    expect(env.NODE_ENV).toBe("development");
    expect(env.ASSET_STORAGE_DRIVER).toBe("local");
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:3000");
    expect(env.JOB_EXECUTOR_URL).toBeUndefined();
    expect(env.JOB_WAKE_TIMEOUT_MS).toBe(90000);
  });

  it("accepts an optional executor wake URL", () => {
    const env = getEnvironment({
      ...validEnvironment,
      JOB_EXECUTOR_URL: "https://executor.example.com",
      JOB_DRAIN_SECRET: "0123456789abcdef0123456789abcdef"
    });

    expect(env.JOB_EXECUTOR_URL).toBe("https://executor.example.com");
  });

  it("rejects a missing database URL", () => {
    const { DATABASE_URL: _databaseUrl, ...withoutDatabase } = validEnvironment;
    expect(() => getEnvironment(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it("rejects an unsafe short authentication secret", () => {
    expect(() =>
      getEnvironment({
        ...validEnvironment,
        BETTER_AUTH_SECRET: "too-short"
      })
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("requires a direct Neon URL in production while migration and pg-boss share DATABASE_URL", () => {
    const base = {
      ...validEnvironment,
      NODE_ENV: "production" as const,
      BETTER_AUTH_URL: "https://mvw.example.com"
    };
    expect(() => getEnvironment({
      ...base,
      DATABASE_URL: "postgresql://user:pass@ep-foo-pooler.us-east-2.aws.neon.tech/neondb"
    })).toThrow(/direct non-pooler/);
    expect(getEnvironment({
      ...base,
      DATABASE_URL: "postgresql://user:pass@ep-foo.us-east-2.aws.neon.tech/neondb"
    }).NODE_ENV).toBe("production");
  });

  it("does not incorrectly reject a development pooled connection", () => {
    expect(getEnvironment({
      ...validEnvironment,
      DATABASE_URL: "postgresql://user:pass@ep-foo-pooler.us-east-2.aws.neon.tech/test"
    }).NODE_ENV).toBe("development");
  });
});


describe("local GPU configuration", () => {
  it("requires an endpoint and workflow for ComfyUI, without requiring a paid key", () => {
    expect(() => getEnvironment({ ...validEnvironment, VIDEO_GENERATION_PROVIDER: "comfyui" })).toThrow(/COMFYUI/);
    const env = getEnvironment({ ...validEnvironment, VIDEO_GENERATION_PROVIDER: "comfyui", COMFYUI_BASE_URL: "http://127.0.0.1:8188", COMFYUI_WORKFLOW_PATH: "/workflows/wan-api.json" });
    expect(env.VIDEO_GENERATION_PROVIDER).toBe("comfyui");
    expect(env.RUNWAY_API_SECRET).toBeUndefined();
  });
});
