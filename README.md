# ImageForge MCP

English | [中文](#中文说明)

A lightweight TypeScript MCP server for generating and editing images with `gpt-image-2` through the OpenAI Images API.

- Text-to-image requests use `POST /v1/images/generations`.
- Image editing and reference-image generation use multipart `POST /v1/images/edits`.
- Generated images are returned as native MCP `image` content blocks and can optionally be saved locally.

## Features

- Model: `gpt-image-2`
- MCP tools: `generate_image` and `edit_image`
- Text-to-image generation
- Image generation guided by one or more reference images
- Editing one or more existing images
- Local absolute paths and HTTP(S) URLs as image inputs
- PNG, JPEG, and WebP input and output
- Up to 16 input images, with a 50 MB limit per image
- Optional local output path with automatic parent-directory creation
- Safe URL validation against loopback, link-local, and private network targets
- stdio transport

## OpenAI-compatible CPA and gateway support

ImageForge MCP works with OpenAI and with CPA, relay, or proxy services that implement a compatible OpenAI Images API. This includes deployments based on projects such as **New API**, **CLI Proxy API**, and similar OpenAI-compatible gateways.

Compatibility depends on the gateway implementation rather than its product name:

- Text-to-image requires `POST /v1/images/generations`.
- Reference-image generation and editing require multipart `POST /v1/images/edits` with `image[]` file forwarding.
- Responses must include Base64 image data in `data[0].b64_json`.
- The configured model name must accept `gpt-image-2`.

A gateway that only implements `/v1/images/generations` can be used for text-to-image generation, but not for reference-image generation or editing.

## Requirements

- Node.js 22 or later
- An OpenAI API key or a token issued by a compatible CPA/gateway

## Install and build

```bash
npm install
npm run build
```

## MCP client configuration

For production use, start the published npm package with `npx`. No repository clone or local build is required. Inject credentials through the MCP client environment:

```json
{
  "mcpServers": {
    "imageforge": {
      "command": "npx",
      "args": ["-y", "imageforge-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-token",
        "OPENAI_IMAGE_MODEL": "gpt-image-2"
      }
    }
  }
}
```

`-y` allows `npx` to download or update the package without an interactive install prompt. Pin a specific version when reproducible deployments are required, for example `"imageforge-mcp@0.3.0"`.

`OPENAI_BASE_URL` is optional. When it is unset, ImageForge MCP uses the official OpenAI endpoint `https://api.openai.com/v1`. Set it only when using New API, CLI Proxy API, or another OpenAI-compatible gateway:

```json
"OPENAI_BASE_URL": "https://your-openai-compatible-gateway.example/v1"
```

The value must point to the gateway's `/v1` root. ImageForge MCP appends `/images/generations` or `/images/edits` as required.

Do not commit real API keys to Git or write them into shared configuration files.

## Codex local development configuration

Create a project-scoped `.codex/config.toml` using paths that match your machine:

```toml
[mcp_servers.imageforge_dev]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/ImageForgeMCP/dist/index.js"]
cwd = "/absolute/path/to/ImageForgeMCP"
env_vars = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_IMAGE_MODEL"]
startup_timeout_sec = 10
tool_timeout_sec = 300
enabled = true
required = false
```

Export the environment variables before starting Codex:

```bash
export OPENAI_API_KEY="your-gateway-token"
export OPENAI_BASE_URL="https://your-openai-compatible-gateway.example/v1"
export OPENAI_IMAGE_MODEL="gpt-image-2"

cd /absolute/path/to/ImageForgeMCP
codex app
```

Codex loads project-scoped `.codex/config.toml` only for trusted projects. After adding or changing the MCP configuration, restart Codex or open a new task, then use `/mcp verbose` to confirm that `imageforge_dev` exposes:

- `generate_image`
- `edit_image`

After changing the TypeScript source, rebuild `dist/index.js` and restart the task using the MCP server:

```bash
npm run build
```

See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp) for all configuration options.

## `generate_image`

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `prompt` | Yes | - | Image description |
| `model` | No | Environment or `gpt-image-2` | Only `gpt-image-2` is accepted |
| `base_url` | No | `OPENAI_BASE_URL` | Per-call API base URL override |
| `api_key` | No | `OPENAI_API_KEY` | Per-call credential override; environment variables are preferred |
| `size` | No | `1024x1024` | Output size requested from the provider |
| `quality` | No | `auto` | `auto`, `low`, `medium`, or `high` |
| `output_format` | No | `png` | `png`, `jpeg`, or `webp` |
| `output_path` | No | - | Local save path; relative paths resolve from the MCP working directory |
| `reference_images` | No | - | Reference images as local absolute paths or HTTP(S) URLs |

Without `reference_images`, the tool uses `/images/generations`. With reference images, it uploads them as multipart `image[]` files to `/images/edits`.

## `edit_image`

`edit_image` uses the same model, API, output, and local-save parameters as `generate_image`, but requires `input_images`:

| Parameter | Required | Description |
| --- | --- | --- |
| `prompt` | Yes | Editing instructions |
| `input_images` | Yes | 1–16 local absolute paths or HTTP(S) URLs |

Local images are read directly. URL images are downloaded and validated before upload. URLs resolving to loopback, link-local, or private addresses are rejected.

Configuration precedence is: tool arguments, environment variables, then built-in defaults.

When `output_path` is supplied, ImageForge MCP returns the native MCP image content block, saves the decoded image, and includes the final absolute path in a text content block. Missing parent directories are created automatically. Existing files are not overwritten.

Some OpenAI-compatible gateways may return dimensions different from the requested `size`; the actual returned file dimensions are authoritative.

## Verification

```bash
npm test
npm run check
```

Tests use a local HTTP mock. They do not call a real image API or incur generation charges.

## License

[MIT](./LICENSE)

---

# 中文说明

ImageForge MCP 是一个轻量的 TypeScript MCP 图片生成与编辑服务，通过 OpenAI Images API 调用 `gpt-image-2`。

- 纯文本生图调用 `POST /v1/images/generations`。
- 图片编辑和参考图生图调用 multipart `POST /v1/images/edits`。
- 生成结果以原生 MCP `image` 内容块返回，也可以同时保存到本地。

## 功能

- 模型：`gpt-image-2`
- MCP 工具：`generate_image`、`edit_image`
- 支持纯文本生图
- 支持一张或多张参考图引导生图
- 支持一张或多张图片编辑
- 输入图片支持本地绝对路径和 HTTP(S) URL
- 输入与输出支持 PNG、JPEG、WebP
- 最多 16 张输入图片，每张不超过 50 MB
- 支持通过 `output_path` 保存到本地，并自动创建父目录
- URL 安全校验，拒绝访问环回、链路本地和私有网络地址
- stdio Transport

## OpenAI 兼容 CPA 与网关

ImageForge MCP 不仅支持 OpenAI 官方接口，也支持实现了 OpenAI Images API 兼容协议的 CPA、中转或代理服务，包括基于 **New API**、**CLI Proxy API** 等项目部署的 OpenAI 兼容网关。

是否兼容取决于网关实现的接口能力，而不是产品名称：

- 纯文本生图需要实现 `POST /v1/images/generations`。
- 参考图生图和图片编辑需要实现 multipart `POST /v1/images/edits`，并正确转发 `image[]` 文件。
- 响应需要在 `data[0].b64_json` 中返回 Base64 图片数据。
- 网关需要接受 `gpt-image-2` 模型名。

如果网关只实现了 `/v1/images/generations`，仍可用于纯文本生图，但不能使用参考图生图和图片编辑。

## 环境要求

- Node.js 22 或更高版本
- OpenAI API Key，或 OpenAI 兼容 CPA/网关签发的令牌

## 安装与构建

```bash
npm install
npm run build
```

## MCP 客户端配置

生产环境推荐直接通过 `npx` 启动 npm 官方包，无需克隆仓库或在本地构建。通过 MCP 客户端环境变量注入密钥：

```json
{
  "mcpServers": {
    "imageforge": {
      "command": "npx",
      "args": ["-y", "imageforge-mcp"],
      "env": {
        "OPENAI_API_KEY": "你的令牌",
        "OPENAI_IMAGE_MODEL": "gpt-image-2"
      }
    }
  }
}
```

`-y` 允许 `npx` 在没有交互式安装提示的情况下下载或更新包。如果部署需要固定版本，可将包名写成 `"imageforge-mcp@0.3.0"`。

`OPENAI_BASE_URL` 是可选配置。不设置时，ImageForge MCP 默认使用 OpenAI 官方接口 `https://api.openai.com/v1`。只有使用 New API、CLI Proxy API 或其他 OpenAI 兼容网关时才需要设置：

```json
"OPENAI_BASE_URL": "https://你的-OpenAI-兼容网关域名/v1"
```

地址应填写到网关的 `/v1` 根路径为止，服务会根据请求追加 `/images/generations` 或 `/images/edits`。

不要把真实 API Key 写入 Git 或其他共享配置文件。

## Codex 本地开发配置

根据本机路径创建项目级 `.codex/config.toml`：

```toml
[mcp_servers.imageforge_dev]
command = "/你的/node/绝对路径"
args = ["/你的/ImageForgeMCP/绝对路径/dist/index.js"]
cwd = "/你的/ImageForgeMCP/绝对路径"
env_vars = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_IMAGE_MODEL"]
startup_timeout_sec = 10
tool_timeout_sec = 300
enabled = true
required = false
```

启动 Codex 前设置环境变量：

```bash
export OPENAI_API_KEY="你的网关令牌"
export OPENAI_BASE_URL="https://你的-OpenAI-兼容网关域名/v1"
export OPENAI_IMAGE_MODEL="gpt-image-2"

cd /你的/ImageForgeMCP/绝对路径
codex app
```

Codex 只会加载已信任项目中的 `.codex/config.toml`。新增或修改 MCP 配置后，需要重新启动 Codex 或新建任务，再使用 `/mcp verbose` 确认 `imageforge_dev` 提供以下工具：

- `generate_image`
- `edit_image`

修改 TypeScript 源码后，需要重新构建并重启使用该 MCP 的任务：

```bash
npm run build
```

完整配置说明见 [Codex MCP 官方文档](https://developers.openai.com/codex/mcp)。

## `generate_image`

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | 是 | - | 图片描述 |
| `model` | 否 | 环境变量或 `gpt-image-2` | 仅接受 `gpt-image-2` |
| `base_url` | 否 | `OPENAI_BASE_URL` | 单次调用覆盖 API 地址 |
| `api_key` | 否 | `OPENAI_API_KEY` | 单次调用覆盖密钥；推荐使用环境变量 |
| `size` | 否 | `1024x1024` | 请求提供商输出的图片尺寸 |
| `quality` | 否 | `auto` | `auto`、`low`、`medium`、`high` |
| `output_format` | 否 | `png` | `png`、`jpeg`、`webp` |
| `output_path` | 否 | - | 本地保存路径；相对路径按 MCP 工作目录解析 |
| `reference_images` | 否 | - | 参考图数组，支持本地绝对路径和 HTTP(S) URL |

不传 `reference_images` 时调用 `/images/generations`；传入参考图时，将图片作为 multipart `image[]` 文件上传到 `/images/edits`。

## `edit_image`

`edit_image` 与 `generate_image` 使用相同的模型、API、输出和本地保存参数，但 `input_images` 必填：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `prompt` | 是 | 编辑指令 |
| `input_images` | 是 | 1–16 张输入图片，支持本地绝对路径或 HTTP(S) URL |

本地图片会直接读取；URL 图片会经过下载和安全校验后再上传。解析到环回、链路本地或私有地址的 URL 会被拒绝。

配置优先级为：工具参数、环境变量、内置默认值。

传入 `output_path` 时，服务会在返回原生 MCP 图片内容块的同时保存文件，并在文本内容块中返回最终绝对路径。父目录不存在时会自动创建；已有文件不会被覆盖。

部分 OpenAI 兼容网关可能不会严格遵循请求中的 `size`，应以实际返回文件的尺寸为准。

## 验证

```bash
npm test
npm run check
```

测试使用本地 HTTP mock，不会调用真实图片 API，也不会产生生图费用。

## 许可证

[MIT](./LICENSE)
