import { Ajv, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

import type { Issue } from './types.js';

export type { Issue } from './types.js';

// ajv-formats is CommonJS; its default export arrives wrapped under NodeNext.
const addFormats = ((addFormatsModule as unknown as { default?: typeof addFormatsModule }).default ?? addFormatsModule) as unknown as (
  ajv: Ajv | Ajv2020,
) => void;

/**
 * JSON Schema validators for both dialects MCP servers use: draft-07 (what
 * most zod-generated schemas declare) and 2020-12 (the spec's default when a
 * schema names none). Compiled schemas are cached by their text.
 */
class SchemaCompiler {
  private readonly draft7 = new Ajv({ strict: false, allErrors: true, validateSchema: true });
  private readonly draft2020 = new Ajv2020({ strict: false, allErrors: true, validateSchema: true });
  private readonly cache = new Map<string, ValidateFunction | Error>();

  constructor() {
    addFormats(this.draft7);
    addFormats(this.draft2020);
  }

  compile(schema: unknown): ValidateFunction | Error {
    const key = JSON.stringify(schema);
    let compiled = this.cache.get(key);
    if (!compiled) {
      const $schema = typeof schema === 'object' && schema !== null ? (schema as { $schema?: unknown }).$schema : undefined;
      const ajv = typeof $schema === 'string' && /draft-0[4-7]/.test($schema) ? this.draft7 : this.draft2020;
      try {
        // Strip $schema so a draft URL either instance doesn't know can't break compilation.
        const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
        compiled = ajv.compile(rest);
      } catch (error) {
        compiled = error as Error;
      }
      this.cache.set(key, compiled);
    }
    return compiled;
  }
}

const compiler = new SchemaCompiler();

interface ToolSchemas {
  input: ValidateFunction | Error | null;
  output: ValidateFunction | Error | null;
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/**
 * Checks one session's traffic against what its server declared: tool
 * arguments against inputSchema, results against outputSchema and the MCP
 * content rules, and the tool list itself.
 */
export class SessionValidator {
  private tools = new Map<string, ToolSchemas>();

  /**
   * Validates a tools/list result and remembers its schemas. A later page (the
   * request sent a cursor) adds to the tools seen so far instead of replacing them.
   */
  toolList(result: unknown, laterPage = false): Issue[] {
    const issues: Issue[] = [];
    if (!isObject(result) || !Array.isArray(result.tools)) {
      return [error('result.tools', 'tools/list result must have a tools array')];
    }

    const tools = laterPage ? new Map(this.tools) : new Map<string, ToolSchemas>();
    result.tools.forEach((tool, index) => {
      const at = `result.tools[${index}]`;
      if (!isObject(tool) || typeof tool.name !== 'string') {
        issues.push(error(at, 'tool must be an object with a string name'));
        return;
      }
      const where = `result.tools[name=${JSON.stringify(tool.name)}]`;
      if (tools.has(tool.name)) issues.push(error(where, `duplicate tool name "${tool.name}"`));
      if (!TOOL_NAME.test(tool.name)) {
        issues.push(warning(`${where}.name`, 'tool names should be 1–128 characters of A–Z, a–z, 0–9, _, - and .'));
      }

      const input = this.declaredSchema(tool.inputSchema, `${where}.inputSchema`, issues, true);
      const output = this.declaredSchema(tool.outputSchema, `${where}.outputSchema`, issues, false);
      tools.set(tool.name, { input, output });
    });

    this.tools = tools;
    return issues;
  }

  private declaredSchema(schema: unknown, path: string, issues: Issue[], required: boolean): ValidateFunction | Error | null {
    if (schema === undefined) {
      if (required) issues.push(error(path, 'inputSchema is required'));
      return null;
    }
    if (!isObject(schema) || schema.type !== 'object') {
      issues.push(error(path, 'schema must be a JSON Schema object with type "object"'));
    }
    if (!isObject(schema)) return null;
    const compiled = compiler.compile(schema);
    if (compiled instanceof Error) issues.push(error(path, `invalid JSON Schema: ${compiled.message}`));
    return compiled;
  }

  /** Validates a tools/call request's arguments against the tool's inputSchema. */
  toolCall(params: unknown): Issue[] {
    if (!isObject(params) || typeof params.name !== 'string') return [error('params.name', 'tools/call needs a tool name')];
    if (this.tools.size === 0) return []; // no tools/list seen yet
    const tool = this.tools.get(params.name);
    if (!tool) return [error('params.name', `"${params.name}" is not in the server's tool list`)];
    if (!tool.input || tool.input instanceof Error) return [];

    const args = params.arguments ?? {};
    if (tool.input(args)) return [];
    return schemaIssues(tool.input, 'params.arguments');
  }

  /** Validates a tools/call result: MCP content rules, then outputSchema. */
  toolResult(toolName: string | null, result: unknown): Issue[] {
    if (!isObject(result)) return [error('result', 'tools/call result must be an object')];
    const issues: Issue[] = [];

    if (!Array.isArray(result.content)) issues.push(error('result.content', 'tools/call result must have a content array'));
    else result.content.forEach((block, index) => issues.push(...contentBlockIssues(block, `result.content[${index}]`)));
    if (result.isError !== undefined && typeof result.isError !== 'boolean') {
      issues.push(error('result.isError', 'isError must be a boolean'));
    }

    const output = toolName !== null ? this.tools.get(toolName)?.output : null;
    if (output && !(output instanceof Error) && result.isError !== true) {
      if (result.structuredContent === undefined) {
        issues.push(error('result.structuredContent', `${toolName} declares an outputSchema, so results must include structuredContent`));
      } else if (!output(result.structuredContent)) {
        issues.push(...schemaIssues(output, 'result.structuredContent'));
      }
    }
    return issues;
  }
}

function contentBlockIssues(block: unknown, path: string): Issue[] {
  if (!isObject(block)) return [error(path, 'content block must be an object')];
  const need = (field: string, type: 'string' | 'object') =>
    (type === 'object' ? isObject(block[field]) : typeof block[field] === type) ? [] : [error(`${path}.${field}`, `${block.type} content needs a ${type} "${field}"`)];

  switch (block.type) {
    case 'text':
      return need('text', 'string');
    case 'image':
    case 'audio':
      return [...need('data', 'string'), ...need('mimeType', 'string')];
    case 'resource_link':
      return [...need('uri', 'string'), ...need('name', 'string')];
    case 'resource': {
      const resource = block.resource;
      if (!isObject(resource)) return need('resource', 'object');
      const issues = typeof resource.uri === 'string' ? [] : [error(`${path}.resource.uri`, 'embedded resource needs a uri')];
      if (typeof resource.text !== 'string' && typeof resource.blob !== 'string') {
        issues.push(error(`${path}.resource`, 'embedded resource needs text or blob'));
      }
      return issues;
    }
    default:
      return [error(`${path}.type`, `unknown content type ${JSON.stringify(block.type)}`)];
  }
}

/** Ajv errors as issues, with JSON pointers turned into the dotted paths used elsewhere. */
function schemaIssues(validate: ValidateFunction, base: string): Issue[] {
  return (validate.errors ?? []).map((failure) => {
    const segments = failure.instancePath
      .split('/')
      .slice(1)
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));
    let path = base;
    for (const segment of segments) path += /^\d+$/.test(segment) ? `[${segment}]` : `.${segment}`;
    const detail =
      failure.keyword === 'additionalProperties'
        ? `unexpected property "${(failure.params as { additionalProperty: string }).additionalProperty}"`
        : failure.keyword === 'required'
          ? `missing required property "${(failure.params as { missingProperty: string }).missingProperty}"`
          : (failure.message ?? failure.keyword);
    return error(path, detail);
  });
}

function error(path: string, message: string): Issue {
  return { severity: 'error', path, message };
}

function warning(path: string, message: string): Issue {
  return { severity: 'warning', path, message };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The issues for one recorded message, given the session's validator and,
 * for responses, the tool the request called or whether it asked for a later
 * page of tools. Updates the validator when the message is a tool list.
 */
export function checkMessage(
  validator: SessionValidator,
  message: { direction: string; kind: string; method: string | null; payload: string },
  toolName: string | null,
  laterPage = false,
): Issue[] {
  if (message.method === null) return [];
  const isRequest = message.direction === 'client' && message.kind === 'request';
  const isReply = message.direction === 'server' && message.kind === 'response';
  if (!isRequest && !isReply) return [];
  if (isRequest && message.method !== 'tools/call') return [];
  if (isReply && message.method !== 'tools/call' && message.method !== 'tools/list') return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(message.payload) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (isRequest) return validator.toolCall(parsed.params);
  if (message.method === 'tools/list') return validator.toolList(parsed.result, laterPage);
  return validator.toolResult(toolName, parsed.result);
}

/** The tool name a tools/call request payload names, if any. */
export function calledTool(payload: string): string | null {
  try {
    const name = (JSON.parse(payload) as { params?: { name?: unknown } }).params?.name;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}
