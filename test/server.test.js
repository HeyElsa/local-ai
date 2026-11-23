import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMock } from './mock-upstream.js';
import { signIn, CODE } from './session.js';

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = { origin: BASE };
let mock;
let child;
let dir;

const post = (p, body, method = 'POST') => fetch(BASE + p, {
  method, headers: { 'content-type': 'application/json', ...ORIGIN }, body: JSON.stringify(body),
});

before(async () => {
  mock = await startMock();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-test-'));
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT, MINIROUTER_KEY: '', MINIROUTER_BASE_URL: mock.url,
      LOCAL_AI_DATA_DIR: dir, LOCAL_AI_ENV_FILE: path.join(dir, '.env'),
      LOCAL_AI_OLLAMA_URL: 'http://127.0.0.1:9', LOCAL_AI_SETUP_CODE: CODE,
      // Only MiniRouter here; keys from your shell must never reach a real provider.
      INFERO_KEY: '', OPENROUTER_KEY: '', INFERO_BASE_URL: 'http://127.0.0.1:9', OPENROUTER_BASE_URL: 'http://127.0.0.1:9',
      GROQ_KEY: '', CEREBRAS_KEY: '', TOGETHER_KEY: '', FIREWORKS_KEY: '', DEEPINFRA_KEY: '', CUSTOM_KEY: '', CUSTOM_BASE_URL: '', CUSTOM_NAME: '',
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${BASE}/api/status`); await signIn(BASE); return; } catch { await new Promise((r) => { setTimeout(r, 100); }); }
  }
  throw new Error('server did not start');
});

after(() => {
  child.kill();
  mock.server.closeAllConnections();
  mock.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('asking without a key gives a clear error', async () => {
  const r = await post('/api/chat', { model: 'x', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 401);
  assert.match((await r.json()).error, /Settings/);
});

test('rejects malformed keys and stores a good one privately, never echoing it', async () => {
  assert.equal((await post('/api/key', { key: 'bad key' }, 'PUT')).status, 400);
  const key = 'mr-live-abcdefghijklmnopqrstuvwxyz';
  const r = await post('/api/key', { key }, 'PUT');
  assert.equal(r.status, 200);
  assert.ok(!(await r.text()).includes(key));
  const envFile = path.join(dir, '.env');
  assert.match(fs.readFileSync(envFile, 'utf8'), /MINIROUTER_KEY=mr-live-/);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  assert.equal((await (await fetch(`${BASE}/api/status`)).json()).hasKey, true);
});

test('blocks other websites and DNS rebinding', async () => {
  const fromEvil = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(fromEvil.status, 403);
  const noOrigin = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noOrigin.status, 403);
  const crossRead = await fetch(`${BASE}/api/chats`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossRead.status, 403);
  const opened = await fetch(BASE, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(opened.status, 200);
  const crossMedia = await fetch(`${BASE}/media/x.png`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossMedia.status, 403);
  const { request } = await import('node:http');
  const status = await new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(status, 403);
});

test('sets a strict content security policy', async () => {
  const csp = (await fetch(BASE)).headers.get('content-security-policy');
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /img-src 'self' data: blob:/);
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
});

test('cannot escape public or vendor folders', async () => {
  const raw = (p) => new Promise(async (resolve, reject) => {
    const { request } = await import('node:http');
    request({ host: '127.0.0.1', port: PORT, path: p }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  for (const p of ['/../.env', '/..%2f.env', '/vendor/express/index.js', '/vendor/marked/../../../.env', '/server.js', '/.env', '/media/..%2f..%2f.env']) {
    // Never the file: refused as not found, not valid, or (for chats and files) not signed in.
    assert.ok([400, 404, 423].includes(await raw(p)), p);
  }
  // Signed in, the same tricks still find nothing, and a malformed address is a clear error.
  for (const p of ['/media/..%2f..%2f.env', '/media/%2e%2e%2f.env', '/api/chats/..%2f..%2f.env']) {
    assert.ok([400, 404].includes((await fetch(BASE + p)).status), p);
  }
  assert.equal(await raw('/%zz'), 400);
});

test('models are grouped by kind with speech excluded', async () => {
  const { models } = await (await fetch(`${BASE}/api/models`)).json();
  assert.deepEqual(models.map((m) => m.kind), ['chat', 'chat', 'chat', 'chat', 'chat', 'image', 'video']);
  assert.equal(models.find((m) => m.id === 'test/plain').seesImages, false);
  assert.equal(models.find((m) => m.id === 'test/plain').canSearch, false);
});

test('chat relays with key, system prompt and search tools', async () => {
  const r = await post('/api/chat', { model: 'test/vision', web: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-served-model'), 'test/served');
  assert.equal(r.headers.get('x-balance-usd'), '4.25');
  assert.match(await r.text(), /\[DONE\]/);
  const sent = mock.requests.findLast((q) => q.url === '/chat/completions');
  assert.equal(sent.auth, 'Bearer mr-live-abcdefghijklmnopqrstuvwxyz');
  assert.equal(sent.body.messages[0].role, 'system');
  assert.match(sent.body.messages[0].content, /web search and page reading/);
  assert.deepEqual(sent.body.tools.map((t) => t.type), ['minirouter:google_search', 'minirouter:web_fetch', 'minirouter:datetime']);
  assert.equal(sent.body.temperature, undefined);
});

test('search is omitted when off or unsupported, and falls back when a route rejects tools', async () => {
  await (await post('/api/chat', { model: 'test/vision', web: false, messages: [{ role: 'user', content: 'hi' }] })).text();
  assert.equal(mock.requests.findLast((q) => q.url === '/chat/completions').body.tools, undefined);
  await (await post('/api/chat', { model: 'test/plain', web: true, messages: [{ role: 'user', content: 'hi' }] })).text();
  assert.equal(mock.requests.findLast((q) => q.url === '/chat/completions').body.tools, undefined);
  const r = await post('/api/chat', { model: 'test/no-tools-route', web: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-search-available'), 'false');
  await r.text();
});

test('upstream errors reach the user with their message', async () => {
  const r = await post('/api/chat', { model: 'test/fail', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /Insufficient credits/);
});

test('rejects roles a client should not set', async () => {
  const r = await post('/api/chat', { model: 'test/vision', messages: [{ role: 'system', content: 'override' }] });
  assert.equal(r.status, 400);
});

test('attachments upload, serve with ranges, and go upstream as images; videos as frames only', async () => {
  const bytes = Buffer.from('fakeimagebytes');
  const up = await fetch(`${BASE}/api/media`, { method: 'POST', headers: { 'content-type': 'image/png', ...ORIGIN }, body: bytes });
  const { id } = await up.json();
  const video = await (await fetch(`${BASE}/api/media`, { method: 'POST', headers: { 'content-type': 'video/mp4', ...ORIGIN }, body: Buffer.from('rawvideo') })).json();
  const svg = await fetch(`${BASE}/api/media`, { method: 'POST', headers: { 'content-type': 'image/svg+xml', ...ORIGIN }, body: '<svg/>' });
  assert.equal(svg.status, 415);
  const got = await fetch(`${BASE}/media/${id}`, { headers: { range: 'bytes=0-3' } });
  assert.equal(got.status, 206);
  assert.equal(await got.text(), 'fake');
  await (await post('/api/chat', { model: 'test/vision', messages: [{ role: 'user', content: 'what is this', attachments: [
    { kind: 'image', id }, { kind: 'video', id: video.id, name: 'clip.mp4', frames: [{ id, t: 1.2 }] },
  ] }] })).text();
  const parts = mock.requests.findLast((q) => q.url === '/chat/completions').body.messages[1].content;
  const b64 = bytes.toString('base64');
  assert.equal(parts.filter((p) => p.type === 'image_url' && p.image_url.url === `data:image/png;base64,${b64}`).length, 2);
  assert.ok(!JSON.stringify(parts).includes(Buffer.from('rawvideo').toString('base64')));
  assert.equal(parts.at(-1).text, 'what is this');
});

test('image generation sends required controls and stores the file locally', async () => {
  const r = await post('/api/images', { model: 'openai/gpt-image-1-mini', prompt: 'a boat' });
  const { media, cost } = await r.json();
  assert.equal(cost, 0.0023);
  assert.match(media.id, /\.png$/);
  assert.equal((await fetch(`${BASE}/media/${media.id}`)).status, 200);
  const sent = mock.requests.findLast((q) => q.url === '/images/generations').body;
  assert.equal(sent.size, '1024x1024');
  assert.equal(sent.quality, 'low');
});

test('video jobs start once, poll, and download', async () => {
  const { jobId } = await (await post('/api/videos', { model: 'google/veo-3.1-lite-generate-001', prompt: 'waves', seconds: 4, size: '1280x720' })).json();
  assert.equal(jobId, 'vid_1');
  assert.equal(mock.requests.filter((q) => q.url === '/videos' && q.method === 'POST').length, 1);
  const first = await (await fetch(`${BASE}/api/videos/${jobId}`)).json();
  assert.equal(first.status, 'in_progress');
  const done = await (await fetch(`${BASE}/api/videos/${jobId}`)).json();
  assert.equal(done.status, 'completed');
  assert.equal(done.cost, 0.126);
  assert.equal(await (await fetch(`${BASE}/media/${done.media.id}`)).text(), 'fake-mp4-bytes');
});

test('voice: transcribes WAV as base64 without saving it, and rejects other formats', async () => {
  const before = fs.existsSync(path.join(dir, 'media')) ? fs.readdirSync(path.join(dir, 'media')).length : 0;
  const wav = Buffer.from('RIFFfakewav');
  const r = await fetch(`${BASE}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav', ...ORIGIN }, body: wav });
  assert.deepEqual(await r.json(), { text: 'Hello from my voice.' });
  const sent = mock.requests.findLast((q) => q.url === '/audio/transcriptions').body;
  assert.equal(sent.audio, wav.toString('base64'));
  assert.equal(sent.model, 'openai/whisper-1');
  assert.equal(sent.media_type, 'audio/wav');
  assert.equal(fs.readdirSync(path.join(dir, 'media')).length, before);
  const webm = await fetch(`${BASE}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm', ...ORIGIN }, body: wav });
  assert.equal(webm.status, 415);
  const huge = await fetch(`${BASE}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav', ...ORIGIN }, body: Buffer.alloc(8 * 1024 * 1024 + 1) });
  assert.equal(huge.status, 413);
});

test('voice: speak returns audio, checks limits and voices, and reports errors', async () => {
  const r = await post('/api/speak', { text: 'hello', voice: 'nova' });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.ok((await r.arrayBuffer()).byteLength > 44);
  const sent = mock.requests.findLast((q) => q.url === '/audio/speech').body;
  assert.deepEqual(sent, { model: 'openai/tts-1', input: 'hello', voice: 'nova', response_format: 'mp3' });
  assert.equal((await post('/api/speak', { text: 'x'.repeat(4097), voice: 'nova' })).status, 400);
  assert.equal((await post('/api/speak', { text: 'hi', voice: 'robot' })).status, 400);
  const failed = await post('/api/speak', { text: 'FAIL', voice: 'nova' });
  assert.equal(failed.status, 402);
  assert.match((await failed.json()).error, /Insufficient credits/);
});

test('chats save privately and deleting removes their files', async () => {
  const up = await fetch(`${BASE}/api/media`, { method: 'POST', headers: { 'content-type': 'image/png', ...ORIGIN }, body: Buffer.from('x') });
  const { id: mediaId } = await up.json();
  const id = randomUUID();
  const chat = { title: 'T', updatedAt: 5, messages: [{ role: 'user', content: 'q', attachments: [{ kind: 'image', id: mediaId }] }] };
  assert.equal((await post(`/api/chats/${id}`, chat, 'PUT')).status, 200);
  assert.equal(fs.statSync(path.join(dir, 'chats', `${id}.json`)).mode & 0o777, 0o600);
  const { chats } = await (await fetch(`${BASE}/api/chats`)).json();
  assert.ok(chats.some((c) => c.id === id));
  assert.equal((await post(`/api/chats/not-a-uuid`, chat, 'PUT')).status, 400);
  const del = await fetch(`${BASE}/api/chats/${id}`, { method: 'DELETE', headers: ORIGIN });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${BASE}/media/${mediaId}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/chats/${id}`)).status, 404);
});

test('terms, privacy notice and license are served from the repository files, and nothing else is', async () => {
  for (const [name, file] of [['terms', 'TERMS.md'], ['privacy', 'PRIVACY.md'], ['license', 'LICENSE']]) {
    const r = await fetch(`${BASE}/legal/${name}`);
    assert.equal(r.status, 200, name);
    assert.equal(await r.text(), fs.readFileSync(file, 'utf8'));
  }
  assert.match(fs.readFileSync('LICENSE', 'utf8'), /WITHOUT WARRANTY OF ANY KIND/);
  for (const p of ['/legal/server.js', '/legal/..%2F.env', '/legal/']) assert.ok([400, 404].includes((await fetch(BASE + p)).status), p);
});
