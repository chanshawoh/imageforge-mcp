import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, requestImage, resolveConfig, saveImage } from "./index.js";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.restoreAllMocks();
});

describe("configuration", () => {
  it("uses call values before environment values", () => {
    process.env.OPENAI_API_KEY = "environment-key";
    process.env.OPENAI_BASE_URL = "https://environment.example/v1";

    expect(
      resolveConfig({
        apiKey: "call-key",
        baseUrl: "https://call.example/v1/",
        model: "gpt-image-2",
      }),
    ).toEqual({
      apiKey: "call-key",
      baseUrl: "https://call.example/v1",
      model: "gpt-image-2",
    });
  });

  it("rejects unsupported models", () => {
    expect(() => resolveConfig({ apiKey: "key", model: "other-model" })).toThrow(
      "only supports gpt-image-2",
    );
  });
});

describe("OpenAI Images request", () => {
  it("posts to the configured generations endpoint", async () => {
    const image = Buffer.from("fake-png");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(
      requestImage({
        prompt: "A quiet lake at dawn",
        config: { apiKey: "secret", baseUrl: "https://api2.example/v1", model: "gpt-image-2" },
        size: "1536x1024",
        quality: "high",
        outputFormat: "png",
        fetchImpl: fetchMock,
      }),
    ).resolves.toEqual(image);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api2.example/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: "A quiet lake at dawn",
          n: 1,
          size: "1536x1024",
          quality: "high",
          output_format: "png",
        }),
      }),
    );
  });

  it("rejects a response without image data", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    await expect(
      requestImage({
        prompt: "test",
        config: { apiKey: "key", baseUrl: "https://api2.example/v1", model: "gpt-image-2" },
        size: "1024x1024",
        quality: "auto",
        outputFormat: "png",
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow("no base64 image data");
  });

  it("posts reference images as multipart data to the edits endpoint", async () => {
    const output = Buffer.from("edited-image");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: output.toString("base64") }] }), { status: 200 }),
    );
    await requestImage({
      prompt: "Use the reference colors",
      config: { apiKey: "secret", baseUrl: "https://api2.example/v1", model: "gpt-image-2" },
      size: "1024x1024",
      quality: "medium",
      outputFormat: "png",
      inputImages: [{
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        fileName: "reference.png",
        mimeType: "image/png",
      }],
      fetchImpl: fetchMock,
    });

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api2.example/v1/images/edits");
    expect(options?.headers).toEqual({ authorization: "Bearer secret" });
    expect(options?.body).toBeInstanceOf(FormData);
    const form = options!.body as FormData;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("Use the reference colors");
    expect(form.get("quality")).toBe("medium");
    const uploaded = form.get("image[]") as File;
    expect(uploaded.name).toBe("reference.png");
    expect(uploaded.type).toBe("image/png");
  });
});

describe("image output", () => {
  it("saves an image to a relative path without overwriting existing files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "imageforge-output-"));
    const previousCwd = process.cwd();
    process.chdir(directory);
    try {
      const savedPath = await saveImage(Buffer.from("generated-image"), "nested/dog.png");
      expect(savedPath).toBe(path.resolve("nested/dog.png"));
      await expect(fs.readFile(savedPath)).resolves.toEqual(Buffer.from("generated-image"));
      await expect(saveImage(Buffer.from("replacement"), "nested/dog.png")).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      process.chdir(previousCwd);
      await fs.rm(directory, { recursive: true });
    }
  });
});

describe("MCP server", () => {
  it("exposes only generate_image", async () => {
    const server = createServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(["generate_image", "edit_image"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns the generated bytes as native MCP image content", async () => {
    process.env.OPENAI_API_KEY = "environment-key";
    process.env.OPENAI_BASE_URL = "https://api2.example/v1";
    const image = Buffer.from("generated-image");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }), {
        status: 200,
      }),
    );
    const server = createServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "A minimal blue circle", output_format: "png" },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        {
          type: "image",
          data: image.toString("base64"),
          mimeType: "image/png",
        },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api2.example/v1/images/generations",
        expect.any(Object),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("saves generated bytes when output_path is provided", async () => {
    process.env.OPENAI_API_KEY = "environment-key";
    process.env.OPENAI_BASE_URL = "https://api2.example/v1";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "imageforge-mcp-output-"));
    const outputPath = path.join(directory, "dog.png");
    const image = Buffer.from("generated-image");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: image.toString("base64") }] }), { status: 200 }),
    );
    const server = createServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "A happy dog", output_path: outputPath },
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
        { type: "text", text: `Image saved to ${outputPath}` },
      ]);
      await expect(fs.readFile(outputPath)).resolves.toEqual(image);
    } finally {
      await client.close();
      await server.close();
      await fs.rm(directory, { recursive: true });
    }
  });

  it("routes generate_image with a local reference image through edits", async () => {
    process.env.OPENAI_API_KEY = "environment-key";
    process.env.OPENAI_BASE_URL = "https://api2.example/v1";
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "imageforge-reference-"));
    const referencePath = path.join(directory, "reference.png");
    await fs.writeFile(
      referencePath,
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    );
    const output = Buffer.from("reference-output");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: output.toString("base64") }] }), { status: 200 }),
    );
    const server = createServer();
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({
        name: "generate_image",
        arguments: { prompt: "Follow this visual style", reference_images: [referencePath] },
      });
      expect(result.isError).not.toBe(true);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api2.example/v1/images/edits");
      expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
    } finally {
      await client.close();
      await server.close();
      await fs.rm(directory, { recursive: true });
    }
  });
});
