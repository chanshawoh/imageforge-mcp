#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadImages, type LoadedImage } from "./imageInput.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-image-2";

const qualitySchema = z.enum(["auto", "low", "medium", "high"]);
const outputFormatSchema = z.enum(["png", "jpeg", "webp"]);

export interface ImageConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ImageGenerationResponse {
  data?: Array<{ b64_json?: string }>;
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

export function resolveConfig(input: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): ImageConfig {
  const apiKey = firstValue(input.apiKey, process.env.OPENAI_API_KEY);
  if (!apiKey) {
    throw new Error("Missing API key: pass api_key or set OPENAI_API_KEY.");
  }

  const model = firstValue(input.model, process.env.OPENAI_IMAGE_MODEL, DEFAULT_MODEL)!;
  if (model !== DEFAULT_MODEL) {
    throw new Error(`Unsupported model '${model}'. This MVP only supports ${DEFAULT_MODEL}.`);
  }

  const baseUrl = firstValue(input.baseUrl, process.env.OPENAI_BASE_URL, DEFAULT_BASE_URL)!;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error("base_url must be a valid absolute HTTP(S) URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("base_url must use HTTP or HTTPS.");
  }

  return {
    apiKey,
    model,
    baseUrl: baseUrl.replace(/\/+$/, ""),
  };
}

export async function requestImage(input: {
  prompt: string;
  config: ImageConfig;
  size: string;
  quality: z.infer<typeof qualitySchema>;
  outputFormat: z.infer<typeof outputFormatSchema>;
  inputImages?: LoadedImage[];
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const commonFields = {
    model: input.config.model,
    prompt: input.prompt,
    n: 1,
    size: input.size,
    quality: input.quality,
    output_format: input.outputFormat,
  };
  const hasInputImages = Boolean(input.inputImages?.length);
  let body: BodyInit;
  let headers: Record<string, string> = { authorization: `Bearer ${input.config.apiKey}` };
  if (hasInputImages) {
    const form = new FormData();
    for (const [name, value] of Object.entries(commonFields)) form.append(name, String(value));
    for (const image of input.inputImages!) {
      form.append("image[]", new Blob([new Uint8Array(image.data)], { type: image.mimeType }), image.fileName);
    }
    body = form;
  } else {
    headers = { ...headers, "content-type": "application/json" };
    body = JSON.stringify(commonFields);
  }
  const endpoint = hasInputImages ? "edits" : "generations";
  const response = await fetchImpl(`${input.config.baseUrl}/images/${endpoint}`, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`OpenAI image request failed (${response.status}): ${detail || response.statusText}`);
  }

  const payload = (await response.json()) as ImageGenerationResponse;
  const encodedImage = payload.data?.[0]?.b64_json;
  if (!encodedImage) {
    throw new Error("OpenAI image response contained no base64 image data.");
  }

  const normalizedImage = encodedImage.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedImage)) {
    throw new Error("OpenAI image response contained invalid base64 image data.");
  }
  const image = Buffer.from(normalizedImage, "base64");
  if (image.length === 0 || image.toString("base64").replace(/=+$/, "") !== normalizedImage.replace(/=+$/, "")) {
    throw new Error("OpenAI image response contained invalid base64 image data.");
  }
  return image;
}

export async function saveImage(image: Buffer, outputPath: string): Promise<string> {
  const resolvedPath = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
  await fs.writeFile(resolvedPath, image, { flag: "wx" });
  return resolvedPath;
}

async function imageResult(image: Buffer, outputFormat: z.infer<typeof outputFormatSchema>, outputPath?: string) {
  const content: Array<
    | { type: "image"; data: string; mimeType: string }
    | { type: "text"; text: string }
  > = [
    {
      type: "image",
      data: image.toString("base64"),
      mimeType: `image/${outputFormat}`,
    },
  ];
  if (outputPath) {
    const savedPath = await saveImage(image, outputPath);
    content.push({ type: "text", text: `Image saved to ${savedPath}` });
  }
  return { content };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "imageforge-mcp", version: "0.3.0" });

  server.registerTool(
    "generate_image",
    {
      description: "Generate one image with gpt-image-2, optionally guided by reference images.",
      inputSchema: {
        prompt: z.string().trim().min(1).max(32_000).describe("Image description."),
        model: z.string().optional().describe("Model name; only gpt-image-2 is supported."),
        base_url: z.string().optional().describe("OpenAI-compatible base URL ending in /v1."),
        api_key: z.string().optional().describe("Per-call API key; OPENAI_API_KEY is preferred."),
        size: z.string().default("1024x1024").describe("Output size, for example 1536x1024."),
        quality: qualitySchema.default("auto"),
        output_format: outputFormatSchema.default("png"),
        output_path: z.string().trim().min(1).optional().describe(
          "Optional local path to save the generated image. Relative paths resolve from the MCP working directory. Existing files are not overwritten.",
        ),
        reference_images: z.array(z.string()).max(16).optional().describe(
          "Optional reference images as absolute local paths or HTTP(S) URLs.",
        ),
      },
    },
    async ({ prompt, model, base_url, api_key, size, quality, output_format, output_path, reference_images }) => {
      const config = resolveConfig({ apiKey: api_key, baseUrl: base_url, model });
      const inputImages = reference_images?.length ? await loadImages(reference_images) : undefined;
      const image = await requestImage({
        prompt,
        config,
        size,
        quality,
        outputFormat: output_format,
        inputImages,
      });

      return imageResult(image, output_format, output_path);
    },
  );

  server.registerTool(
    "edit_image",
    {
      description: "Edit one or more input images with gpt-image-2.",
      inputSchema: {
        prompt: z.string().trim().min(1).max(32_000).describe("Instructions for the image edit."),
        input_images: z.array(z.string()).min(1).max(16).describe(
          "Input images as absolute local paths or HTTP(S) URLs.",
        ),
        model: z.string().optional().describe("Model name; only gpt-image-2 is supported."),
        base_url: z.string().optional().describe("OpenAI-compatible base URL ending in /v1."),
        api_key: z.string().optional().describe("Per-call API key; OPENAI_API_KEY is preferred."),
        size: z.string().default("1024x1024").describe("Output size, for example 1536x1024."),
        quality: qualitySchema.default("auto"),
        output_format: outputFormatSchema.default("png"),
        output_path: z.string().trim().min(1).optional().describe(
          "Optional local path to save the edited image. Relative paths resolve from the MCP working directory. Existing files are not overwritten.",
        ),
      },
    },
    async ({ prompt, input_images, model, base_url, api_key, size, quality, output_format, output_path }) => {
      const config = resolveConfig({ apiKey: api_key, baseUrl: base_url, model });
      const image = await requestImage({
        prompt,
        config,
        size,
        quality,
        outputFormat: output_format,
        inputImages: await loadImages(input_images),
      });
      return imageResult(image, output_format, output_path);
    },
  );

  return server;
}

async function main(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
