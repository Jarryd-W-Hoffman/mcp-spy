import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { contextCost, estimateImageTokens, estimateTokens, formatTokens, imageSize, toModelTools } from '../src/tokens.js';

function png(width: number, height: number): string {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12);
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return Buffer.concat([header, deflateSync(Buffer.alloc(4))]).toString('base64');
}

function jpeg(width: number, height: number): string {
  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const sof0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x00, 0x00, 0x00];
  return Buffer.from([0xff, 0xd8, ...app0, ...sof0, 0xff, 0xd9]).toString('base64');
}

describe('estimateTokens', () => {
  it('scales with text length', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(35))).toBe(10);
    expect(estimateTokens('日本語')).toBe(3);
    expect(estimateTokens('🚀')).toBe(1);
  });
});

describe('images', () => {
  it('reads PNG and JPEG dimensions', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
    expect(imageSize('bm90IGFuIGltYWdl')).toBeNull();
  });

  it('estimates image tokens with downscaling for large images', () => {
    expect(estimateImageTokens(750, 1)).toBe(1);
    expect(estimateImageTokens(1000, 1000)).toBe(1334);
    // Large images are capped at ~1.15MP.
    expect(estimateImageTokens(4000, 3000)).toBe(estimateImageTokens(8000, 6000));
    expect(estimateImageTokens(4000, 3000)).toBeLessThanOrEqual(1534);
  });
});

describe('contextCost', () => {
  const tools = [
    { name: 'search', description: 'Search the docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    { name: 'ping', inputSchema: { type: 'object' } },
  ];

  it('breaks tools/list down per tool', () => {
    const cost = contextCost('tools/list', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } }))!;
    expect(cost.tools!.map((tool) => tool.name)).toEqual(['search', 'ping']);
    expect(cost.tokens).toBe(cost.tools![0]!.tokens + cost.tools![1]!.tokens);
    expect(cost.tools![0]!.tokens).toBeGreaterThan(cost.tools![1]!.tokens);
  });

  it('converts MCP tools to model tool definitions', () => {
    expect(toModelTools(tools)).toEqual([
      { name: 'search', description: 'Search the docs', input_schema: tools[0]!.inputSchema },
      { name: 'ping', input_schema: { type: 'object' } },
    ]);
  });

  it('counts tool result text and images', () => {
    const result = {
      jsonrpc: '2.0',
      id: 2,
      result: { content: [{ type: 'text', text: 'x'.repeat(70) }, { type: 'image', mimeType: 'image/png', data: png(750, 2) }] },
    };
    expect(contextCost('tools/call', JSON.stringify(result))).toEqual({ tokens: 22, images: 1 });
  });

  it('counts tool errors, resources and prompts', () => {
    expect(contextCost('tools/call', '{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"bad bad bad"}}')).toEqual({ tokens: 4 });
    expect(contextCost('resources/read', JSON.stringify({ result: { contents: [{ uri: 'a', text: 'y'.repeat(7) }] } }))).toEqual({ tokens: 2 });
    expect(contextCost('prompts/get', JSON.stringify({ result: { messages: [{ role: 'user', content: { type: 'text', text: 'hello!!' } }] } }))).toEqual({ tokens: 2 });
  });

  it('ignores methods that do not reach the model', () => {
    expect(contextCost('initialize', '{"result":{}}')).toBeNull();
    expect(contextCost('tools/call', 'not json')).toBeNull();
  });
});

describe('formatTokens', () => {
  it('abbreviates thousands', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_340)).toBe('12.3k');
    expect(formatTokens(250_000)).toBe('250k');
  });
});

describe('estimates at the edges', () => {
  const bytes = (...values: number[]) => Buffer.from(values).toString('base64');
  const riff = (chunk: string, fill: (buffer: Buffer) => void) => {
    const buffer = Buffer.alloc(32);
    buffer.write('RIFF', 0);
    buffer.write('WEBP', 8);
    buffer.write(chunk, 12);
    fill(buffer);
    return buffer.toString('base64');
  };

  it('reads GIF and WebP sizes, and gives up on everything else', () => {
    expect(imageSize(Buffer.from('GIF89a\x02\x00\x03\x00', 'latin1').toString('base64'))).toEqual({ width: 2, height: 3 });
    expect(imageSize(Buffer.from('GIF', 'latin1').toString('base64'))).toEqual({ width: 0, height: 0 });
    expect(imageSize(riff('VP8 ', (b) => (b.writeUInt16LE(640, 26), b.writeUInt16LE(480, 28))))).toEqual({ width: 640, height: 480 });
    expect(imageSize(riff('VP8L', (b) => b.writeUInt32LE((99 << 14) | 199, 21)))).toEqual({ width: 200, height: 100 });
    expect(imageSize(riff('VP8X', (b) => (b.writeUIntLE(799, 24, 3), b.writeUIntLE(599, 27, 3))))).toEqual({ width: 800, height: 600 });
    expect(imageSize(riff('ALPH', () => {}))).toBeNull();
    expect(imageSize(Buffer.from('RIFF0000WAVE').toString('base64'))).toBeNull();
    expect(imageSize(Buffer.from('RI').toString('base64'))).toBeNull();
    expect(imageSize(Buffer.from('R').toString('base64'))).toBeNull();
    expect(imageSize(Buffer.from('GI').toString('base64'))).toBeNull();
    expect(imageSize(Buffer.from('G').toString('base64'))).toBeNull();
    expect(imageSize(Buffer.from('BM').toString('base64'))).toBeNull();
    expect(imageSize('!!not base64!!')).toBeNull();
    // JPEG without a frame header, and with a broken segment.
    expect(imageSize(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xe1, 0x00, 0x02, 0, 0))).toBeNull();
    expect(imageSize(bytes(0xff, 0xd8, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBeNull();
  });

  it('costs nothing for empty images and tolerates odd content', () => {
    expect(estimateImageTokens(0, 10)).toBe(0);
    expect(estimateImageTokens(10, 0)).toBe(0);
    expect(toModelTools([{ name: 'a' }, 'not a tool'])).toEqual([{ name: 'a', input_schema: { type: 'object' } }]);
    const cost = contextCost('tools/call', JSON.stringify({ result: { content: [
      'not a block',
      { type: 'text' },
      { type: 'image' },
      { type: 'image', data: Buffer.from('BM').toString('base64') },
      { type: 'resource', resource: 'nope' },
      { type: 'resource', resource: { blob: 'QUJD' } },
      { type: 'audio', data: 'x' },
    ] } }));
    expect(cost).toMatchObject({ images: 2 });
    expect(cost!.tokens).toBeGreaterThan(2000);
  });

  it('returns nothing for replies without the expected parts', () => {
    expect(contextCost(null, '{}')).toBeNull();
    expect(contextCost('tools/call', '{"error":{}}')).toEqual({ tokens: 0 });
    expect(contextCost('tools/list', '{"result":{}}')).toBeNull();
    expect(contextCost('tools/call', '{"result":{}}')).toBeNull();
    expect(contextCost('prompts/get', '{"result":{}}')).toBeNull();
    expect(contextCost('resources/read', '{"result":{}}')).toBeNull();
  });
});
