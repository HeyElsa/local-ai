import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reasoningText, looksUnfinished } from '../public/stream.js';

test('spots answers that stopped before answering, and leaves real ones alone', () => {
  const plan = 'The big items are coming together — let me verify the earnings results and a couple of the other headline stories.';
  assert.equal(looksUnfinished({ content: plan, searches: 3 }), true);
  assert.equal(looksUnfinished({ content: plan, searches: 0 }), false);
  assert.equal(looksUnfinished({ content: 'Paris is the capital.', searches: 1 }), false);
  assert.equal(looksUnfinished({ content: 'Let me explain. Paris is the capital of France.', searches: 1 }), false);
  assert.equal(looksUnfinished({ content: `${'A long answer. '.repeat(40)}Let me know if you want more.`, searches: 3 }), false);
  assert.equal(looksUnfinished({ content: 'Cut off mid', finishReason: 'length' }), true);
  assert.equal(looksUnfinished({ content: '', finishReason: 'length' }), false);
});

test('reads every reasoning format and never duplicates', () => {
  assert.equal(reasoningText({ reasoning_content: 'a' }), 'a');
  assert.equal(reasoningText({ reasoning: 'b' }), 'b');
  assert.equal(reasoningText({ reasoning_details: [{ type: 'reasoning.text', text: 'c' }, { type: 'reasoning.summary', summary: 'd' }] }), 'cd');
  assert.equal(reasoningText({ reasoning: 'e', reasoning_details: [{ text: 'e' }] }), 'e');
});

test('ignores deltas with no readable reasoning', () => {
  assert.equal(reasoningText({ content: 'answer' }), '');
  assert.equal(reasoningText({ reasoning: null }), '');
  assert.equal(reasoningText({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'xyz' }] }), '');
  assert.equal(reasoningText(undefined), '');
});
