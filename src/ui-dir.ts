import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** dist/ui next to the compiled CLI, or the build output when running from source. */
export function resolveUiDir(base: string = import.meta.url): string | null {
  for (const candidate of ['./ui/', '../dist/ui/']) {
    const dir = fileURLToPath(new URL(candidate, base));
    if (existsSync(`${dir}index.html`)) return dir;
  }
  return null;
}
