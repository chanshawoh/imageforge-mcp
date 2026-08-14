import { promises as fs } from "node:fs";
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";
import path from "node:path";
import { Agent, type Dispatcher } from "undici";

export const MAX_INPUT_IMAGES = 16;
export const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
export const DEFAULT_INPUT_CONCURRENCY = 4;

export interface LoadedImage {
  data: Buffer;
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

interface ResolvedAddress {
  address: string;
  family: number;
}

interface ImageByteBudget {
  readonly remaining: number;
  reserve(bytes: number): void;
  release(bytes: number): void;
}

interface RemoteRequestInit extends RequestInit {
  dispatcher?: Dispatcher;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type RemoteFetch = (input: URL, init: RemoteRequestInit) => Promise<Response>;

export interface LoadImagesOptions {
  concurrency?: number;
  maxTotalBytes?: number;
  fetchImpl?: RemoteFetch;
  resolveImpl?: AddressResolver;
  skipDnsSafetyChecks?: boolean;
}

const blockedIpv4Addresses = new BlockList();
const blockedIpv6Addresses = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedIpv4Addresses.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["100:0:0:1::", 64],
  ["2001::", 23],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  blockedIpv6Addresses.addSubnet(network, prefix, "ipv6");
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

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blockedIpv4Addresses.check(address, "ipv4");
  if (family === 6) return !blockedIpv6Addresses.check(address, "ipv6");
  return false;
}

function hostnameForLookup(url: URL): string {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

const resolveAddresses: AddressResolver = async (hostname) => {
  const family = isIP(hostname);
  return family
    ? [{ address: hostname, family }]
    : await lookup(hostname, { all: true, verbatim: true });
};

function assertRemoteUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Image URLs must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("Image URLs must not contain credentials.");
  }
}

async function resolvePublicAddresses(url: URL, resolveImpl: AddressResolver): Promise<ResolvedAddress[]> {
  assertRemoteUrl(url);
  const addresses = await resolveImpl(hostnameForLookup(url));
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => family !== isIP(address) || !isPublicAddress(address))
  ) {
    throw new Error(`Image URL host '${url.hostname}' resolves to a non-public address.`);
  }
  return addresses;
}

export function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  let nextAddress = 0;
  return (_hostname, options, callback) => {
    const requestedFamily = options.family === "IPv4" ? 4 : options.family === "IPv6" ? 6 : options.family;
    const candidates = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter(({ family }) => family === requestedFamily)
      : addresses;
    if (candidates.length === 0) {
      callback(new Error("No validated address matches the requested IP family."), "", 0);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    const selected = candidates[nextAddress % candidates.length]!;
    nextAddress += 1;
    callback(null, selected.address, selected.family);
  };
}

function createPinnedDispatcher(addresses: ResolvedAddress[]): Agent {
  return new Agent({
    connect: { lookup: createPinnedLookup(addresses) },
    autoSelectFamily: addresses.some(({ family }) => family === 4) && addresses.some(({ family }) => family === 6),
  });
}

const defaultRemoteFetch: RemoteFetch = async (input, init) => fetch(input, init as RequestInit);

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
  budget?: ImageByteBudget,
): Promise<{ data: Buffer; reservedBytes: number }> {
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? undefined : Number(contentLength);
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Remote input image exceeds the 50 MB limit.");
  }
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && budget && declaredLength > budget.remaining) {
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
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error("Remote input image exceeds the 50 MB limit.");
      }
      budget?.reserve(value.byteLength);
      reservedBytes += value.byteLength;
      chunks.push(value);
    }
    return { data: Buffer.concat(chunks, total), reservedBytes };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    budget?.release(reservedBytes);
    throw error;
  }
}

export async function loadRemoteImage(
  source: string,
  fetchImpl: RemoteFetch = defaultRemoteFetch,
  resolveImpl: AddressResolver = resolveAddresses,
  budget?: ImageByteBudget,
  skipDnsSafetyChecks: boolean = resolveSkipDnsSafetyChecks(),
): Promise<LoadedImage> {
  let current = new URL(source);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const dispatcher = skipDnsSafetyChecks
      ? undefined
      : createPinnedDispatcher(await resolvePublicAddresses(current, resolveImpl));
    if (skipDnsSafetyChecks) assertRemoteUrl(current);
    try {
      const response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        const location = response.headers.get("location");
        if (!location || redirects === 3) throw new Error("Remote input image has too many redirects.");
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`Failed to download input image (${response.status} ${response.statusText}).`);
      }
      const loaded = await readLimitedResponse(response, budget);
      try {
        return validateImage(loaded.data, path.basename(current.pathname) || "remote-image");
      } catch (error) {
        budget?.release(loaded.reservedBytes);
        throw error;
      }
    } finally {
      await dispatcher?.close();
    }
  }
  throw new Error("Remote input image has too many redirects.");
}

export async function loadLocalImage(source: string, budget?: ImageByteBudget): Promise<LoadedImage> {
  if (!path.isAbsolute(source)) {
    throw new Error(`Local image path must be absolute: '${source}'.`);
  }
  const handle = await fs.open(source, "r");
  let reservedBytes = 0;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error(`Input image is not a regular file: '${source}'.`);
    if (stats.size > MAX_IMAGE_BYTES) throw new Error(`Input image '${source}' exceeds the 50 MB limit.`);
    if (budget && stats.size > budget.remaining) throw new Error("Combined input images exceed the 200 MB limit.");
    budget?.reserve(stats.size);
    reservedBytes = stats.size;
    const data = await handle.readFile();
    if (data.length > reservedBytes) {
      budget?.reserve(data.length - reservedBytes);
    } else if (data.length < reservedBytes) {
      budget?.release(reservedBytes - data.length);
    }
    reservedBytes = data.length;
    return validateImage(data, path.basename(source));
  } catch (error) {
    budget?.release(reservedBytes);
    throw error;
  } finally {
    await handle.close();
  }
}

export function resolveInputConcurrency(value: string | number | undefined = process.env.IMAGEFORGE_INPUT_CONCURRENCY): number {
  if (value === undefined || String(value).trim() === "") return DEFAULT_INPUT_CONCURRENCY;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
    throw new Error("IMAGEFORGE_INPUT_CONCURRENCY must be a positive integer.");
  }
  return Math.min(Number(normalized), MAX_INPUT_IMAGES);
}

export function resolveSkipDnsSafetyChecks(
  value: string | boolean | undefined = process.env.IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS,
): boolean {
  if (value === undefined || String(value).trim() === "") return false;
  if (typeof value === "boolean") return value;
  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(
        "IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS must be true/false, 1/0, yes/no, or on/off.",
      );
  }
}

export async function loadImages(
  sources: string[],
  options: LoadImagesOptions = {},
): Promise<LoadedImage[]> {
  if (sources.length === 0) throw new Error("At least one input image is required.");
  if (sources.length > MAX_INPUT_IMAGES) throw new Error("A maximum of 16 input images is supported.");

  const concurrency = resolveInputConcurrency(options.concurrency);
  const skipDnsSafetyChecks = options.skipDnsSafetyChecks ?? resolveSkipDnsSafetyChecks();
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
      const source = sources[index]!;
      try {
        results[index] = /^https?:\/\//i.test(source)
          ? await loadRemoteImage(source, options.fetchImpl, options.resolveImpl, budget, skipDnsSafetyChecks)
          : await loadLocalImage(source, budget);
      } catch (error) {
        firstError ??= error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, sources.length) }, worker));
  if (firstError !== undefined) throw firstError;
  return results;
}
