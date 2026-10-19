import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readPasswordFromStdin, validatePasswordInput } from '../server/password-input.js';

test('password pipe preserves spaces, punctuation and chunked input', async () => {
  const parts = ['  safe-test-', 'password!\\$', '  '];
  assert.equal(await readPasswordFromStdin(Readable.from(parts)), parts.join(''));
});
test('password bounds accept 12 and 256 characters', () => {
  assert.doesNotThrow(() => validatePasswordInput('a'.repeat(12)));
  assert.doesNotThrow(() => validatePasswordInput('a'.repeat(256)));
});
test('empty and short input reports only length, never the password', async () => {
  for (const value of ['', 'short', 'a'.repeat(257)]) {
    await assert.rejects(readPasswordFromStdin(Readable.from([value])), error => {
      assert.match(error.message, new RegExp(`Received ${value.length} characters`));
      if (value) assert.ok(!error.message.includes(value));
      return true;
    });
  }
});
test('newline and excessive pipe input are rejected', async () => {
  await assert.rejects(readPasswordFromStdin(Readable.from(['safe-test-password\n'])), /single line/);
  await assert.rejects(readPasswordFromStdin(Readable.from(['x'.repeat(4097)])), /size limit/);
});
