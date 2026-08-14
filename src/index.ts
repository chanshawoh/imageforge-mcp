import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { loadImages, type LoadedImage, type RemoteFetch } from "./imageInput.js";

const PACKAGE_NAME = "imageforge-mcp-mini";
const PACKAGE_VERSION = "0.1.0";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-image-2";

const qualitySchema = z.enum(["auto", "low", "medium", "high"]);
const outputFormatSchema = z.enum(["png", "jpeg", "webp"]);

export interface Env {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_IMAGE_MODEL?: string;
  IMAGEFORGE_INPUT_CONCURRENCY?: string;
  IMAGEFORGE_MCP_TOKEN?: string;
}

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

export function resolveConfig(
  input: { apiKey?: string; baseUrl?: string; model?: string },
  env: Env,
): ImageConfig {
  const apiKey = firstValue(input.apiKey, env.OPENAI_API_KEY);
  if (!apiKey) throw new Error("Missing API key: pass api_key or configure OPENAI_API_KEY.");

  const model = firstValue(input.model, env.OPENAI_IMAGE_MODEL, DEFAULT_MODEL)!;
  if (model !== DEFAULT_MODEL) {
    throw new Error(`Unsupported model '${model}'. ImageForge Mini only supports ${DEFAULT_MODEL}.`);
  }

  const baseUrl = firstValue(input.baseUrl, env.OPENAI_BASE_URL, DEFAULT_BASE_URL)!;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new Error("base_url must be a valid absolute HTTP(S) URL.");
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new Error("base_url must use HTTP or HTTPS.");
  }
  return { apiKey, model, baseUrl: baseUrl.replace(/\/+$/, "") };
}

function validateBase64Image(encodedImage: string): string {
  const normalized = encodedImage.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("OpenAI image response contained invalid base64 image data.");
  }
  try {
    if (atob(normalized).length === 0) throw new Error("empty image");
  } catch {
    throw new Error("OpenAI image response contained invalid base64 image data.");
  }
  return normalized;
}

export async function requestImage(input: {
  prompt: string;
  config: ImageConfig;
  size: string;
  quality: z.infer<typeof qualitySchema>;
  outputFormat: z.infer<typeof outputFormatSchema>;
  inputImages?: LoadedImage[];
  fetchImpl?: RemoteFetch;
}): Promise<string> {
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
      const uploadBytes = Uint8Array.from(image.data);
      form.append("image[]", new Blob([uploadBytes.buffer], { type: image.mimeType }), image.fileName);
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
  if (!encodedImage) throw new Error("OpenAI image response contained no base64 image data.");
  return validateBase64Image(encodedImage);
}

function imageResult(encodedImage: string, outputFormat: z.infer<typeof outputFormatSchema>) {
  return {
    content: [{ type: "image" as const, data: encodedImage, mimeType: `image/${outputFormat}` }],
  };
}

export function createServer(env: Env, fetchImpl: RemoteFetch = fetch): McpServer {
  const server = new McpServer({ name: PACKAGE_NAME, version: PACKAGE_VERSION });

  server.registerTool(
    "generate_image",
    {
      description: "Generate one image with gpt-image-2, optionally guided by remote reference images.",
      inputSchema: {
        prompt: z.string().trim().min(1).max(32_000).describe("Image description."),
        model: z.string().optional().describe("Model name; only gpt-image-2 is supported."),
        base_url: z.string().optional().describe("OpenAI-compatible base URL ending in /v1."),
        api_key: z.string().optional().describe("Per-call API key; the OPENAI_API_KEY binding is preferred."),
        size: z.string().default("1024x1024").describe("Output size, for example 1536x1024."),
        quality: qualitySchema.default("auto"),
        output_format: outputFormatSchema.default("png"),
        reference_images: z.array(z.string().url()).max(16).optional().describe(
          "Optional HTTP(S) reference image URLs. Local file paths are not supported.",
        ),
      },
    },
    async ({ prompt, model, base_url, api_key, size, quality, output_format, reference_images }) => {
      const config = resolveConfig({ apiKey: api_key, baseUrl: base_url, model }, env);
      const inputImages = reference_images?.length
        ? await loadImages(reference_images, {
            concurrency: env.IMAGEFORGE_INPUT_CONCURRENCY,
            fetchImpl,
          })
        : undefined;
      const image = await requestImage({
        prompt,
        config,
        size,
        quality,
        outputFormat: output_format,
        inputImages,
        fetchImpl,
      });
      return imageResult(image, output_format);
    },
  );

  server.registerTool(
    "edit_image",
    {
      description: "Edit one or more remote images with gpt-image-2.",
      inputSchema: {
        prompt: z.string().trim().min(1).max(32_000).describe("Instructions for the image edit."),
        input_images: z.array(z.string().url()).min(1).max(16).describe(
          "Input images as HTTP(S) URLs. Local file paths are not supported.",
        ),
        model: z.string().optional().describe("Model name; only gpt-image-2 is supported."),
        base_url: z.string().optional().describe("OpenAI-compatible base URL ending in /v1."),
        api_key: z.string().optional().describe("Per-call API key; the OPENAI_API_KEY binding is preferred."),
        size: z.string().default("1024x1024").describe("Output size, for example 1536x1024."),
        quality: qualitySchema.default("auto"),
        output_format: outputFormatSchema.default("png"),
      },
    },
    async ({ prompt, input_images, model, base_url, api_key, size, quality, output_format }) => {
      const config = resolveConfig({ apiKey: api_key, baseUrl: base_url, model }, env);
      const image = await requestImage({
        prompt,
        config,
        size,
        quality,
        outputFormat: output_format,
        inputImages: await loadImages(input_images, {
          concurrency: env.IMAGEFORGE_INPUT_CONCURRENCY,
          fetchImpl,
        }),
        fetchImpl,
      });
      return imageResult(image, output_format);
    },
  );

  return server;
}

function jsonError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

function isAuthorized(request: Request, env: Env): boolean {
  const token = env.IMAGEFORGE_MCP_TOKEN?.trim();
  return !token || request.headers.get("authorization") === `Bearer ${token}`;
}

export async function handleMcpRequest(
  request: Request,
  env: Env,
  fetchImpl: RemoteFetch = fetch,
): Promise<Response> {
  if (!isAuthorized(request, env)) return jsonError(401, -32001, "Unauthorized");
  if (request.method !== "POST") return jsonError(405, -32000, "Method not allowed");

  const server = createServer(env, fetchImpl);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(request);
    await server.close();
    return response;
  } catch (error) {
    await server.close().catch(() => undefined);
    return jsonError(500, -32603, error instanceof Error ? error.message : "Internal server error");
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/mcp") return handleMcpRequest(request, env);
    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        name: PACKAGE_NAME,
        version: PACKAGE_VERSION,
        mcpEndpoint: "/mcp",
      });
    }
    return new Response("Not found", { status: 404 });
  },
};

export default worker;
