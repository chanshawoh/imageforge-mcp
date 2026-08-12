---
name: use-imageforge-mcp
description: Use the local ImageForge MCP server to generate images with gpt-image-2, generate from reference images, edit existing images, and save results locally. Use whenever the user requests drawing, image generation, visual creation, image variation, style or composition guidance from reference images, image editing, or saving a generated image to a project path. Supports local absolute paths and HTTP(S) URLs for input images.
---

# Use ImageForge MCP

Use the MCP server named `image_generate` and its `generate_image` or `edit_image` tool. Do not substitute another image-generation tool when these tools are available and the user asks for raster image generation or editing.

## Choose the tool

- Call `generate_image` for text-to-image generation.
- Call `generate_image` with `reference_images` when references should guide style, color, subject, layout, or composition.
- Call `edit_image` with `input_images` when the user wants existing images changed.
- Accept input images as absolute local paths or HTTP(S) URLs. Do not convert a discoverable local file into a data URL.

## Build the request

1. Convert the user's intent into a clear prompt while preserving all explicit constraints. Do not silently change the requested subject, text, composition, or style.
2. Use `model: "gpt-image-2"`. The server does not support other models.
3. Choose `size`, `quality`, and `output_format` only when requested or useful. Prefer `quality: "low"` for connectivity tests and `quality: "auto"` for normal work.
4. Pass `reference_images` to `generate_image`, or the required `input_images` to `edit_image`.
5. Pass `output_path` when the user asks to save the result. Use a path whose extension matches `output_format`.

Example generation request:

```json
{
  "prompt": "A happy Shiba Inu in an autumn park, warm natural light, no text",
  "model": "gpt-image-2",
  "quality": "auto",
  "output_format": "png",
  "output_path": "outputs/shiba.png"
}
```

Example edit request:

```json
{
  "prompt": "Keep the dog unchanged and replace the background with a snowy forest",
  "input_images": ["/absolute/path/to/dog.png"],
  "model": "gpt-image-2",
  "output_format": "png",
  "output_path": "outputs/dog-snow.png"
}
```

## Handle output safely

- Relative `output_path` values resolve from the MCP server working directory. Prefer an absolute path when the requested destination could be ambiguous.
- The server creates missing parent directories but refuses to overwrite an existing file. Choose a new filename unless the user explicitly asks to replace a file; replacement requires the user to remove or rename the existing target first.
- Return the generated image to the user and report the final saved path when the tool supplies it.
- After saving, verify the file exists and inspect its type and dimensions when filesystem tools are available.
- Treat the returned image's actual dimensions as authoritative. Some OpenAI-compatible CPA/API2 providers may not honor the requested `size` exactly.

## Diagnose failures

- Tool missing or `output_path` absent from its schema: rebuild the project and restart the MCP client/task.
- Missing API key: ensure `OPENAI_API_KEY` is forwarded to the MCP process.
- Authentication or HTTP failure: report the returned provider status and detail without exposing the API key.
- Reference or edit failure: confirm the provider implements `/v1/images/edits` with multipart `image[]` forwarding.
- Existing output file: use a new filename; do not delete or overwrite files without clear user authorization.
