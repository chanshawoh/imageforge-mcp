export const MAX_INPUT_IMAGES = 16;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
export const DEFAULT_INPUT_CONCURRENCY = 4;

export interface LoadedImage {
  data: Uint8Array;
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

interface ImageByteBudget {
  readonly remaining: number;
  reserve(bytes: number): void;
  release(bytes: number): void;
}

export type RemoteFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface LoadImagesOptions {
  concurrency?: string | number;
  maxTotalBytes?: number;
  fetchImpl?: RemoteFetch;
}

function detectMimeType(data: Uint8Array): LoadedImage["mimeType"] | undefined {
  if (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47 &&
    data[4] === 0x0d &&
    data[5] === 0x0a &&
    data[6] === 0x1a &&
    data[7] === 0x0a
  ) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data.length >= 12 &&
    String.fromCharCode(...data.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...data.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return undefined;
}

function extensionFor(mimeType: LoadedImage["mimeType"]): string {
  return mimeType === "image/jpeg" ? ".jpg" : mimeType === "image/webp" ? ".webp" : ".png";
}

function fileNameFromUrl(url: URL, mimeType: LoadedImage["mimeType"]): string {
  const encodedName = url.pathname.split("/").filter(Boolean).at(-1) ?? "remote-image";
  let decodedName = encodedName;
  try {
    decodedName = decodeURIComponent(encodedName);
  } catch {
    // Keep the encoded path segment when it is not valid percent-encoding.
  }
  const sanitized = decodedName.replace(/[^A-Za-z0-9._-]+/g, "_");
  const baseName = sanitized.replace(/\.[^.]*$/, "") || "remote-image";
  return `${baseName}${extensionFor(mimeType)}`;
}

function validateImage(data: Uint8Array, url: URL): LoadedImage {
  if (data.length === 0) throw new Error("Remote input image is empty.");
  if (data.length > MAX_IMAGE_BYTES) throw new Error("Remote input image exceeds the 50 MB limit.");
  const mimeType = detectMimeType(data);
  if (!mimeType) throw new Error("Remote input image must be PNG, JPEG, or WebP.");
  return { data, mimeType, fileName: fileNameFromUrl(url, mimeType) };
}

function assertRemoteUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Input image URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Input image URLs must not contain credentials.");
  }
}

function createByteBudget(limit: number): ImageByteBudget {
  let used = 0;
  return {
    get remaining() {
      return limit - used;
    },
    reserve(bytes) {
      if (bytes < 0 || used + bytes > limit) {
        throw new Error("Combined input images exceed the 200 MB limit.");
      }
      used += bytes;
    },
    release(bytes) {
      used = Math.max(0, used - bytes);
    },
  };
}

async function readLimitedResponse(
  response: Response,
  budget: ImageByteBudget,
): Promise<{ data: Uint8Array; reservedBytes: number }> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? undefined : Number(contentLength);
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Remote input image exceeds the 50 MB limit.");
  }
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > budget.remaining) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Combined input images exceed the 200 MB limit.");
  }
  if (!response.body) throw new Error("Remote input image returned an empty response body.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reservedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) throw new Error("Remote input image exceeds the 50 MB limit.");
      budget.reserve(value.byteLength);
      reservedBytes += value.byteLength;
      chunks.push(value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data, reservedBytes };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    budget.release(reservedBytes);
    throw error;
  }
}

export async function loadRemoteImage(
  source: string,
  fetchImpl: RemoteFetch = fetch,
  budget: ImageByteBudget = createByteBudget(MAX_TOTAL_IMAGE_BYTES),
): Promise<LoadedImage> {
  let current = new URL(source);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    assertRemoteUrl(current);
    const response = await fetchImpl(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get("location");
      if (!location) throw new Error("Remote input image redirect is missing a location header.");
      if (redirects === 3) throw new Error("Remote input image has too many redirects.");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Failed to download input image (${response.status} ${response.statusText}).`);
    }
    const loaded = await readLimitedResponse(response, budget);
    try {
      return validateImage(loaded.data, current);
    } catch (error) {
      budget.release(loaded.reservedBytes);
      throw error;
    }
  }
  throw new Error("Remote input image has too many redirects.");
}

export function resolveInputConcurrency(value: string | number | undefined): number {
  if (value === undefined || String(value).trim() === "") return DEFAULT_INPUT_CONCURRENCY;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
    throw new Error("IMAGEFORGE_INPUT_CONCURRENCY must be a positive integer.");
  }
  return Math.min(Number(normalized), MAX_INPUT_IMAGES);
}

export async function loadImages(
  sources: string[],
  options: LoadImagesOptions = {},
): Promise<LoadedImage[]> {
  if (sources.length === 0) throw new Error("At least one input image is required.");
  if (sources.length > MAX_INPUT_IMAGES) throw new Error("A maximum of 16 input images is supported.");

  const concurrency = resolveInputConcurrency(options.concurrency);
  const maxTotalBytes = Math.min(options.maxTotalBytes ?? MAX_TOTAL_IMAGE_BYTES, MAX_TOTAL_IMAGE_BYTES);
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new Error("The total input image byte limit must be a positive integer.");
  }
  const budget = createByteBudget(maxTotalBytes);
  const results = new Array<LoadedImage>(sources.length);
  let nextIndex = 0;
  let firstError: unknown;

  const worker = async () => {
    while (firstError === undefined) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= sources.length) return;
      try {
        results[index] = await loadRemoteImage(sources[index]!, options.fetchImpl, budget);
      } catch (error) {
        firstError ??= error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  if (firstError !== undefined) throw firstError;
  return results;
}
