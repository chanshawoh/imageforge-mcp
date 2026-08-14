---
name: use-imageforge-mini
description: Use a deployed ImageForge Mini Streamable HTTP MCP server to generate images with gpt-image-2, guide generation with remote reference-image URLs, or edit remote images. Use for raster image generation or editing when the runtime is Cloudflare Workers or another Web Standards environment. Inputs must be HTTP(S) URLs; local paths and server-side output files are not supported.
---

# Use ImageForge Mini

Use the configured ImageForge Mini MCP server and its `generate_image` or `edit_image` tool. Return the native MCP image result to the user.

## Choose the tool

- Call `generate_image` for text-to-image generation.
- Add `reference_images` when remote images should guide style, color, subject, layout, or composition.
- Call `edit_image` with `input_images` when remote images should be changed.
- Pass only absolute HTTP(S) URLs for image inputs. Do not pass local paths or data URLs.

## Build the request

1. Preserve the user's requested subject, text, composition, and style constraints.
2. Use `model: "gpt-image-2"` unless the deployment documents another compatible model.
3. Prefer `quality: "auto"` for normal work and `quality: "low"` for connectivity checks.
4. Select `size` and `output_format` only when requested or materially useful.
5. Do not pass `output_path`; Mini returns the image through MCP and has no filesystem output.

Generation example:

```json
{
  "prompt": "A clean illustrated railway map through the Swiss Alps, no text",
  "model": "gpt-image-2",
  "quality": "auto",
  "output_format": "png",
  "reference_images": ["https://example.com/reference-map.png"]
}
```

Edit example:

```json
{
  "prompt": "Keep the route unchanged and use a warm watercolor travel-poster style",
  "input_images": ["https://example.com/current-map.png"],
  "model": "gpt-image-2",
  "output_format": "png"
}
```

## Diagnose failures

- Unauthorized: verify the MCP client sends the bearer token configured as `IMAGEFORGE_MCP_TOKEN`.
- Missing API key: configure the Worker's `OPENAI_API_KEY` secret or pass `api_key` per call.
- Reference download failure: confirm every input is an accessible HTTP(S) URL returning PNG, JPEG, or WebP bytes.
- Edit failure: confirm the provider implements `/v1/images/edits`, multipart `image[]`, and Base64 responses.
- Local path or save request: explain that Mini intentionally has no filesystem support; use the Node ImageForge MCP package when local files are required.
