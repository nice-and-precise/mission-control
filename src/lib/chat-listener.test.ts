import test from 'node:test';
import assert from 'node:assert/strict';
import { extractContent } from './chat-listener';

test('extractContent reads output_text segments from chat events', () => {
  const content = extractContent({
    role: 'assistant',
    content: [
      { type: 'output_text', text: 'VERIFY_FAIL: Missing integration tests' },
    ],
  });

  assert.equal(content, 'VERIFY_FAIL: Missing integration tests');
});

test('extractContent joins text and output_text segments', () => {
  const content = extractContent({
    role: 'assistant',
    content: [
      { type: 'text', text: 'TASK_COMPLETE: Built the feature' },
      { type: 'output_text', text: 'with tests and docs' },
    ],
  });

  assert.equal(content, 'TASK_COMPLETE: Built the feature\nwith tests and docs');
});
