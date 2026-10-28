/**
 * Rough, offline token estimates for the parts of MCP traffic that end up in
 * the model's context. Claude's tokenizer isn't public, so these are a
 * heuristic; `mcpspy tokens --exact` asks the count_tokens API instead.
 *
 * No runtime imports: the web UI uses this module too.
 */

export interface ContextCost {
  /** Estimated tokens for everything this message puts in context. */
  tokens: number;
  /** Per-tool costs for tools/list responses. */
  tools?: ToolCost[];
  /** Number of images, whose cost is included in `tokens`. */
  images?: number;
}

export interface ToolCost {
  name: string;
  tokens: number;
}

/** A tool definition as the agent passes it to the model. */
export interface ModelToolDefinition {
  name: string;
  description?: string;
  input_schema: unknown;
}

/**
 * ~3.5 ASCII characters per token is typical for the JSON, code and English
 * that MCP traffic carries; other scripts run close to a token per character.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) ascii++;
    else if (code < 0xdc00 || code > 0xdfff) other++; // count surrogate pairs once
  }
  return Math.ceil(ascii / 3.5 + other);
}

/**
 * Claude scales images so the long edge is at most 1568px and the area at
 * most ~1.15 megapixels, then charges about one token per 750 pixels.
 */
export function estimateImageTokens(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 0;
  const scale = Math.min(1, 1568 / Math.max(width, height), Math.sqrt(1_150_000 / (width * height)));
  return Math.ceil((width * scale * (height * scale)) / 750);
}

/** Converts MCP tool definitions to the shape a model API receives. */
export function toModelTools(tools: unknown[]): ModelToolDefinition[] {
  return tools.filter(isObject).map((tool) => ({
    name: String(tool.name),
    ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
    input_schema: tool.inputSchema ?? { type: 'object' },
  }));
}

/**
 * The context cost of a response: tool definitions from tools/list, content
 * from tools/call, resources/read and prompts/get. Null for everything else.
 */
export function contextCost(method: string | null, responsePayload: string): ContextCost | null {
  if (method === null) return null;
  let message: unknown;
  try {
    message = JSON.parse(responsePayload);
  } catch {
    return null;
  }
  if (!isObject(message) || !isObject(message.result)) {
    // Errors still reach the model, as text.
    if (isObject(message) && isObject(message.error) && method === 'tools/call') {
      return { tokens: estimateTokens(String(message.error.message ?? '')) };
    }
    return null;
  }
  const result = message.result;

  switch (method) {
    case 'tools/list': {
      if (!Array.isArray(result.tools)) return null;
      const tools = toModelTools(result.tools).map((tool) => ({
        name: tool.name,
        tokens: estimateTokens(JSON.stringify(tool)),
      }));
      return { tokens: tools.reduce((sum, tool) => sum + tool.tokens, 0), tools };
    }
    case 'tools/call':
      return Array.isArray(result.content) ? contentCost(result.content) : null;
    case 'prompts/get':
      return Array.isArray(result.messages)
        ? contentCost(result.messages.filter(isObject).map((entry) => entry.content))
        : null;
    case 'resources/read':
      return Array.isArray(result.contents)
        ? contentCost(result.contents.filter(isObject).map((entry) => ({ type: 'resource', resource: entry })))
        : null;
    default:
      return null;
  }
}

/** Cost of MCP content blocks (text, image, audio, resource, resource_link). */
export function contentCost(blocks: unknown[]): ContextCost {
  let tokens = 0;
  let images = 0;
  for (const block of blocks) {
    if (!isObject(block)) continue;
    switch (block.type) {
      case 'text':
        tokens += estimateTokens(String(block.text ?? ''));
        break;
      case 'image': {
        images++;
        const size = typeof block.data === 'string' ? imageSize(block.data) : null;
        // Unknown dimensions: assume a mid-sized image.
        tokens += size ? estimateImageTokens(size.width, size.height) : 1000;
        break;
      }
      case 'resource': {
        const resource = isObject(block.resource) ? block.resource : {};
        if (typeof resource.text === 'string') tokens += estimateTokens(resource.text);
        else if (typeof resource.blob === 'string') tokens += estimateTokens(resource.blob);
        break;
      }
      default:
        tokens += estimateTokens(JSON.stringify(block));
    }
  }
  return images > 0 ? { tokens, images } : { tokens };
}

/** Width and height of a base64 PNG, GIF, JPEG or WebP, read from its header. */
export function imageSize(base64: string): { width: number; height: number } | null {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(base64);
  } catch {
    return null;
  }
  const at = (index: number) => bytes[index] ?? 0;
  const u16be = (index: number) => (at(index) << 8) | at(index + 1);
  const u16le = (index: number) => at(index) | (at(index + 1) << 8);
  const u32be = (index: number) => ((at(index) << 24) | (at(index + 1) << 16) | (at(index + 2) << 8) | at(index + 3)) >>> 0;

  // PNG: IHDR is the first chunk.
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { width: u32be(16), height: u32be(20) };
  }
  // GIF87a / GIF89a
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) {
    return { width: u16le(6), height: u16le(8) };
  }
  // JPEG: walk segments to the first start-of-frame marker.
  if (at(0) === 0xff && at(1) === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (at(offset) !== 0xff) return null;
      const marker = at(offset + 1);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: u16be(offset + 7), height: u16be(offset + 5) };
      }
      offset += 2 + u16be(offset + 2);
    }
    return null;
  }
  // WebP (RIFF....WEBP), lossy VP8 and lossless VP8L
  if (at(0) === 0x52 && at(1) === 0x49 && at(8) === 0x57 && at(9) === 0x45) {
    const chunk = String.fromCharCode(at(12), at(13), at(14), at(15));
    if (chunk === 'VP8 ') return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') {
      return { width: 1 + (at(24) | (at(25) << 8) | (at(26) << 16)), height: 1 + (at(27) | (at(28) << 8) | (at(29) << 16)) };
    }
  }
  return null;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.round(tokens / 1000)}k`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
