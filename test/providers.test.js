// Infero first, MiniRouter and OpenRouter second: routing, keys, voice and privacy.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';
import { signIn, CODE } from './session.js';
import { startInfero, startOpenRouter } from './mock-providers.js';
import { routeFor, providerOf, upstreamId } from '../public/routing.js';

const KEYS = {
  INFERO_KEY: 'sk-infero-abcdefghijklmnop',
  MINIROUTER_KEY: 'mr-live-abcdefghijklmnopqrstuvwxyz',
  OPENROUTER_KEY: 'sk-or-v1-abcdefghijklmnop',
};
let mini; let infero; let openrouter; let downInfero;
const servers = [];

async function launch(port, keys, { inferoUrl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-providers-'));
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT: port, LOCAL_AI_SETUP_CODE: CODE, LOCAL_AI_DATA_DIR: dir, LOCAL_AI_ENV_FILE: path.join(dir, '.env'),
      LOCAL_AI_OLLAMA_URL: 'http://127.0.0.1:9',
      MINIROUTER_BASE_URL: mini.url, INFERO_BASE_URL: inferoUrl || infero.url, OPENROUTER_BASE_URL: openrouter.url,
      INFERO_KEY: '', MINIROUTER_KEY: '', OPENROUTER_KEY: '',
      GROQ_KEY: '', CEREBRAS_KEY: '', TOGETHER_KEY: '', FIREWORKS_KEY: '', DEEPINFRA_KEY: '', CUSTOM_KEY: '', CUSTOM_BASE_URL: '', CUSTOM_NAME: '',
      ...Object.fromEntries(keys.map((k) => [k, KEYS[k]])),
    },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  servers.push({ child, dir });
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => { setTimeout(r, 100); }); }
  }
  await signIn(base);
  const headers = { 'content-type': 'application/json', origin: base };
  return {
    base, dir,
    send: (p, body, method = 'POST') => fetch(base + p, { method, headers, body: JSON.stringify(body) }),
    get: (p) => fetch(base + p),
    wav: (bytes) => fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav', origin: base }, body: bytes }),
  };
}

const ask = (app, model, web) => app.send('/api/chat', { model, web, messages: [{ role: 'user', content: 'hi' }] });
const last = (mock, url) => mock.requests.findLast((q) => q.url === url);
const count = (mock, url) => mock.requests.filter((q) => q.url === url).length;

let all; let inferoOnly; let inferoAndOpenRouter; let openRouterOnly; let inferoDown;

before(async () => {
  [mini, infero, openrouter, downInfero] = await Promise.all([startMock(), startInfero(), startOpenRouter(), startInfero({ failModels: true })]);
  [all, inferoOnly, inferoAndOpenRouter, openRouterOnly, inferoDown] = await Promise.all([
    launch(4391, ['INFERO_KEY', 'MINIROUTER_KEY', 'OPENROUTER_KEY']),
    launch(4392, ['INFERO_KEY']),
    launch(4393, ['INFERO_KEY', 'OPENROUTER_KEY']),
    launch(4394, ['OPENROUTER_KEY']),
    launch(4395, ['INFERO_KEY', 'MINIROUTER_KEY'], { inferoUrl: downInfero.url }),
  ]);
});

after(() => {
  for (const { child, dir } of servers) { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  for (const m of [mini, infero, openrouter, downInfero]) { m.server.closeAllConnections(); m.server.close(); }
});

test('model IDs carry their provider, and unprefixed IDs are MiniRouter for older chats', () => {
  assert.equal(providerOf('infero:deepseek-v4-flash').id, 'infero');
  assert.equal(providerOf('openrouter:openai/gpt-5').id, 'openrouter');
  assert.equal(providerOf('openai/gpt-5').id, 'minirouter');
  assert.equal(providerOf('minirouter/auto').id, 'minirouter');
  assert.equal(upstreamId('openrouter:openai/gpt-5'), 'openai/gpt-5');
  assert.equal(upstreamId('openai/gpt-5'), 'openai/gpt-5');
});

test('routing hands search off only when the provider cannot search', () => {
  const keys = { infero: true, minirouter: true, openrouter: true };
  assert.deepEqual(routeFor('infero:x', false, { keys }), { model: 'infero:x', search: false });
  assert.deepEqual(routeFor('infero:x', true, { keys }), { model: 'minirouter/auto', search: true, handedOff: 'minirouter' });
  assert.deepEqual(routeFor('infero:x', true, { keys: { infero: true, openrouter: true } }), { model: 'openrouter:openrouter/auto', search: true, handedOff: 'openrouter' });
  assert.deepEqual(routeFor('infero:x', true, { keys: { infero: true } }), { model: 'infero:x', search: false });
  assert.deepEqual(routeFor('local/tiny', true, { keys }), { model: 'local/tiny', search: false });
  // A MiniRouter model that cannot search stays put, as before.
  assert.equal(routeFor('test/plain', true, { keys, models: [{ id: 'test/plain', canSearch: false }] }).model, 'test/plain');
});

test('status reports which keys exist without revealing them', async () => {
  const text = await (await all.get('/api/status')).text();
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key));
  const status = JSON.parse(text);
  assert.deepEqual([status.keys.infero, status.keys.minirouter, status.keys.openrouter, status.keys.groq], [true, true, true, false]);
  assert.equal(status.voices.via, 'infero');
  assert.ok(status.voices.list.some((v) => v.id === 'af_bella'));
  assert.equal((await (await openRouterOnly.get('/api/status')).json()).voices.via, 'openrouter');
});

test('models are listed Infero first, each provider in its own group', async () => {
  const { models } = await (await all.get('/api/models')).json();
  const order = [...new Set(models.map((m) => m.via))];
  assert.deepEqual(order, ['infero', 'minirouter', 'openrouter']);
  const flash = models.find((m) => m.id === 'infero:deepseek-v4-flash');
  assert.equal(flash.kind, 'chat');
  assert.equal(flash.canSearch, false);
  assert.ok(Math.abs(flash.input * 1e6 - 0.095) < 1e-9);
  assert.equal(models.find((m) => m.id === 'infero:llama-4-scout').seesImages, true);
  assert.equal(models.find((m) => m.id === 'infero:z-image-turbo').kind, 'image');
  assert.equal(models.find((m) => m.id === 'infero:z-image-turbo').imagePrice, 0.0106);
  assert.ok(!models.some((m) => m.id === 'infero:kokoro' || m.id === 'infero:whisper-large-v3-turbo'));
  const auto = models.find((m) => m.id === 'openrouter:openrouter/auto');
  assert.equal(auto.canSearch, true);
  assert.equal(auto.input, 0); // -1 means the price depends on the model it picks.
  assert.equal(models.find((m) => m.id === 'openrouter:google/gemini-2.5-flash-image').kind, 'image');
  // Without their keys, a provider's models are not listed at all.
  const only = (await (await inferoOnly.get('/api/models')).json()).models;
  assert.ok(only.length && only.every((m) => m.via === 'infero'));
});

test('one provider being down leaves the others listed', async () => {
  const { models } = await (await inferoDown.get('/api/models')).json();
  assert.ok(models.length);
  assert.ok(models.every((m) => m.via === 'minirouter'));
});

test('an Infero question goes to Infero with its key and no tools', async () => {
  const before = count(mini, '/chat/completions');
  const r = await ask(all, 'infero:deepseek-v4-flash', false);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-served-via'), 'infero');
  assert.equal(r.headers.get('x-served-model'), 'infero:deepseek-v4-flash');
  assert.equal(r.headers.get('x-balance-usd'), '7.50');
  assert.equal(r.headers.get('x-handed-off'), 'false');
  assert.match(await r.text(), /Hello from the provider/);
  const sent = last(infero, '/chat/completions');
  assert.equal(sent.auth, `Bearer ${KEYS.INFERO_KEY}`);
  assert.equal(sent.body.model, 'deepseek-v4-flash');
  assert.equal(sent.body.messages[0].role, 'system');
  assert.equal(sent.body.tools, undefined);
  assert.equal(count(mini, '/chat/completions'), before);
});

test('with web search on, an Infero question is handed to MiniRouter, else OpenRouter, else stays without search', async () => {
  const inferoBefore = count(infero, '/chat/completions');
  let r = await ask(all, 'infero:deepseek-v4-flash', true);
  assert.equal(r.headers.get('x-handed-off'), 'true');
  assert.equal(r.headers.get('x-served-via'), 'minirouter');
  await r.text();
  let sent = last(mini, '/chat/completions');
  assert.equal(sent.body.model, 'minirouter/auto');
  assert.equal(sent.auth, `Bearer ${KEYS.MINIROUTER_KEY}`);
  assert.ok(sent.body.tools.some((t) => t.type === 'minirouter:google_search'));
  assert.equal(count(infero, '/chat/completions'), inferoBefore);

  r = await ask(inferoAndOpenRouter, 'infero:deepseek-v4-flash', true);
  assert.equal(r.headers.get('x-served-via'), 'openrouter');
  await r.text();
  sent = last(openrouter, '/chat/completions');
  assert.equal(sent.body.model, 'openrouter/auto');
  assert.equal(sent.auth, `Bearer ${KEYS.OPENROUTER_KEY}`);
  assert.deepEqual(sent.body.tools.map((t) => t.type), ['openrouter:web_search']);

  r = await ask(inferoOnly, 'infero:deepseek-v4-flash', true);
  assert.equal(r.headers.get('x-served-via'), 'infero');
  assert.equal(r.headers.get('x-search-available'), 'false');
  await r.text();
  assert.equal(last(infero, '/chat/completions').body.tools, undefined);
});

test('MiniRouter and OpenRouter models go to their own provider', async () => {
  await (await ask(all, 'test/vision', true)).text();
  assert.equal(last(mini, '/chat/completions').body.model, 'test/vision');
  const r = await ask(all, 'openrouter:meta-llama/llama-4', true);
  assert.equal(r.headers.get('x-served-via'), 'openrouter');
  await r.text();
  const sent = last(openrouter, '/chat/completions');
  assert.equal(sent.body.model, 'meta-llama/llama-4');
  assert.deepEqual(sent.body.tools, [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_uses: 3 } }]);
});

test('errors name the provider, and a missing key names the one needed', async () => {
  const failed = await ask(all, 'infero:broken', false);
  assert.equal(failed.status, 402);
  assert.match((await failed.json()).error, /^Infero returned 402: Balance exhausted/);
  const noKey = await ask(openRouterOnly, 'infero:deepseek-v4-flash', false);
  assert.equal(noKey.status, 401);
  assert.match((await noKey.json()).error, /Infero key/);
});

test('images go to the provider that makes them and are kept locally', async () => {
  let r = await all.send('/api/images', { model: 'infero:z-image-turbo', prompt: 'a boat' });
  assert.equal(r.status, 200);
  const { media } = await r.json();
  assert.deepEqual(last(infero, '/images/generations').body, { model: 'z-image-turbo', prompt: 'a boat', n: 1, response_format: 'b64_json' });
  assert.equal((await all.get(`/media/${media.id}`)).status, 200);
  r = await all.send('/api/images', { model: 'openrouter:google/gemini-2.5-flash-image', prompt: 'a cat' });
  assert.equal((await r.json()).cost, 0.039);
  assert.equal(last(openrouter, '/images').body.model, 'google/gemini-2.5-flash-image');
  // Only MiniRouter makes videos.
  assert.equal((await all.send('/api/videos', { model: 'infero:deepseek-v4-flash', prompt: 'waves' })).status, 400);
});

test('voice uses Infero first, as a file upload with Kokoro voices', async () => {
  const wav = Buffer.from('RIFFfakewav');
  const r = await all.wav(wav);
  assert.deepEqual(await r.json(), { text: 'From Infero.' });
  const sent = last(infero, '/audio/transcriptions');
  assert.match(sent.type, /^multipart\/form-data; boundary=/);
  const form = sent.raw.toString();
  assert.match(form, /whisper-large-v3-turbo/);
  assert.match(form, /filename="speech.wav"/);
  assert.ok(form.includes('RIFFfakewav'));
  assert.equal(count(mini, '/audio/transcriptions'), 0);

  assert.equal((await all.send('/api/speak', { text: 'hello', voice: 'af_bella' })).status, 200);
  assert.deepEqual(last(infero, '/audio/speech').body, { model: 'kokoro', input: 'hello', voice: 'af_bella', response_format: 'mp3' });
  assert.equal((await all.send('/api/speak', { text: 'hello', voice: 'nova' })).status, 400);
});

test('voice falls back to OpenRouter when it is the only key', async () => {
  const wav = Buffer.from('RIFFfakewav');
  assert.deepEqual(await (await openRouterOnly.wav(wav)).json(), { text: 'From OpenRouter.' });
  assert.deepEqual(last(openrouter, '/audio/transcriptions').body, {
    model: 'openai/whisper-large-v3', input_audio: { data: wav.toString('base64'), format: 'wav' },
  });
  assert.equal((await openRouterOnly.send('/api/speak', { text: 'hi', voice: 'nova' })).status, 200);
  assert.equal(last(openrouter, '/audio/speech').body.model, 'openai/gpt-4o-mini-tts');
});

test('each provider key is saved separately, privately, and never echoed', async () => {
  const key = 'sk-infero-zyxwvutsrqponmlk';
  assert.equal((await openRouterOnly.send('/api/key', { provider: 'nope', key }, 'PUT')).status, 400);
  const bad = await openRouterOnly.send('/api/key', { provider: 'infero', key: 'bad key' }, 'PUT');
  assert.match((await bad.json()).error, /sk-infero-/);
  const r = await openRouterOnly.send('/api/key', { provider: 'infero', key }, 'PUT');
  const text = await r.text();
  assert.ok(!text.includes(key));
  assert.equal(JSON.parse(text).keys.infero, true);
  const envFile = path.join(openRouterOnly.dir, '.env');
  assert.match(fs.readFileSync(envFile, 'utf8'), /^INFERO_KEY=sk-infero-zyxwvutsrqponmlk$/m);
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
  // Infero is now first for voice too.
  assert.equal((await (await openRouterOnly.get('/api/status')).json()).voices.via, 'infero');
});

test('private mode blocks every provider', async () => {
  assert.equal((await all.send('/api/settings', { privateMode: true }, 'PUT')).status, 200);
  const before = [mini, infero, openrouter].map((m) => m.requests.length);
  const blocked = await Promise.all([
    ask(all, 'infero:deepseek-v4-flash', false),
    ask(all, 'infero:deepseek-v4-flash', true),
    ask(all, 'openrouter:meta-llama/llama-4', false),
    ask(all, 'test/vision', false),
    all.send('/api/images', { model: 'infero:z-image-turbo', prompt: 'x' }),
    all.send('/api/speak', { text: 'hi', voice: 'af_bella' }),
    all.wav(Buffer.from('RIFF')),
  ]);
  for (const r of blocked) assert.equal(r.status, 403);
  const { models } = await (await all.get('/api/models')).json();
  assert.equal(models.length, 0);
  assert.deepEqual([mini, infero, openrouter].map((m) => m.requests.length), before);
  await all.send('/api/settings', { privateMode: false }, 'PUT');
});

test('the web search provider can be chosen for models that cannot search, and falls back', async () => {
  const keys = { infero: true, minirouter: true, openrouter: true };
  assert.equal(routeFor('infero:x', true, { keys, searchVia: 'openrouter' }).model, 'openrouter:openrouter/auto');
  // Without an OpenRouter key, the first that can search is used.
  assert.equal(routeFor('infero:x', true, { keys: { infero: true, minirouter: true }, searchVia: 'openrouter' }).model, 'minirouter/auto');

  const status = async () => (await all.get('/api/status')).json();
  assert.equal((await status()).searchVia, 'auto');
  assert.deepEqual((await status()).searchOptions.map((p) => p.id), ['minirouter', 'openrouter']);
  assert.equal((await all.send('/api/settings', { searchVia: 'infero' }, 'PUT')).status, 400);
  assert.equal((await all.send('/api/settings', { searchVia: 'openrouter' }, 'PUT')).status, 200);

  let r = await ask(all, 'infero:deepseek-v4-flash', true);
  assert.equal(r.headers.get('x-served-via'), 'openrouter');
  await r.text();
  assert.equal(last(openrouter, '/chat/completions').body.model, 'openrouter/auto');
  // A MiniRouter model still searches with MiniRouter.
  r = await ask(all, 'test/vision', true);
  assert.equal(r.headers.get('x-served-via'), 'minirouter');
  await r.text();

  await all.send('/api/settings', { searchVia: 'auto' }, 'PUT');
  r = await ask(all, 'infero:deepseek-v4-flash', true);
  assert.equal(r.headers.get('x-served-via'), 'minirouter');
  await r.text();
});
