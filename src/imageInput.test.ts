import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadImages, loadLocalImage, loadRemoteImage } from "./imageInput.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
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
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(PNG, { status: 200 }));
    const image = await loadRemoteImage("https://93.184.216.34/reference", fetchMock);
    expect(image).toEqual({ data: PNG, fileName: "reference.png", mimeType: "image/png" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://93.184.216.34/reference"),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("rejects local and private URL targets", async () => {
    await expect(loadRemoteImage("http://127.0.0.1/image.png", vi.fn())).rejects.toThrow(
      "private or local",
    );
  });
});

describe("image collection", () => {
  it("requires between one and sixteen images", async () => {
    await expect(loadImages([])).rejects.toThrow("At least one");
    await expect(loadImages(Array(17).fill("/tmp/image.png"))).rejects.toThrow("maximum of 16");
  });
});
