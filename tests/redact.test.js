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

test('redactText fully removes bare long tokens (sk-/AKIA/ghp_/JWT)', () => {
  const input = 'key sk-abcdefghij1234567890 and ghp_abcdefghijklmnopqrstuvwx and eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3ODkwIn0.eyJ0b2tlbiI6InRydWUifX0';
  const output = redactText(input);
  assert.equal(output.includes('sk-abcdefghij1234567890'), false);
  assert.equal(output.includes('ghp_abcdefghijklmnopqrstuvwx'), false);
  assert.equal(output.includes('eyJhbGciOiJIUzI1NiIs'), false);
});
