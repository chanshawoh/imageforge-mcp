import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import path from "node:path";

export const MAX_INPUT_IMAGES = 16;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export interface LoadedImage {
  data: Buffer;
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

function detectMimeType(data: Buffer): LoadedImage["mimeType"] | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return undefined;
}

function extensionFor(mimeType: LoadedImage["mimeType"]): string {
  return mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
}

function validateImage(data: Buffer, fileName: string): LoadedImage {
  if (data.length === 0) {
    throw new Error(`Input image '${fileName}' is empty.`);
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new Error(`Input image '${fileName}' exceeds the 50 MB limit.`);
  }
  const mimeType = detectMimeType(data);
  if (!mimeType) {
    throw new Error(`Input image '${fileName}' must be PNG, JPEG, or WebP.`);
  }
  const baseName = path.basename(fileName, path.extname(fileName)) || "image";
  return { data, mimeType, fileName: `${baseName}${extensionFor(mimeType)}` };
}

function isPrivateAddress(address: string): boolean {
  if (address === "::1" || address === "::" || address.startsWith("fe80:") || address.startsWith("fc") || address.startsWith("fd")) {
    return true;
  }
  if (address.startsWith("::ffff:")) {
    return isPrivateAddress(address.slice(7));
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Image URLs must not contain credentials.");
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error(`Image URL host '${url.hostname}' resolves to a private or local address.`);
  }
}

async function readLimitedResponse(response: Response): Promise<Buffer> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new Error("Remote input image exceeds the 50 MB limit.");
  }
  if (!response.body) throw new Error("Remote input image returned an empty response body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("Remote input image exceeds the 50 MB limit.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export async function loadRemoteImage(
  source: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LoadedImage> {
  let current = new URL(source);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    await assertPublicUrl(current);
    const response = await fetchImpl(current, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) throw new Error("Remote input image has too many redirects.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Failed to download input image (${response.status} ${response.statusText}).`);
    }
    const data = await readLimitedResponse(response);
    return validateImage(data, path.basename(current.pathname) || "remote-image");
  }
  throw new Error("Remote input image has too many redirects.");
}

export async function loadLocalImage(source: string): Promise<LoadedImage> {
  if (!path.isAbsolute(source)) {
    throw new Error(`Local image path must be absolute: '${source}'.`);
  }
  const handle = await fs.open(source, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Input image is not a regular file: '${source}'.`);
    if (stats.size > MAX_IMAGE_BYTES) throw new Error(`Input image '${source}' exceeds the 50 MB limit.`);
    return validateImage(await handle.readFile(), path.basename(source));
  } finally {
    await handle.close();
  }
}

export async function loadImages(sources: string[]): Promise<LoadedImage[]> {
  if (sources.length === 0) throw new Error("At least one input image is required.");
  if (sources.length > MAX_INPUT_IMAGES) throw new Error("A maximum of 16 input images is supported.");
  return Promise.all(
    sources.map((source) => /^https?:\/\//i.test(source) ? loadRemoteImage(source) : loadLocalImage(source)),
  );
}
