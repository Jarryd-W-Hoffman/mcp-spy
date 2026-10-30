/**
 * Removes secrets from what mcpspy records, before it reaches the log. Only
 * the record changes: the agent and server still exchange the real values.
 */
export const REDACTED = '[REDACTED]';

/** A flag or variable name that holds a secret: api-key, GITHUB_TOKEN, client_secret, … */
const SECRET_NAME = '[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd)';
/** A flag whose value is the next argument: --token <secret>. */
const SECRET_FLAG = new RegExp(`^--?${SECRET_NAME}$`, 'i');

/** Well-known credential formats, as [pattern, replacement]. */
const BUILT_IN: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Needs a digit, +, / or =, so prose such as "Basic authentication" is left alone.
  [/\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{12,}/g, `$1 ${REDACTED}`],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bxapp-[0-9]+-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, REDACTED],
  [/\bhf_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // user:password@ in URLs, and secrets in query strings.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@"]+:)[^@/\s"]+@/gi, `$1${REDACTED}@`],
  [/([?&](?:access_token|api[_-]?key|apikey|token|secret|password|sig|signature)=)[^&#\s"]+/gi, `$1${REDACTED}`],
  // Assignments to secret names: --api-key=…, GITHUB_TOKEN=…, DB_PASSWORD=…. Short values,
  // such as progressToken=5, are left alone.
  [new RegExp(`(\\b${SECRET_NAME}=)[^\\s"'&]{8,}`, 'gi'), `$1${REDACTED}`],
];

/** JSON keys whose values are secrets, compared lowercase without - and _. */
const SECRET_KEYS = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'sessiontoken',
  'apikey',
  'xapikey',
  'authorization',
  'cookie',
  'setcookie',
  'privatekey',
]);

export interface RedactOptions {
  /** The built-in credential formats and secret keys (default true). */
  builtIn?: boolean;
  /** Extra patterns; whatever they match is replaced. */
  patterns?: RegExp[];
}

export class Redactor {
  private readonly rules: [RegExp, string][];
  private readonly secretKeys: boolean;

  constructor(options: RedactOptions = {}) {
    const builtIn = options.builtIn ?? true;
    const extra = (options.patterns ?? []).map((pattern): [RegExp, string] => [
      new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
      REDACTED,
    ]);
    this.rules = [...(builtIn ? BUILT_IN : []), ...extra];
    this.secretKeys = builtIn;
  }

  /** Whether this redactor changes anything at all. */
  get active(): boolean {
    return this.rules.length > 0;
  }

  /** Redacts plain text: stderr lines, command lines, anything not JSON. */
  text(value: string): string {
    let result = value;
    for (const [pattern, replacement] of this.rules) result = result.replace(pattern, replacement);
    return result;
  }

  /** Redacts a command line, argument by argument, including the value after a flag such as --token. */
  args(parts: string[]): string[] {
    return parts.map((part, index) =>
      this.secretKeys && index > 0 && SECRET_FLAG.test(parts[index - 1]!) && part !== '' ? REDACTED : this.text(part),
    );
  }

  /**
   * Redacts a JSON payload: every string value, and whole values under secret
   * keys. Returns the input unchanged (byte for byte) when nothing is secret,
   * and falls back to text redaction when it isn't JSON.
   */
  json(payload: string): string {
    if (!this.active) return payload;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return this.text(payload);
    }
    let changed = false;
    const walk = (value: unknown, key: string | null): unknown => {
      if (key !== null && this.secretKeys && isSecretKey(key) && (typeof value === 'string' || typeof value === 'number') && value !== '') {
        changed = true;
        return REDACTED;
      }
      if (typeof value === 'string') {
        const redacted = this.text(value);
        if (redacted !== value) changed = true;
        return redacted;
      }
      if (Array.isArray(value)) return value.map((item) => walk(item, null));
      if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, walk(item, name)]));
      }
      return value;
    };
    const result = walk(parsed, null);
    return changed ? JSON.stringify(result) : payload;
  }
}

function isSecretKey(key: string): boolean {
  return SECRET_KEYS.has(key.toLowerCase().replace(/[-_]/g, ''));
}

/** Compiles --redact patterns, explaining any that aren't valid regular expressions. */
export function compilePatterns(sources: string[]): RegExp[] {
  return sources.map((source) => {
    try {
      return new RegExp(source, 'g');
    } catch (error) {
      throw new Error(`--redact ${JSON.stringify(source)} is not a valid regular expression: ${(error as Error).message}`);
    }
  });
}
