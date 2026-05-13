#!/usr/bin/env node
// Derive a Chrome extension ID from a base64-encoded DER RSA public
// key. Chrome computes the extension ID by SHA-256-hashing the
// public key bytes, taking the first 16 bytes (32 hex chars), then
// mapping each hex digit 0-9a-f to a-p.
//
// Pinning the manifest `key` field gives a stable extension ID
// across rebuilds so the operator can register one OAuth client per
// env in GCP without the ID drifting.
//
// Usage:
//   pnpm --filter @kindoo/extension ext-id -- --key <base64>
//   echo <base64> | pnpm --filter @kindoo/extension ext-id

import { createHash } from 'node:crypto';

const HEX = '0123456789abcdef';
const MAP = 'abcdefghijklmnop';

function readKeyArg(argv) {
  const flagIdx = argv.indexOf('--key');
  if (flagIdx !== -1 && argv[flagIdx + 1]) return argv[flagIdx + 1];
  return null;
}

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function computeId(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);
  let id = '';
  for (const ch of digest) id += MAP[HEX.indexOf(ch)];
  return id;
}

const flagKey = readKeyArg(process.argv.slice(2));
const stdinKey = flagKey ? null : await readStdin();
const key = flagKey ?? stdinKey;

if (!key) {
  console.error('Usage: compute-extension-id.mjs --key <base64>');
  console.error('       echo <base64> | compute-extension-id.mjs');
  process.exit(1);
}

process.stdout.write(`${computeId(key)}\n`);
