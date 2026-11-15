import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(source: string): unknown };

type EnvVar = { key: string; value?: string; sync?: boolean };
type Service = Record<string, unknown> & { envVars: EnvVar[] };

const blueprint = yaml.load(
  readFileSync(path.resolve(__dirname, "../../../render.yaml"), "utf8")
) as { services: Service[] };

describe("render.yaml matches the live free deployment", () => {
  const services = blueprint.services;
  const service = services[0] as Service;
  const env = new Map(service.envVars.map((entry) => [entry.key, entry]));

  it("declares exactly one free Docker web service with the readiness health check", () => {
    expect(services).toHaveLength(1);
    expect(service).toMatchObject({
      type: "web",
      name: "music-video-wizard-galinsky-arts",
      runtime: "docker",
      plan: "free",
      branch: "main",
      healthCheckPath: "/api/ready"
    });
    // Free web services reject preDeployCommand; migrations run at container start.
    expect(service.preDeployCommand).toBeUndefined();
  });

  it("keeps every paid generation provider disabled", () => {
    for (const key of [
      "AUDIO_TRANSCRIPTION_PROVIDER",
      "TEXT_GENERATION_PROVIDER",
      "IMAGE_GENERATION_PROVIDER",
      "VIDEO_GENERATION_PROVIDER"
    ]) {
      expect(env.get(key)?.value, key).toBe("none");
    }
  });

  it("runs jobs through the same-service drain route without committing secrets", () => {
    expect(env.get("JOB_EXECUTOR_URL")?.sync).toBe(false);
    expect(env.get("JOB_DRAIN_SECRET")?.sync).toBe(false);
    expect(Number(env.get("JOB_DRAIN_BATCH_SIZE")?.value)).toBeLessThanOrEqual(2);
    for (const secret of [
      "DATABASE_URL",
      "BETTER_AUTH_SECRET",
      "ASSET_STORAGE_SECRET_ACCESS_KEY",
      "STABILITY_API_KEY"
    ]) {
      expect(env.get(secret)).toEqual({ key: secret, sync: false });
    }
  });
});
