import { AssetStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { getEnvironment } from "@/lib/env";
import { attachmentDisposition } from "@/lib/storage/disposition";
import {
  readLocalAsset,
  verifyLocalAssetSignature
} from "@/lib/storage/local";

export const runtime = "nodejs";

function responseBody(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function parseRange(
  header: string | null,
  totalBytes: number
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : totalBytes - 1;
  const end = Math.min(requestedEnd, totalBytes - 1);

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start > end ||
    start >= totalBytes
  ) {
    return null;
  }

  return { start, end };
}

export async function GET(request: Request) {
  const env = getEnvironment();
  if (env.ASSET_STORAGE_DRIVER !== "local") {
    return new Response("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature");
  const downloadFileName = url.searchParams.get("download") || undefined;

  if (
    !key ||
    !signature ||
    !verifyLocalAssetSignature(
      key,
      expires,
      signature,
      env.BETTER_AUTH_SECRET,
      downloadFileName
    )
  ) {
    return new Response("Forbidden", { status: 403 });
  }

  const assetVersion = await db.assetVersion.findUnique({
    where: { storageKey: key },
    select: {
      status: true,
      contentType: true
    }
  });

  if (!assetVersion || assetVersion.status !== AssetStatus.READY) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const bytes = await readLocalAsset(env.ASSET_STORAGE_LOCAL_ROOT, key);
    const downloadHeaders: Record<string, string> = downloadFileName
      ? { "Content-Disposition": attachmentDisposition(downloadFileName) }
      : {};
    const range = parseRange(request.headers.get("range"), bytes.byteLength);

    if (!range) {
      return new Response(responseBody(bytes), {
        headers: {
          ...downloadHeaders,
          "Content-Type": assetVersion.contentType,
          "Content-Length": String(bytes.byteLength),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, max-age=60"
        }
      });
    }

    const body = bytes.slice(range.start, range.end + 1);
    return new Response(responseBody(body), {
      status: 206,
      headers: {
        ...downloadHeaders,
        "Content-Type": assetVersion.contentType,
        "Content-Length": String(body.byteLength),
        "Content-Range": `bytes ${range.start}-${range.end}/${bytes.byteLength}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=60"
      }
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
