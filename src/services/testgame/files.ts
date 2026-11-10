import crypto from "crypto";
import fs from "fs";
import path from "path";
import sharp from "sharp";
import { prismaApp } from "../../utils/prisma-app";
import { TestGameError } from "./common";

export type FileKind = "guide" | "footage" | "evidence";

export const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "image/gif"]);
const VIDEO_MIME = /^video\//;
const GUIDE_MIME = /^(application\/pdf|image\/|text\/|application\/(msword|vnd\.openxmlformats|vnd\.ms-))/;

export const EVIDENCE_MAX_BYTES = 12 * 1024 * 1024;

export function uploadRoot(): string {
  return process.env.TESTGAME_UPLOAD_DIR?.trim() || path.join(process.cwd(), "data", "uploads", "testgame");
}

export function uploadTmpDir(): string {
  const dir = path.join(uploadRoot(), "_tmp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });
}

/** dHash 64-bit: so sánh độ sáng 9×8 điểm ảnh liền kề — ảnh crop/nén lại vẫn gần nhau. */
export async function dHash(input: Buffer | string): Promise<string> {
  const raw = await sharp(input).rotate().greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (raw[y * 9 + x] < raw[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, "0");
}

export function hamming(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

function safeName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-() ]+/g, "_").slice(-120);
  return base || "file";
}

function checkMime(kind: FileKind, mime: string, size: number, footageMaxMb: number): void {
  if (kind === "evidence") {
    if (!IMAGE_MIME.has(mime)) throw new TestGameError("Ảnh bằng chứng phải là JPG, PNG, WEBP hoặc HEIC");
    if (size > EVIDENCE_MAX_BYTES) throw new TestGameError("Ảnh bằng chứng tối đa 12 MB");
    return;
  }
  if (kind === "footage") {
    if (!VIDEO_MIME.test(mime) && !IMAGE_MIME.has(mime)) throw new TestGameError("Footage phải là video hoặc ảnh");
    if (size > footageMaxMb * 1024 * 1024) throw new TestGameError(`Footage tối đa ${footageMaxMb} MB — tệp lớn hơn hãy dán link Drive/YouTube`);
    return;
  }
  if (!GUIDE_MIME.test(mime)) throw new TestGameError("Tệp hướng dẫn phải là PDF, ảnh, văn bản hoặc Office");
  if (size > 25 * 1024 * 1024) throw new TestGameError("Tệp hướng dẫn tối đa 25 MB");
}

export interface UploadedTemp {
  path: string;
  originalname: string;
  mimetype: string;
  size: number;
}

/**
 * Chuyển tệp tạm (multer disk) vào kho. Ảnh bằng chứng được xoay theo EXIF và thu về JPEG ≤ 2000px;
 * sha256 tính trên tệp gốc để bắt tệp nộp lại y hệt, dHash tính trên ảnh để bắt ảnh gần trùng.
 */
export async function storeUpload(opts: {
  campaignId: string;
  assignmentId: string | null;
  kind: FileKind;
  file: UploadedTemp;
  uploadedBy: string;
  footageMaxMb: number;
}) {
  const { file, kind } = opts;
  try {
    checkMime(kind, file.mimetype, file.size, opts.footageMaxMb);
    const sha = await sha256File(file.path);
    const dir = path.join(uploadRoot(), opts.campaignId, kind);
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomBytes(9).toString("base64url");
    let fileName = safeName(file.originalname);
    let mime = file.mimetype;
    let size = file.size;
    let hash: string | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let target: string;

    if (kind === "evidence" || (IMAGE_MIME.has(file.mimetype) && file.mimetype !== "image/gif")) {
      let img: Buffer;
      try {
        img = await sharp(file.path).rotate().resize(2000, 2000, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
      } catch {
        throw new TestGameError("Không đọc được ảnh — thử chụp lại hoặc lưu dạng JPG/PNG");
      }
      const meta = await sharp(img).metadata();
      width = meta.width ?? null;
      height = meta.height ?? null;
      hash = await dHash(img);
      fileName = fileName.replace(/\.[^.]+$/, "") + ".jpg";
      mime = "image/jpeg";
      size = img.length;
      target = path.join(dir, `${id}.jpg`);
      fs.writeFileSync(target, img);
    } else {
      target = path.join(dir, `${id}${path.extname(fileName).slice(0, 10)}`);
      fs.renameSync(file.path, target);
    }

    return prismaApp.testFile.create({
      data: {
        campaignId: opts.campaignId,
        assignmentId: opts.assignmentId,
        kind,
        fileName,
        mime,
        size,
        storagePath: path.relative(uploadRoot(), target).split(path.sep).join("/"),
        sha256: sha,
        dhash: hash,
        width,
        height,
        uploadedBy: opts.uploadedBy,
      },
    });
  } finally {
    fs.rm(file.path, { force: true }, () => undefined);
  }
}

export function absolutePath(storagePath: string): string {
  const root = path.resolve(uploadRoot());
  const abs = path.resolve(root, storagePath);
  if (!abs.startsWith(root + path.sep)) throw new TestGameError("Đường dẫn tệp không hợp lệ", 400);
  return abs;
}

export async function deleteStoredFile(id: string): Promise<void> {
  const f = await prismaApp.testFile.delete({ where: { id } });
  fs.rm(absolutePath(f.storagePath), { force: true }, () => undefined);
}

export function fileDto(f: { id: string; kind: string; fileName: string; mime: string; size: number; width: number | null; height: number | null; createdAt: Date }) {
  return {
    id: f.id,
    kind: f.kind,
    fileName: f.fileName,
    mime: f.mime,
    size: f.size,
    width: f.width,
    height: f.height,
    createdAt: f.createdAt.toISOString(),
  };
}

/** Đọc ảnh về base64 cho vision model. */
export function readAsDataUrl(storagePath: string, mime: string): string {
  return `data:${mime};base64,${fs.readFileSync(absolutePath(storagePath)).toString("base64")}`;
}
