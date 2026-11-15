#!/usr/bin/env node
// Fetches Chert-provisioned LiveKit keys and writes them to .env.local.
// Usage: node scripts/setup-env.mjs [GEMINI_API_KEY]
// If GEMINI_API_KEY is already in .env.local it is preserved.

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env.local');

// Parse existing .env.local if it exists
const existing = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) existing[m[1]] = m[2];
  }
}

// Get Chert-provisioned LiveKit keys
let livekitOutput;
try {
  livekitOutput = execSync('npx @trychert/facetime@0.1.0-beta.21 livekit', {
    cwd: root,
    encoding: 'utf8',
  });
} catch (e) {
  console.error('Chert LiveKit not ready yet:', e.stderr || e.message);
  process.exit(1);
}

// Parse URL, API key, secret from output lines like: KEY=value
const parsed = {};
for (const line of livekitOutput.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.+)$/);
  if (m) parsed[m[1]] = m[2].trim();
}

if (!parsed.LIVEKIT_URL || !parsed.LIVEKIT_API_KEY || !parsed.LIVEKIT_API_SECRET) {
  // Try JSON output
  try {
    const json = JSON.parse(livekitOutput);
    if (json.url) parsed.LIVEKIT_URL = json.url;
    if (json.apiKey) parsed.LIVEKIT_API_KEY = json.apiKey;
    if (json.apiSecret) parsed.LIVEKIT_API_SECRET = json.apiSecret;
  } catch {}
}

const gemini = process.argv[2] || existing.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY_HERE';
const port = existing.PORT || '3000';

const content = [
  '# LiveKit — provisioned by Chert',
  `LIVEKIT_URL=${parsed.LIVEKIT_URL || existing.LIVEKIT_URL || 'wss://your-project.livekit.cloud'}`,
  `LIVEKIT_API_KEY=${parsed.LIVEKIT_API_KEY || existing.LIVEKIT_API_KEY || ''}`,
  `LIVEKIT_API_SECRET=${parsed.LIVEKIT_API_SECRET || existing.LIVEKIT_API_SECRET || ''}`,
  '',
  '# Gemini — from https://aistudio.google.com',
  `GEMINI_API_KEY=${gemini}`,
  '',
  `PORT=${port}`,
].join('\n') + '\n';

writeFileSync(envPath, content);
console.log('Wrote .env.local:');
console.log(content.replace(/SECRET=.+/, 'SECRET=***').replace(/KEY=AI.+/, 'KEY=***'));
