import { describe, expect, it, vi } from "vitest";
import worker, {
  handleMcpRequest,
  requestImage,
  resolveConfig,
  type Env,
} from "./index.js";
import type { RemoteFetch } from "./imageInput.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const ENCODED_IMAGE = btoa("generated-image");

function mcpRequest(body: unknown, token?: string): Request {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request("https://mini.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("configuration", () => {
  it("uses Worker bindings and official defaults", () => {
    expect(resolveConfig({}, { OPENAI_API_KEY: "worker-key" })).toEqual({
      apiKey: "worker-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-image-2",
    });
  });

  it("uses call values before Worker bindings", () => {
    expect(resolveConfig({
      apiKey: "call-key",
      baseUrl: "https://call.example/v1/",
      model: "gpt-image-2",
    }, {
      OPENAI_API_KEY: "worker-key",
      OPENAI_BASE_URL: "https://worker.example/v1",
    })).toEqual({
      apiKey: "call-key",
      baseUrl: "https://call.example/v1",
      model: "gpt-image-2",
    });
  });
});

describe("OpenAI Images request", () => {
  it("posts generations using Web APIs and returns validated base64", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: ENCODED_IMAGE }],
    }));

    await expect(requestImage({
      prompt: "A clean route map",
      config: { apiKey: "secret", baseUrl: "https://api.example/v1", model: "gpt-image-2" },
      size: "1536x1024",
      quality: "high",
      outputFormat: "png",
      fetchImpl: fetchMock,
    })).resolves.toBe(ENCODED_IMAGE);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
      }),
    );
  });

  it("posts remote reference images as multipart edits", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: ENCODED_IMAGE }],
    }));

    await requestImage({
      prompt: "Use the reference colors",
      config: { apiKey: "secret", baseUrl: "https://api.example/v1", model: "gpt-image-2" },
      size: "1024x1024",
      quality: "medium",
      outputFormat: "png",
      inputImages: [{ data: PNG, fileName: "reference.png", mimeType: "image/png" }],
      fetchImpl: fetchMock,
    });

    const [, options] = fetchMock.mock.calls[0]!;
    expect(options?.body).toBeInstanceOf(FormData);
    const uploaded = (options?.body as FormData).get("image[]") as File;
    expect(uploaded.name).toBe("reference.png");
    expect(uploaded.type).toBe("image/png");
  });
});

describe("Worker HTTP entry", () => {
  it("exposes a health response", async () => {
    const response = await worker.fetch(new Request("https://mini.example/health"), {});

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      name: "imageforge-mcp-mini",
      version: "0.1.0",
      mcpEndpoint: "/mcp",
    });
  });

  it("enforces the optional MCP bearer token", async () => {
    const env: Env = { IMAGEFORGE_MCP_TOKEN: "mcp-secret" };

    const response = await handleMcpRequest(mcpRequest({ jsonrpc: "2.0", method: "ping", id: 1 }), env);
    expect(response.status).toBe(401);
  });

  it("handles MCP initialization with the Web Standard transport", async () => {
    const response = await handleMcpRequest(mcpRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }), {});

    expect(response.status).toBe(200);
    const payload = await response.json() as { result?: { serverInfo?: { name?: string; version?: string } } };
    expect(payload.result?.serverInfo).toEqual({ name: "imageforge-mcp-mini", version: "0.1.0" });
  });

  it("returns generated images as native MCP image content", async () => {
    const fetchMock = vi.fn<RemoteFetch>().mockResolvedValue(Response.json({
      data: [{ b64_json: ENCODED_IMAGE }],
    }));
    const response = await handleMcpRequest(mcpRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: { prompt: "A minimal blue route map", output_format: "png" },
      },
    }), { OPENAI_API_KEY: "worker-key" }, fetchMock);

    expect(response.status).toBe(200);
    const payload = await response.json() as {
      result?: { content?: Array<{ type?: string; data?: string; mimeType?: string }> };
    };
    expect(payload.result?.content).toEqual([
      { type: "image", data: ENCODED_IMAGE, mimeType: "image/png" },
    ]);
  });
});
