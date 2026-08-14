import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INPUT_CONCURRENCY,
  MAX_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  createPinnedLookup,
  isPublicAddress,
  loadImages,
  loadLocalImage,
  loadRemoteImage,
  resolveInputConcurrency,
  resolveSkipDnsSafetyChecks,
  type RemoteFetch,
} from "./imageInput.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const temporaryDirectories: string[] = [];
const originalInputConcurrency = process.env.IMAGEFORGE_INPUT_CONCURRENCY;
const originalSkipDnsSafetyChecks = process.env.IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalInputConcurrency === undefined) {
    delete process.env.IMAGEFORGE_INPUT_CONCURRENCY;
  } else {
    process.env.IMAGEFORGE_INPUT_CONCURRENCY = originalInputConcurrency;
  }
  if (originalSkipDnsSafetyChecks === undefined) {
    delete process.env.IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS;
  } else {
    process.env.IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS = originalSkipDnsSafetyChecks;
  }
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })));
});

describe("local image input", () => {
  it("loads an absolute PNG path", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "imageforge-input-"));
    temporaryDirectories.push(directory);
    const imagePath = path.join(directory, "reference.bin");
    await fs.writeFile(imagePath, PNG);

    await expect(loadLocalImage(imagePath)).resolves.toEqual({
      data: PNG,
      fileName: "reference.png",
      mimeType: "image/png",
    });
  });

  it("rejects relative paths and unsupported files", async () => {
    await expect(loadLocalImage("relative.png")).rejects.toThrow("must be absolute");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "imageforge-input-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "not-image.txt");
    await fs.writeFile(filePath, "not an image");
    await expect(loadLocalImage(filePath)).rejects.toThrow("must be PNG, JPEG, or WebP");
  });
});

describe("remote image input", () => {
  it("downloads and validates a public URL", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(new Response(PNG, { status: 200 }));
    const image = await loadRemoteImage("https://93.184.216.34/reference", fetchMock);
    expect(image).toEqual({ data: PNG, fileName: "reference.png", mimeType: "image/png" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://93.184.216.34/reference"),
      expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }),
    );
  });

  it.each([
    "127.0.0.1",
    "100.64.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "100:0:0:1::1",
    "3fff::1",
    "5f00::1",
    "fe90::1",
    "ff02::1",
    "::ffff:7f00:1",
  ])("classifies %s as non-public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["8.8.8.8", "93.184.216.34", "2001:4860:4860::8888"])(
    "classifies %s as public",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it("rejects local and non-public URL targets before fetching", async () => {
    const fetchMock = vi.fn<RemoteFetch>();
    await expect(loadRemoteImage("http://127.0.0.1/image.png", fetchMock)).rejects.toThrow(
      "non-public address",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("can skip DNS safety checks through the environment", async () => {
    process.env.IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS = "true";
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(new Response(PNG, { status: 200 }));
    const resolveMock = vi.fn();

    await expect(loadRemoteImage("http://127.0.0.1/image.png", fetchMock, resolveMock)).resolves.toEqual({
      data: PNG,
      fileName: "image.png",
      mimeType: "image/png",
    });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("dispatcher");
  });

  it("keeps protocol and credential validation when DNS safety checks are skipped", async () => {
    process.env.IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS = "true";
    const fetchMock = vi.fn<RemoteFetch>();

    await expect(loadRemoteImage("ftp://127.0.0.1/image.png", fetchMock)).rejects.toThrow("HTTP or HTTPS");
    await expect(loadRemoteImage("http://user:pass@127.0.0.1/image.png", fetchMock)).rejects.toThrow(
      "must not contain credentials",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("also skips DNS safety checks after redirects", async () => {
    process.env.IMAGEFORGE_SKIP_DNS_SAFETY_CHECKS = "true";
    const fetchMock = vi.fn<RemoteFetch>()
      .mockResolvedValueOnce(new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/image.png" },
      }))
      .mockResolvedValueOnce(new Response(PNG, { status: 200 }));
    const resolveMock = vi.fn();

    await expect(loadRemoteImage("https://example.test/start", fetchMock, resolveMock)).resolves.toMatchObject({
      mimeType: "image/png",
    });
    expect(resolveMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => !("dispatcher" in init))).toBe(true);
  });

  it("rejects a hostname when any resolved address is non-public", async () => {
    const fetchMock = vi.fn<RemoteFetch>();
    const resolveMock = vi.fn().mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);

    await expect(loadRemoteImage("https://example.test/image.png", fetchMock, resolveMock)).rejects.toThrow(
      "non-public address",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins the connection lookup to the validated addresses", async () => {
    const pinnedLookup = createPinnedLookup([{ address: "8.8.8.8", family: 4 }]);
    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      pinnedLookup("attacker-controlled.test", { family: 4 }, (error, address, family) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ address: String(address), family: family ?? 0 });
      });
    });

    expect(result).toEqual({ address: "8.8.8.8", family: 4 });
  });

  it("revalidates redirect targets before the next fetch", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/image.png" },
    }));

    await expect(loadRemoteImage("https://8.8.8.8/start", fetchMock)).rejects.toThrow("non-public address");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects excessive redirects", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(new Response(null, {
      status: 302,
      headers: { location: "https://8.8.8.8/again" },
    }));

    await expect(loadRemoteImage("https://8.8.8.8/start", fetchMock)).rejects.toThrow("too many redirects");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a declared image size above the per-image limit", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { "content-length": String(MAX_IMAGE_BYTES + 1) },
    }));

    await expect(loadRemoteImage("https://8.8.8.8/image.png", fetchMock)).rejects.toThrow("50 MB limit");
  });
});

describe("image collection", () => {
  it("requires between one and sixteen images", async () => {
    await expect(loadImages([])).rejects.toThrow("At least one");
    await expect(loadImages(Array(17).fill("/tmp/image.png"))).rejects.toThrow("maximum of 16");
  });

  it("uses configurable concurrency with a hard maximum", () => {
    expect(resolveInputConcurrency(undefined)).toBe(DEFAULT_INPUT_CONCURRENCY);
    expect(resolveInputConcurrency("2")).toBe(2);
    expect(resolveInputConcurrency("16")).toBe(MAX_INPUT_IMAGES);
    expect(resolveInputConcurrency("17")).toBe(MAX_INPUT_IMAGES);
    expect(resolveInputConcurrency("999")).toBe(MAX_INPUT_IMAGES);
    expect(() => resolveInputConcurrency("0")).toThrow("positive integer");
    expect(() => resolveInputConcurrency("not-a-number")).toThrow("positive integer");
  });

  it("parses the DNS safety bypass environment setting strictly", () => {
    expect(resolveSkipDnsSafetyChecks(undefined)).toBe(false);
    expect(resolveSkipDnsSafetyChecks("true")).toBe(true);
    expect(resolveSkipDnsSafetyChecks("1")).toBe(true);
    expect(resolveSkipDnsSafetyChecks("off")).toBe(false);
    expect(() => resolveSkipDnsSafetyChecks("sometimes")).toThrow("must be true/false");
  });

  it("limits concurrent image downloads using the environment setting", async () => {
    process.env.IMAGEFORGE_INPUT_CONCURRENCY = "2";
    let active = 0;
    let maximumActive = 0;
    const fetchMock = vi.fn<RemoteFetch>().mockImplementation(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return new Response(PNG, { status: 200 });
    });

    await loadImages([
      "https://1.1.1.1/1.png",
      "https://8.8.8.8/2.png",
      "https://9.9.9.9/3.png",
      "https://93.184.216.34/4.png",
    ], { fetchImpl: fetchMock });

    expect(maximumActive).toBe(2);
  });

  it("rejects input images that exceed the combined byte limit", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockImplementation(async () => new Response(PNG, { status: 200 }));

    await expect(loadImages([
      "https://1.1.1.1/1.png",
      "https://8.8.8.8/2.png",
    ], {
      concurrency: 2,
      maxTotalBytes: PNG.length,
      fetchImpl: fetchMock,
    })).rejects.toThrow("Combined input images");
  });
});
