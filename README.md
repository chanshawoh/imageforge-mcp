# ImageForge Mini

ImageForge Mini is the Web Standards edition of ImageForge MCP. It runs as a stateless Streamable HTTP MCP server on Cloudflare Workers and uses `gpt-image-2` through the OpenAI Images API or a compatible gateway.

Independent npm package: `imageforge-mcp-mini`

Independent release line: `0.1.x`

## Why Mini

The Node edition supports local files, local output paths, DNS resolution checks, and pinned network connections. Those capabilities depend on Node.js APIs and cannot run natively in Cloudflare Workers.

ImageForge Mini removes the Node-specific surface:

| Capability | ImageForge MCP | ImageForge Mini |
| --- | --- | --- |
| Runtime | Node.js | Cloudflare Workers / Web Standards |
| MCP transport | stdio | Streamable HTTP at `/mcp` |
| Reference inputs | Local paths and HTTP(S) URLs | HTTP(S) URLs only |
| Local output files | Supported | Not supported |
| `node:fs`, `node:dns`, `node:net`, `node:path` | Used | Not used |
| DNS address validation and pinning | Supported | Delegated to the runtime/network policy |

## Features

- `generate_image` for text-to-image generation
- Optional remote reference images through `/v1/images/edits`
- `edit_image` for one or more remote input images
- Native MCP image content returned to the client
- OpenAI-compatible base URL support
- Up to 16 input images
- 50 MB per-image limit and 200 MB combined limit
- Bounded remote-image loading concurrency, default `4`, capped at `16`
- Manual redirect handling with validation on every hop
- PNG, JPEG, and WebP signature validation
- Optional bearer-token protection for the MCP endpoint
- No Node.js built-in module imports in runtime source

## Deploy to Cloudflare Workers

Install dependencies:

```bash
npm install
```

Configure the OpenAI API key as a Worker secret:

```bash
npx wrangler secret put OPENAI_API_KEY
```

Protect the public MCP endpoint with a bearer token:

```bash
npx wrangler secret put IMAGEFORGE_MCP_TOKEN
```

Start local Worker development or deploy:

```bash
npm run build
npx wrangler dev
npx wrangler deploy
```

The MCP endpoint is:

```text
https://your-worker.example/mcp
```

When `IMAGEFORGE_MCP_TOKEN` is configured, the MCP client must send:

```http
Authorization: Bearer <your-token>
```

If the token is omitted, `/mcp` is unauthenticated. Use Cloudflare Access or another upstream authentication layer before exposing that configuration publicly.

## Worker bindings

| Binding | Required | Default | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes, unless passed per call | — | OpenAI or gateway API key |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | OpenAI-compatible base URL |
| `OPENAI_IMAGE_MODEL` | No | `gpt-image-2` | Image model; Mini currently accepts only `gpt-image-2` |
| `IMAGEFORGE_INPUT_CONCURRENCY` | No | `4` | Concurrent remote input downloads, capped at `16` |
| `IMAGEFORGE_MCP_TOKEN` | No, strongly recommended | — | Bearer token for `/mcp` |

Non-secret defaults can be configured in `wrangler.jsonc`. Keep API keys and bearer tokens in Worker secrets.

## Use as an npm dependency

Create another Worker project and install the independent package:

```bash
npm install imageforge-mcp-mini
```

Re-export the Worker handler:

```ts
import imageforgeMini from "imageforge-mcp-mini";

export default imageforgeMini;
```

The consuming Worker must provide the bindings listed above.

## MCP tools

### `generate_image`

- `prompt`: required
- `reference_images`: optional HTTP(S) URLs, maximum 16
- `model`: optional, `gpt-image-2`
- `base_url`: optional per-call gateway override
- `api_key`: optional per-call key override
- `size`: default `1024x1024`
- `quality`: `auto`, `low`, `medium`, or `high`
- `output_format`: `png`, `jpeg`, or `webp`

### `edit_image`

- `prompt`: required
- `input_images`: required HTTP(S) URLs, maximum 16
- The remaining generation parameters match `generate_image`

Mini intentionally does not expose `output_path`. Generated images are returned as native MCP image content.

## URL and SSRF security boundary

ImageForge Mini keeps checks that work with Web APIs:

- HTTP(S)-only URLs
- No credentials embedded in URLs
- Maximum three redirects, with every target revalidated
- Streamed per-image and combined byte limits
- Image magic-byte validation

Mini does not resolve hostnames, reject private IP ranges, or pin DNS results. Cloudflare Workers does not expose the low-level DNS and connection controls used by the Node edition. Treat remote-image URLs as untrusted input and apply Cloudflare Access, egress policy, or gateway controls appropriate to the deployment.

## Development

```bash
npm run check
npm pack --dry-run
```

The build output is placed in `dist/`. The npm package and the Node edition have separate names and version histories.

## License

MIT

---

# ImageForge Mini 中文说明

ImageForge Mini 是 ImageForge MCP 的 Web Standards 版本，使用 Streamable HTTP MCP 协议运行在 Cloudflare Workers 上，通过 OpenAI Images API 或兼容网关调用 `gpt-image-2`。

独立 npm 包：`imageforge-mcp-mini`

独立版本线：`0.1.x`

## 为什么叫 Mini

Node 版本支持本地文件、本地输出路径、DNS 解析安全检查以及连接地址固定，这些能力依赖 Node.js API，无法直接运行在 Cloudflare Workers 中。

ImageForge Mini 移除了 Node 专属能力：

| 能力 | ImageForge MCP | ImageForge Mini |
| --- | --- | --- |
| 运行环境 | Node.js | Cloudflare Workers / Web Standards |
| MCP Transport | stdio | `/mcp` Streamable HTTP |
| 参考图片 | 本地路径和 HTTP(S) URL | 仅 HTTP(S) URL |
| 保存到本地 | 支持 | 不支持 |
| `node:fs`、`node:dns`、`node:net`、`node:path` | 使用 | 不使用 |
| DNS 地址检查与固定 | 支持 | 由运行时和网络策略负责 |

## 主要能力

- `generate_image` 文生图及远程参考图生图
- `edit_image` 编辑一个或多个远程图片
- 通过 MCP 原生图片内容返回结果
- 支持 OpenAI 兼容 `base_url`
- 最多 16 张输入图片
- 单图最大 50 MB，单次合计最大 200 MB
- 输入加载默认并发 4，最多 16
- 每次重定向重新执行 URL 校验
- PNG、JPEG、WebP 图片魔数校验
- MCP 端点可配置 Bearer Token
- 运行时代码不导入 Node.js 内置模块

## 部署到 Cloudflare Workers

```bash
npm install
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put IMAGEFORGE_MCP_TOKEN
npm run build
npx wrangler deploy
```

部署后的 MCP 地址为：

```text
https://你的-worker-域名/mcp
```

配置了 `IMAGEFORGE_MCP_TOKEN` 后，MCP 客户端必须发送：

```http
Authorization: Bearer <你的-token>
```

如果不配置 Token，`/mcp` 将不要求认证。公开部署时应配置 Token，或者使用 Cloudflare Access 等上游认证能力。

## Worker 环境变量

| 变量 | 是否必需 | 默认值 | 用途 |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | 是，除非每次调用传入 | — | OpenAI 或兼容网关 API Key |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | OpenAI 兼容地址 |
| `OPENAI_IMAGE_MODEL` | 否 | `gpt-image-2` | 当前仅支持 `gpt-image-2` |
| `IMAGEFORGE_INPUT_CONCURRENCY` | 否 | `4` | 远程输入图片加载并发，最多 16 |
| `IMAGEFORGE_MCP_TOKEN` | 否，但强烈建议 | — | `/mcp` Bearer Token |

普通变量可以写入 `wrangler.jsonc`，API Key 和 Token 应通过 Worker Secret 管理。

## 作为 npm 依赖使用

```bash
npm install imageforge-mcp-mini
```

在 Worker 入口中直接导出：

```ts
import imageforgeMini from "imageforge-mcp-mini";

export default imageforgeMini;
```

## 工具差异

Mini 保留 `generate_image` 和 `edit_image`，但输入图片只能使用 HTTP(S) URL，并且不提供 `output_path`。生成结果直接作为 MCP 原生图片内容返回。

## URL 与 SSRF 安全边界

Mini 仍保留以下校验：

- 只允许 HTTP(S)
- URL 中禁止携带用户名和密码
- 最多三次重定向，每次重新校验目标 URL
- 流式单图及合计容量限制
- 图片魔数校验

Mini 不执行域名解析、私有 IP 拦截或 DNS 地址固定。Cloudflare Workers 不提供 Node 版本使用的底层 DNS 与连接控制能力。远程图片 URL 仍应视为不可信输入，并根据部署场景配置 Cloudflare Access、出口策略或兼容网关限制。

## 开发验证

```bash
npm run check
npm pack --dry-run
```

Mini 与 Node 版本使用不同的 npm 包名和独立版本历史。

## License

MIT
