import { z } from "zod";

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.string().url(),
    ASSET_STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    ASSET_STORAGE_BUCKET: z.string().min(1),
    ASSET_STORAGE_ENDPOINT: z.string().url().optional().or(z.literal("")),
    ASSET_STORAGE_REGION: z.string().min(1).default("us-east-1"),
    ASSET_STORAGE_ACCESS_KEY_ID: z.string().optional().or(z.literal("")),
    ASSET_STORAGE_SECRET_ACCESS_KEY: z.string().optional().or(z.literal("")),
    ASSET_STORAGE_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ASSET_STORAGE_LOCAL_ROOT: z.string().min(1).default(".data/assets"),
    MAX_MEDIA_UPLOAD_BYTES: z.coerce.number().int().positive().max(104857600).default(52428800),
    MAX_AUDIO_UPLOAD_BYTES: z.coerce.number().int().positive().default(536870912),
    JOB_QUEUE_SCHEMA: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default("pgboss"),
    JOB_RETRY_LIMIT: z.coerce.number().int().min(0).max(20).default(3),
    JOB_RETRY_DELAY_SECONDS: z.coerce.number().int().min(0).max(3600).default(5),
    JOB_RETRY_DELAY_MAX_SECONDS: z.coerce.number().int().positive().max(86400).default(300),
    JOB_EXPIRE_SECONDS: z.coerce.number().int().min(60).max(86400).default(21600),
    JOB_HEARTBEAT_SECONDS: z.coerce.number().int().min(10).max(3600).default(30),
    JOB_WORKER_CONCURRENCY: z.coerce.number().int().positive().max(64).default(4),
    JOB_WORKSPACE_CONCURRENCY: z.coerce.number().int().positive().max(32).default(2),
    JOB_DRAIN_SECRET: z.string().min(32).optional().or(z.literal("")),
    JOB_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().max(16).default(2),
    JOB_EXECUTOR_URL: z.string().url().optional().or(z.literal("")),
    JOB_WAKE_TIMEOUT_MS: z.coerce.number().int().min(1000).max(180000).default(90000),
    AUDIO_ANALYSIS_PYTHON: z.string().min(1).default("python3"),
    AUDIO_ANALYSIS_FFMPEG: z.string().min(1).default("ffmpeg"),
    VIDEO_RENDER_FFPROBE: z.string().min(1).default("ffprobe"),
    VIDEO_RENDER_FFMPEG: z.string().min(1).default("ffmpeg"),
    AUDIO_TRANSCRIPTION_PROVIDER: z.enum(["none", "openai"]).default("none"),
    AUDIO_TRANSCRIPTION_MODEL: z.string().min(1).default("gpt-transcribe"),
    TEXT_GENERATION_PROVIDER: z.enum(["none", "openai"]).default("none"),
    TEXT_GENERATION_MODEL: z.string().min(1).default("gpt-6-sol"),
    IMAGE_GENERATION_PROVIDER: z.enum(["none", "openai", "stability"]).default("none"),
    VIDEO_GENERATION_PROVIDER: z.enum(["none", "runway", "comfyui"]).default("none"),
    COMFYUI_BASE_URL: z.string().url().optional().or(z.literal("")),
    COMFYUI_WORKFLOW_PATH: z.string().min(1).optional().or(z.literal("")),
    COMFYUI_API_KEY: z.string().optional().or(z.literal("")),
    STABILITY_API_KEY: z.string().optional().or(z.literal("")),
    RUNWAY_API_SECRET: z.string().optional().or(z.literal("")),
    RUNWAY_BASE_URL: z.string().url().default("https://api.dev.runwayml.com"),
    RUNWAY_API_VERSION: z.string().min(1).default("2024-11-06"),
    OPENAI_API_KEY: z.string().optional().or(z.literal("")),
    OPENAI_BASE_URL: z.string().url().default("https://api.openai.com")
  })
  .superRefine((env, ctx) => {
    // The current topology shares DATABASE_URL between Prisma migrations and
    // pg-boss LISTEN/NOTIFY. A Neon transaction-pooler URL is incompatible.
    if (env.NODE_ENV === "production") {
      try {
        const url = new URL(env.DATABASE_URL);
        if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
          throw new Error("Not a PostgreSQL endpoint.");
        }
        const pooled = /(^|[-.])pooler([-.]|$)/i.test(url.hostname);
        if (pooled) {
          ctx.addIssue({
            code: "custom",
            path: ["DATABASE_URL"],
            message: "Use a direct non-pooler PostgreSQL URL for the current Prisma migration and pg-boss topology."
          });
        }
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "Production DATABASE_URL must be a valid PostgreSQL connection URL."
        });
      }
    }

    const hasAccessKey = Boolean(env.ASSET_STORAGE_ACCESS_KEY_ID);
    const hasSecretKey = Boolean(env.ASSET_STORAGE_SECRET_ACCESS_KEY);
    if (hasAccessKey !== hasSecretKey) {
      ctx.addIssue({
        code: "custom",
        path: ["ASSET_STORAGE_ACCESS_KEY_ID"],
        message: "S3 access key and secret key must be supplied together"
      });
    }

    if (
      (env.AUDIO_TRANSCRIPTION_PROVIDER === "openai" ||
        env.TEXT_GENERATION_PROVIDER === "openai" ||
        env.IMAGE_GENERATION_PROVIDER === "openai") &&
      !env.OPENAI_API_KEY
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["OPENAI_API_KEY"],
        message:
          "OPENAI_API_KEY is required when an OpenAI audio, text, or image provider is enabled"
      });
    }

    if (env.IMAGE_GENERATION_PROVIDER === "stability" && !env.STABILITY_API_KEY) {
      ctx.addIssue({ code: "custom", path: ["STABILITY_API_KEY"], message: "STABILITY_API_KEY is required when Stability image generation is enabled." });
    }

    if (env.VIDEO_GENERATION_PROVIDER === "comfyui" && (!env.COMFYUI_BASE_URL || !env.COMFYUI_WORKFLOW_PATH)) {
      ctx.addIssue({ code: "custom", path: ["COMFYUI_BASE_URL"], message: "ComfyUI video generation requires COMFYUI_BASE_URL and COMFYUI_WORKFLOW_PATH." });
    }

    if(
      env.VIDEO_GENERATION_PROVIDER==="runway" &&
      !env.RUNWAY_API_SECRET
    ){
      ctx.addIssue({
        code:"custom",
        path:["RUNWAY_API_SECRET"],
        message:
          "RUNWAY_API_SECRET is required when the Runway video provider is enabled"
      });
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

let cachedEnvironment: AppEnvironment | undefined;

export function getEnvironment(
  source: NodeJS.ProcessEnv = process.env
): AppEnvironment {
  if (source === process.env && cachedEnvironment) return cachedEnvironment;

  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      "Invalid application environment: " +
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")
    );
  }

  if (source === process.env) cachedEnvironment = parsed.data;
  return parsed.data;
}
