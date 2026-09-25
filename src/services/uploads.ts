import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { env } from "../lib/env.js";
import { AppError } from "../lib/errors.js";

export const UPLOAD_ROOT = path.resolve(process.cwd(), "uploads");

const ALLOWED: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export type KycDocKind = "selfie" | "address";

function stripDataUrl(raw: string): { mime?: string; base64: string } {
  const trimmed = raw.trim();
  const match = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
  if (match) {
    return { mime: match[1]?.toLowerCase(), base64: match[2]! };
  }
  return { base64: trimmed.replace(/\s+/g, "") };
}

async function saveUserUpload(input: {
  userId: string;
  namespace: "kyc" | "support";
  prefix: string;
  contentType: string;
  dataBase64: string;
  originalName?: string;
}): Promise<{ url: string; relativePath: string; bytes: number; filename: string }> {
  const parsed = stripDataUrl(input.dataBase64);
  const mime = (parsed.mime || input.contentType || "image/jpeg").toLowerCase();
  const ext = ALLOWED[mime];
  if (!ext) {
    throw new AppError(400, "Unsupported file type. Use JPG, PNG, WEBP or PDF.", "UPLOAD_TYPE");
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(parsed.base64, "base64");
  } catch {
    throw new AppError(400, "Invalid file encoding", "UPLOAD_ENCODING");
  }
  if (!buffer.length) {
    throw new AppError(400, "Empty file", "UPLOAD_EMPTY");
  }
  // ~6MB decoded
  if (buffer.length > 6 * 1024 * 1024) {
    throw new AppError(400, "File too large (max 6 MB)", "UPLOAD_TOO_LARGE");
  }

  const dir = path.join(UPLOAD_ROOT, input.namespace, input.userId);
  await mkdir(dir, { recursive: true });
  const filename = `${input.prefix}-${nanoid(16)}.${ext}`;
  const absolute = path.join(dir, filename);
  await writeFile(absolute, buffer);

  const relativePath = `${input.namespace}/${input.userId}/${filename}`;
  const url = `${env.APP_BASE_URL.replace(/\/$/, "")}/uploads/${relativePath}`;
  const displayName =
    input.originalName?.trim().slice(0, 160) ||
    `${input.prefix}.${ext}`;
  return { url, relativePath, bytes: buffer.length, filename: displayName };
}

export async function saveKycDocument(input: {
  userId: string;
  kind: KycDocKind;
  contentType: string;
  dataBase64: string;
}): Promise<{ url: string; relativePath: string; bytes: number }> {
  const saved = await saveUserUpload({
    userId: input.userId,
    namespace: "kyc",
    prefix: input.kind,
    contentType: input.contentType,
    dataBase64: input.dataBase64,
  });
  return { url: saved.url, relativePath: saved.relativePath, bytes: saved.bytes };
}

export async function saveSupportAttachment(input: {
  userId: string;
  contentType: string;
  dataBase64: string;
  originalName?: string;
}): Promise<{ url: string; relativePath: string; bytes: number; filename: string }> {
  return saveUserUpload({
    userId: input.userId,
    namespace: "support",
    prefix: "ticket",
    contentType: input.contentType,
    dataBase64: input.dataBase64,
    originalName: input.originalName,
  });
}

/** True when URL is one of our stored support uploads for this user. */
export function isOwnSupportUploadUrl(userId: string, value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  const marker = `/uploads/support/${userId}/`;
  return v.includes(marker);
}

/** Reject local device paths that were incorrectly stored as "uploads". */
export function isStoredUploadUrl(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^file:\/\//i.test(v)) return false;
  if (/^content:\/\//i.test(v)) return false;
  if (/^ph:\/\//i.test(v)) return false;
  if (v.startsWith("/uploads/")) return true;
  if (v.includes("/uploads/kyc/")) return true;
  if (v.includes("/uploads/support/")) return true;
  return /^https?:\/\//i.test(v);
}
