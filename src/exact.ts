import Anthropic from '@anthropic-ai/sdk';
import { toModelTools, type ToolCost } from './tokens.js';

/**
 * Exact token counts from the Anthropic count_tokens endpoint. Opt-in: it
 * sends recorded tool definitions and results to the API.
 *
 * The endpoint counts whole requests, so each cost is a difference between
 * two counts that differ only in the part being measured.
 */
export class ExactCounter {
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic();
  }

  /**
   * Cost of a tool list: the total (including the fixed tool-use preamble the
   * API adds whenever tools are present) and each tool's own share, measured
   * by leaving it out.
   */
  async toolDefinitions(mcpTools: unknown[]): Promise<{ total: number; overhead: number; tools: ToolCost[] }> {
    const tools = toModelTools(mcpTools) as Anthropic.Tool[];
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'hi' }];

    const baseline = await this.count({ messages });
    const all = await this.count({ messages, tools });
    const costs: ToolCost[] = [];
    for (const tool of tools) {
      const without = tools.length > 1 ? await this.count({ messages, tools: tools.filter((other) => other !== tool) }) : baseline;
      costs.push({ name: tool.name, tokens: all - without });
    }
    const total = all - baseline;
    return { total, overhead: total - costs.reduce((sum, cost) => sum + cost.tokens, 0), tools: costs };
  }

  /** Cost of a tool result's content, as a tool_result block in a conversation. */
  async toolResult(toolName: string, mcpContent: unknown[], isError = false): Promise<number> {
    const tools: Anthropic.Tool[] = [{ name: toolName, input_schema: { type: 'object' } }];
    const conversation = (content: Anthropic.ToolResultBlockParam['content']): Anthropic.MessageParam[] => [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_mcpspy', name: toolName, input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mcpspy', content, is_error: isError }] },
    ];
    const empty = await this.count({ messages: conversation([]), tools });
    const full = await this.count({ messages: conversation(toResultContent(mcpContent)), tools });
    return full - empty;
  }

  private async count(params: Omit<Anthropic.MessageCountTokensParams, 'model'>): Promise<number> {
    const response = await this.client.messages.countTokens({ model: this.model, ...params });
    return response.input_tokens;
  }
}

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** MCP content blocks as the tool_result content an agent would send. */
export function toResultContent(blocks: unknown[]): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  return blocks.flatMap((block): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> => {
    if (typeof block !== 'object' || block === null) return [];
    const item = block as Record<string, unknown>;
    if (item.type === 'text') return [{ type: 'text', text: String(item.text ?? '') }];
    if (item.type === 'image' && typeof item.data === 'string' && IMAGE_TYPES.has(String(item.mimeType))) {
      return [
        {
          type: 'image',
          source: { type: 'base64', media_type: item.mimeType as 'image/png', data: item.data },
        },
      ];
    }
    if (item.type === 'resource' && typeof item.resource === 'object' && item.resource !== null) {
      const resource = item.resource as Record<string, unknown>;
      if (typeof resource.text === 'string') return [{ type: 'text', text: resource.text }];
    }
    return [{ type: 'text', text: JSON.stringify(item) }];
  });
}

/** A readable explanation for API failures, using the SDK's typed errors. */
export function describeApiError(error: unknown): string {
  if (error instanceof Anthropic.AuthenticationError) {
    return 'authentication failed: set ANTHROPIC_API_KEY or run `ant auth login`';
  }
  if (error instanceof Anthropic.NotFoundError) return `model not found: ${error.message}`;
  if (error instanceof Anthropic.RateLimitError) return 'rate limited by the count_tokens endpoint; try again shortly';
  if (error instanceof Anthropic.APIError) return `API error ${error.status ?? ''}: ${error.message}`.trim();
  // Raised before any request, e.g. when no credentials are configured.
  if (error instanceof Anthropic.AnthropicError) {
    return `${error.message}\nSet ANTHROPIC_API_KEY or run \`ant auth login\`.`;
  }
  return error instanceof Error ? error.message : String(error);
}
