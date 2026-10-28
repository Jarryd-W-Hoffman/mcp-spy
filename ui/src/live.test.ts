import { describe, expect, it } from 'vitest';
import type { MessageSummary } from '../../src/types.js';
import { mergeMessages } from './live';

const message = (id: number, session_id: number) => ({ id, session_id }) as MessageSummary;
const ids = (messages: MessageSummary[]) => messages.map((m) => m.id);

describe('mergeMessages', () => {
  it('adds an older session’s messages in id order', () => {
    const { messages } = mergeMessages([message(10, 2), message(11, 2)], [message(1, 1), message(2, 1)], 1);
    expect(ids(messages)).toEqual([1, 2, 10, 11]);
  });

  it('drops the oldest messages beyond the limit, except the selected session’s', () => {
    const held = [message(1, 1), message(2, 2), message(3, 1), message(4, 2)];
    const { messages, dropped } = mergeMessages(held, [message(5, 2), message(6, 2)], 1, 3);
    expect(ids(messages)).toEqual([1, 3, 4, 5, 6]);
    expect(ids(dropped)).toEqual([2]);
  });

  it('drops the oldest when no session is selected', () => {
    const { messages, dropped } = mergeMessages([message(1, 1), message(2, 1)], [message(3, 2)], null, 2);
    expect(ids(messages)).toEqual([2, 3]);
    expect(ids(dropped)).toEqual([1]);
  });
});
