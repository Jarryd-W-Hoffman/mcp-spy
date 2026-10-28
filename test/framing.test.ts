import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../src/framing.js';

function collect(): { lines: string[]; splitter: LineSplitter } {
  const lines: string[] = [];
  return { lines, splitter: new LineSplitter((line) => lines.push(line)) };
}

describe('LineSplitter', () => {
  it('emits one line per newline', () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('reassembles lines split across chunks', () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":');
    splitter.push('1}\n{"b"');
    expect(lines).toEqual(['{"a":1}']);
    splitter.push(':2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('does not corrupt multi-byte characters split across chunks', () => {
    const { lines, splitter } = collect();
    const bytes = Buffer.from('{"emoji":"🚀"}\n');
    splitter.push(bytes.subarray(0, 12));
    splitter.push(bytes.subarray(12));
    expect(lines).toEqual(['{"emoji":"🚀"}']);
  });

  it('strips CR and skips blank lines', () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}\r\n\n  \n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('flushes a trailing frame without a newline', () => {
    const { lines, splitter } = collect();
    splitter.push('{"a":1}');
    expect(lines).toEqual([]);
    splitter.flush();
    expect(lines).toEqual(['{"a":1}']);
  });
});
