import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_INPUT_CONCURRENCY,
  MAX_IMAGE_BYTES,
  MAX_INPUT_IMAGES,
  loadImages,
  loadRemoteImage,
  resolveInputConcurrency,
  type RemoteFetch,
} from "./imageInput.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("remote image input", () => {
  it("downloads and validates an HTTP image without Node DNS APIs", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(new Response(PNG, { status: 200 }));

    await expect(loadRemoteImage("https://images.example/trip-map.bin", fetchMock)).resolves.toEqual({
      data: PNG,
      fileName: "trip-map.png",
      mimeType: "image/png",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://images.example/trip-map.bin"),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("allows private-looking hosts because Mini delegates networking policy to the runtime", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(new Response(PNG, { status: 200 }));

    await expect(loadRemoteImage("http://127.0.0.1/image.png", fetchMock)).resolves.toMatchObject({
      mimeType: "image/png",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps protocol and credential validation", async () => {
    const fetchMock = vi.fn<RemoteFetch>();

    await expect(loadRemoteImage("ftp://images.example/image.png", fetchMock)).rejects.toThrow("HTTP or HTTPS");
    await expect(loadRemoteImage("https://user:pass@images.example/image.png", fetchMock)).rejects.toThrow(
      "must not contain credentials",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates every redirect target", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValueOnce(new Response(null, {
      status: 302,
      headers: { location: "ftp://images.example/image.png" },
    }));

    await expect(loadRemoteImage("https://images.example/start", fetchMock)).rejects.toThrow("HTTP or HTTPS");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a declared image size above the per-image limit", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { "content-length": String(MAX_IMAGE_BYTES + 1) },
    }));

    await expect(loadRemoteImage("https://images.example/image.png", fetchMock)).rejects.toThrow("50 MB limit");
  });
});

describe("image collection", () => {
  it("caps configured concurrency at the 16-image input limit", () => {
    expect(resolveInputConcurrency(undefined)).toBe(DEFAULT_INPUT_CONCURRENCY);
    expect(resolveInputConcurrency("2")).toBe(2);
    expect(resolveInputConcurrency("16")).toBe(MAX_INPUT_IMAGES);
    expect(resolveInputConcurrency("100")).toBe(MAX_INPUT_IMAGES);
    expect(() => resolveInputConcurrency("0")).toThrow("positive integer");
  });

  it("limits concurrent downloads", async () => {
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
      "https://images.example/1.png",
      "https://images.example/2.png",
      "https://images.example/3.png",
      "https://images.example/4.png",
    ], { concurrency: 2, fetchImpl: fetchMock });

    expect(maximumActive).toBe(2);
  });

  it("rejects combined input data above the configured test budget", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockImplementation(async () => new Response(PNG, { status: 200 }));

    await expect(loadImages([
      "https://images.example/1.png",
      "https://images.example/2.png",
    ], {
      concurrency: 2,
      maxTotalBytes: PNG.length,
      fetchImpl: fetchMock,
    })).rejects.toThrow("Combined input images");
  });
});
