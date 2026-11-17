import { CollaborationError } from "./service";

export function collaborationErrorResponse(error: unknown, label: string) {
  if (error instanceof CollaborationError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error(label + " failed");
  return Response.json({ error: label + " failed." }, { status: 500 });
}

/** JSON-only mutations: cross-site form posts cannot send application/json without CORS preflight. */
export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return null;
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function int(value: unknown): number {
  const number = Number(value);
  return Number.isInteger(number) ? number : -1;
}
