import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactText } from '../lib/redact.js';

test('redactText removes common secret material', () => {
  const input = [
    'api_key=super-secret-value',
    'Bearer abcdef1234567890',
    '-----BEGIN RSA PRIVATE KEY-----\nsecret\n-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const output = redactText(input);

  assert.equal(output.includes('super-secret-value'), false);
  assert.equal(output.includes('abcdef1234567890'), false);
  assert.equal(output.includes('-----BEGIN RSA PRIVATE KEY-----'), false);
  assert.equal(output.includes('[REDACTED]'), true);
});
