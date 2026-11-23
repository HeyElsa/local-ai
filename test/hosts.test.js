// Groq, Cerebras, Together, Fireworks, DeepInfra and a custom endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMock } from './mock-upstream.js';
import { signIn, CODE, PASS } from './session.js';
import { startHosts } from './mock-hosts.js';
import { fetchPublicFile, isPrivateAddress, isLocalName } from '../safe-fetch.js';

const KEYS = {
  GROQ_KEY: 'gsk_groqgroqgroqgroqgroq', CEREBRAS_KEY: 'csk-cerebrascerebras', TOGETHER_KEY: 'tgp_v1_togethertogether',
  FIREWORKS_KEY: 'fw_fireworksfireworks', DEEPINFRA_KEY: 'deepinfradeepinfradeep', MINIROUTER_KEY: 'mr-live-abcdefghijklmnopqrstuvwxyz',
};
const DEAD = 'http://127.0.0.1:9';
let hosts; let mini;
const servers = [];

async function launch(port, keys, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-hosts-'));
  const blank = Object.fromEntries(['INFERO_KEY', 'MINIROUTER_KEY', 'OPENROUTER_KEY', ...Object.keys(KEYS), 'CUSTOM_KEY', 'CUSTOM_BASE_URL', 'CUSTOM_NAME'].map((k) => [k, '']));
  const child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, ...blank, PORT: port, LOCAL_AI_SETUP_CODE: CODE, LOCAL_AI_DATA_DIR: dir, LOCAL_AI_ENV_FILE: path.join(dir, '.env'),
      LOCAL_AI_OLLAMA_URL: DEAD, INFERO_BASE_URL: DEAD, OPENROUTER_BASE_URL: DEAD, MINIROUTER_BASE_URL: mini.url,
      GROQ_BASE_URL: `${hosts.url}/groq`, CEREBRAS_BASE_URL: `${hosts.url}/cerebras`, TOGETHER_BASE_URL: `${hosts.url}/together`,
      FIREWORKS_BASE_URL: `${hosts.url}/fireworks`, DEEPINFRA_BASE_URL: `${hosts.url}/deepinfra/v1/openai`,
      ...Object.fromEntries(keys.map((k) => [k, KEYS[k]])), ...extra,
    },
    stdio: 'ignore',
  });
  servers.push({ child, dir });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) {
    try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => { setTimeout(r, 100); }); }
  }
  await signIn(base);
  const headers = { 'content-type': 'application/json', origin: base };
  return {
    dir,
    send: (p, body, method = 'POST') => fetch(base + p, { method, headers, body: JSON.stringify(body) }),
    get: (p) => fetch(base + p),
    wav: () => fetch(`${base}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav', origin: base }, body: Buffer.from('RIFFfakewav') }),
  };
}

const ask = (app, model, web = false) => app.send('/api/chat', { model, web, messages: [{ role: 'user', content: 'hi' }] });
const last = (host, suffix) => hosts.requests.findLast((q) => q.host === host && q.url.endsWith(suffix));

let all; let groqTogether; let deepinfraOnly; let none; let togetherOnly; let guessed;

before(async () => {
  [hosts, mini] = await Promise.all([startHosts(), startMock()]);
  [all, groqTogether, deepinfraOnly, none, togetherOnly, guessed] = await Promise.all([
    launch(4381, Object.keys(KEYS), { CUSTOM_BASE_URL: `${hosts.url}/custom/v1`, CUSTOM_NAME: 'Lab server', CUSTOM_KEY: 'custom-secret-key' }),
    launch(4382, ['GROQ_KEY', 'TOGETHER_KEY']),
    launch(4383, ['DEEPINFRA_KEY']),
    launch(4384, []),
    launch(4385, ['TOGETHER_KEY']),
    launch(4386, []),
  ]);
});

after(() => {
  for (const { child, dir } of servers) { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  for (const m of [hosts, mini]) { m.server.closeAllConnections(); m.server.close(); }
});

test('each host lists its models in its own group, with only chat and image models', async () => {
  const { models } = await (await all.get('/api/models')).json();
  const ids = models.map((m) => m.id);
  for (const id of [
    'groq:llama-3.3-70b-versatile', 'cerebras:gpt-oss-120b', 'together:meta-llama/Llama-3.3-70B-Instruct-Turbo',
    'fireworks:accounts/fireworks/models/kimi-k3', 'deepinfra:zai-org/GLM-5.3-Flash', 'custom:my-model',
  ]) assert.ok(ids.includes(id), id);
  for (const id of ['groq:whisper-large-v3-turbo', 'groq:retired-model', 'together:BAAI/bge-large-en-v1.5', 'fireworks:accounts/fireworks/models/qwen3-embedding', 'deepinfra:openai/whisper-large-v3-turbo']) {
    assert.ok(!ids.includes(id), id);
  }
  const order = [...new Set(models.map((m) => m.via))];
  assert.deepEqual(order, ['minirouter', 'groq', 'cerebras', 'together', 'fireworks', 'deepinfra', 'custom']);
  const find = (id) => models.find((m) => m.id === id);
  assert.equal(find('groq:meta-llama/llama-4-scout-17b-16e-instruct').seesImages, true);
  assert.equal(find('groq:llama-3.3-70b-versatile').seesImages, false);
  assert.equal(find('together:meta-llama/Llama-3.3-70B-Instruct-Turbo').name, 'Llama 3.3 70B');
  assert.ok(Math.abs(find('together:meta-llama/Llama-3.3-70B-Instruct-Turbo').input * 1e6 - 0.88) < 1e-9);
  assert.equal(find('together:black-forest-labs/FLUX.1-schnell').kind, 'image');
  assert.equal(find('fireworks:accounts/fireworks/models/kimi-k3').name, 'Kimi K3');
  const glm = find('deepinfra:zai-org/GLM-5.3-Flash');
  assert.equal(glm.seesImages, true);
  assert.equal(glm.output * 1e6, 0.5); // Float noise is tidied.
  assert.equal(find('deepinfra:black-forest-labs/FLUX-2-klein-9b').imagePrice, 0.003);
});

test('questions go to the host named in the model ID, with its own key', async () => {
  for (const [model, host, key, upstream] of [
    ['groq:llama-3.3-70b-versatile', 'groq', KEYS.GROQ_KEY, 'llama-3.3-70b-versatile'],
    ['cerebras:gpt-oss-120b', 'cerebras', KEYS.CEREBRAS_KEY, 'gpt-oss-120b'],
    ['together:meta-llama/Llama-3.3-70B-Instruct-Turbo', 'together', KEYS.TOGETHER_KEY, 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
    ['fireworks:accounts/fireworks/models/kimi-k3', 'fireworks', KEYS.FIREWORKS_KEY, 'accounts/fireworks/models/kimi-k3'],
    ['deepinfra:zai-org/GLM-5.3-Flash', 'deepinfra', KEYS.DEEPINFRA_KEY, 'zai-org/GLM-5.3-Flash'],
    ['custom:my-model', 'custom', 'custom-secret-key', 'my-model'],
  ]) {
    const r = await ask(all, model);
    assert.equal(r.status, 200, model);
    assert.equal(r.headers.get('x-served-via'), host);
    assert.match(await r.text(), new RegExp(`Hello from ${host}`));
    const sent = last(host, '/chat/completions');
    assert.equal(sent.auth, `Bearer ${key}`);
    assert.equal(sent.body.model, upstream);
    assert.equal(sent.body.tools, undefined);
  }
  assert.ok(last('deepinfra', '/chat/completions').url.startsWith('/deepinfra/v1/openai/'));
});

test('none of the hosts search, so search is handed to MiniRouter', async () => {
  const r = await ask(all, 'groq:llama-3.3-70b-versatile', true);
  assert.equal(r.headers.get('x-handed-off'), 'true');
  assert.equal(r.headers.get('x-served-via'), 'minirouter');
  await r.text();
  assert.equal(mini.requests.findLast((q) => q.url === '/chat/completions').body.model, 'minirouter/auto');
});

test('a provider cannot make the app fetch an address on this computer; inline images are kept locally', async () => {
  // The stand-in for Together answers with a link to this computer, as a hostile provider might.
  const files = () => hosts.requests.filter((q) => q.url === '/files/picture.png').length;
  const before = files();
  let r = await all.send('/api/images', { model: 'together:black-forest-labs/FLUX.1-schnell', prompt: 'a boat' });
  assert.deepEqual(last('together', '/images/generations').body, { model: 'black-forest-labs/FLUX.1-schnell', prompt: 'a boat', n: 1 });
  assert.equal(r.status, 502);
  assert.match((await r.json()).error, /will not open/);
  assert.equal(files(), before);
  r = await all.send('/api/images', { model: 'deepinfra:black-forest-labs/FLUX-2-klein-9b', prompt: 'a cat' });
  assert.equal(r.status, 200);
  assert.equal(last('deepinfra', '/images/generations').body.response_format, 'b64_json');
});

test('voice picks the first host that can do each job', async () => {
  // Groq comes first for both jobs, and reads with Orpheus in pieces of up to 200 characters.
  const status = await (await groqTogether.get('/api/status')).json();
  assert.equal(status.transcriber, 'Groq');
  assert.equal(status.voices.via, 'groq');
  assert.equal(status.voices.limit, 200);
  assert.deepEqual(status.voices.list.map((v) => v.id), ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy']);
  assert.deepEqual(await (await groqTogether.wav()).json(), { text: 'From groq.' });
  const sent = last('groq', '/audio/transcriptions');
  assert.match(sent.type, /^multipart\/form-data/);
  assert.match(sent.raw.toString(), /whisper-large-v3-turbo/);
  assert.equal((await groqTogether.send('/api/speak', { text: 'hi', voice: 'troy' })).status, 200);
  assert.deepEqual(last('groq', '/audio/speech').body, { model: 'canopylabs/orpheus-v1-english', input: 'hi', voice: 'troy', response_format: 'wav' });
  const long = await groqTogether.send('/api/speak', { text: 'x'.repeat(201), voice: 'troy' });
  assert.equal(long.status, 400);
  assert.match((await long.json()).error, /200 characters for Groq/);
  assert.equal((await groqTogether.send('/api/speak', { text: 'hi', voice: 'af_bella' })).status, 400);

  // Without Groq, Together reads with Kokoro.
  assert.equal((await togetherOnly.get('/api/status').then((r) => r.json())).voices.via, 'together');
  assert.equal((await togetherOnly.send('/api/speak', { text: 'hi', voice: 'af_bella' })).status, 200);
  assert.equal(last('together', '/audio/speech').body.model, 'hexgrad/Kokoro-82M');

  // DeepInfra's audio lives under /v1, not /v1/openai.
  assert.deepEqual(await (await deepinfraOnly.wav()).json(), { text: 'From deepinfra.' });
  assert.equal(last('deepinfra', '/audio/transcriptions').url, '/deepinfra/v1/audio/transcriptions');
  assert.equal((await deepinfraOnly.send('/api/speak', { text: 'hi', voice: 'af_bella' })).status, 200);
  assert.equal(last('deepinfra', '/audio/speech').url, '/deepinfra/v1/audio/speech');
});

test('a custom endpoint is set up, saved privately, never echoed, and can be removed', async () => {
  assert.equal((await none.send('/api/custom', { base: 'ftp://x' }, 'PUT')).status, 400);
  // Plain http would send the key and chats unencrypted, so it is only for this computer or network.
  const plain = await none.send('/api/custom', { base: 'http://llm.example.com/v1' }, 'PUT');
  assert.equal(plain.status, 400);
  assert.match((await plain.json()).error, /https/);
  assert.equal((await none.send('/api/custom', { base: 'https://user:pw@x.example' }, 'PUT')).status, 400);
  assert.equal((await none.send('/api/key', { provider: 'custom', key: 'abcdefghijklmnopqrst' }, 'PUT')).status, 400);
  const secret = 'lab-secret-0123456789';
  const r = await none.send('/api/custom', { base: `${hosts.url}/custom/v1/`, name: 'Lab server', key: secret }, 'PUT');
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!text.includes(secret));
  const saved = JSON.parse(text);
  assert.equal(saved.keys.custom, true);
  assert.deepEqual(saved.custom, { name: 'Lab server', base: `${hosts.url}/custom/v1`, hasKey: true });
  const env = fs.readFileSync(path.join(none.dir, '.env'), 'utf8');
  assert.match(env, /^CUSTOM_KEY=lab-secret-0123456789$/m);
  assert.equal(fs.statSync(path.join(none.dir, '.env')).mode & 0o777, 0o600);
  assert.ok((await (await none.get('/api/models')).json()).models.some((m) => m.id === 'custom:my-model'));
  await (await ask(none, 'custom:my-model')).text();
  assert.equal(last('custom', '/chat/completions').auth, `Bearer ${secret}`);

  // Saving again without a key keeps it; an empty address removes everything.
  await none.send('/api/custom', { base: `${hosts.url}/custom/v1`, name: 'Renamed' }, 'PUT');
  assert.match(fs.readFileSync(path.join(none.dir, '.env'), 'utf8'), /CUSTOM_KEY=lab-secret/);
  const removed = await (await none.send('/api/custom', { base: '' }, 'PUT')).json();
  assert.equal(removed.keys.custom, false);
  assert.equal(removed.custom, null);
  assert.ok(!fs.readFileSync(path.join(none.dir, '.env'), 'utf8').includes('CUSTOM_'));
  assert.equal((await ask(none, 'custom:my-model')).status, 401);
});

test('private mode blocks every host, the custom endpoint included', async () => {
  await all.send('/api/settings', { privateMode: true }, 'PUT');
  const before = hosts.requests.length;
  for (const model of ['groq:llama-3.3-70b-versatile', 'deepinfra:zai-org/GLM-5.3-Flash', 'custom:my-model']) {
    assert.equal((await ask(all, model)).status, 403, model);
  }
  assert.equal((await all.wav()).status, 403);
  assert.equal(hosts.requests.length, before);
  await all.send('/api/settings', { privateMode: false }, 'PUT');
});

test('the read-aloud provider can be chosen, falls back when its key is gone, and is checked', async () => {
  const status = async () => (await groqTogether.get('/api/status')).json();
  assert.equal((await status()).speakVia, 'auto');
  assert.deepEqual((await status()).speakOptions.map((p) => p.id), ['groq', 'together']);
  assert.equal((await groqTogether.send('/api/settings', { speakVia: 'cerebras' }, 'PUT')).status, 400);
  assert.equal((await groqTogether.send('/api/settings', { speakVia: 'nope' }, 'PUT')).status, 400);

  assert.equal((await groqTogether.send('/api/settings', { speakVia: 'together' }, 'PUT')).status, 200);
  assert.equal((await status()).voices.via, 'together');
  assert.equal((await groqTogether.send('/api/speak', { text: 'hi', voice: 'af_bella' })).status, 200);
  assert.equal(last('together', '/audio/speech').body.voice, 'af_bella');
  // Choosing reads aloud only: Groq still writes speech down.
  assert.equal((await status()).transcriber, 'Groq');

  // DeepInfra can read aloud but has no key here, so the first available one is used.
  assert.equal((await groqTogether.send('/api/settings', { speakVia: 'deepinfra' }, 'PUT')).status, 200);
  assert.equal((await status()).voices.via, 'groq');

  await groqTogether.send('/api/settings', { speakVia: 'auto' }, 'PUT');
  assert.equal((await status()).voices.via, 'groq');
});

test('the transcription provider can be chosen separately, falls back, and is checked', async () => {
  const status = async () => (await groqTogether.get('/api/status')).json();
  assert.equal((await status()).transcribeVia, 'auto');
  assert.deepEqual((await status()).transcribeOptions.map((p) => p.id), ['groq', 'together']);
  assert.equal((await groqTogether.send('/api/settings', { transcribeVia: 'cerebras' }, 'PUT')).status, 400);
  assert.equal((await groqTogether.send('/api/settings', { transcribeVia: 'together' }, 'PUT')).status, 200);
  const now = await status();
  assert.equal(now.transcriber, 'Together AI');
  assert.equal(now.voices.via, 'groq'); // Reading aloud is not affected.
  assert.deepEqual(await (await groqTogether.wav()).json(), { text: 'From together.' });
  assert.match(last('together', '/audio/transcriptions').raw.toString(), /openai\/whisper-large-v3/);

  await groqTogether.send('/api/settings', { transcribeVia: 'deepinfra' }, 'PUT'); // No key here.
  assert.equal((await status()).transcriber, 'Groq');
  await groqTogether.send('/api/settings', { transcribeVia: 'auto' }, 'PUT');
  assert.equal((await status()).transcriber, 'Groq');
});

test('the image provider setting is saved, lists only providers that make images, and is checked', async () => {
  const status = async () => (await all.get('/api/status')).json();
  assert.equal((await status()).imageVia, 'auto');
  assert.deepEqual((await status()).imageOptions.map((p) => p.id), ['minirouter', 'together', 'deepinfra']);
  assert.equal((await all.send('/api/settings', { imageVia: 'groq' }, 'PUT')).status, 400);
  assert.equal((await all.send('/api/settings', { imageVia: 'together' }, 'PUT')).status, 200);
  assert.equal((await status()).imageVia, 'together');
  await all.send('/api/settings', { imageVia: 'auto' }, 'PUT');
});

test('downloads from a provider are limited to public https addresses, redirects included, and to a size', async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.5', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '[::1]', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.equal(isPrivateAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(ip), false, ip);
  for (const name of ['localhost', 'box.local', '127.0.0.1', '192.168.1.5', '[::1]']) assert.equal(isLocalName(name), true, name);
  assert.equal(isLocalName('llm.example.com'), false);

  const never = () => { throw new Error('should not be fetched'); };
  for (const address of ['http://8.8.8.8/a.png', 'https://127.0.0.1/a.png', 'https://localhost/a.png', 'https://[::1]/a.png', 'https://169.254.169.254/latest', 'https://user:pw@8.8.8.8/a.png', 'file:///etc/passwd', 'nonsense']) {
    await assert.rejects(fetchPublicFile(address, { fetcher: never }), undefined, address);
  }
  // A public address that redirects to this computer is refused before the second request.
  const asked = [];
  const redirecting = async (address) => { asked.push(address); return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } }); };
  await assert.rejects(fetchPublicFile('https://8.8.8.8/a.png', { fetcher: redirecting }), /private network/);
  assert.deepEqual(asked, ['https://8.8.8.8/a.png']);
  // A public file is returned, up to the size limit.
  const ok = async () => new Response(Buffer.from('picture-bytes'));
  assert.equal((await fetchPublicFile('https://8.8.8.8/a.png', { fetcher: ok })).toString(), 'picture-bytes');
  await assert.rejects(fetchPublicFile('https://8.8.8.8/a.png', { fetcher: ok, limit: 5 }), /too large/);
});

test('guessing the 4-number passcode is locked out after 5 wrong tries, even for the right one', async () => {
  for (const guess of ['0000', '0001', '0002', '0003', '0004']) {
    assert.equal((await guessed.send('/api/unlock', { passphrase: guess })).status, 401, guess);
  }
  const blocked = await guessed.send('/api/unlock', { passphrase: PASS });
  assert.equal(blocked.status, 429);
  assert.match((await blocked.json()).error, /Wait 30 seconds/);
  // Choosing a new passcode is blocked by the same wait.
  assert.equal((await guessed.send('/api/vault/passphrase', { current: PASS, next: '1111' }, 'PUT')).status, 429);
});

test('a longer passphrase from an earlier version still unlocks, and can be changed to 4 numbers', async () => {
  // Writes the key file the way an earlier version did, protected by a long passphrase.
  const { createVault } = await import('../vault.js');
  const fsx = await import('node:fs');
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'local-ai-old-'));
  await createVault(path.join(dir, 'vault.json')).create('an old long passphrase');
  const child = spawn(process.execPath, ['server.js'], { stdio: 'ignore', env: { ...process.env, PORT: 4387, LOCAL_AI_DATA_DIR: dir, LOCAL_AI_ENV_FILE: path.join(dir, '.env'), LOCAL_AI_OLLAMA_URL: DEAD } });
  servers.push({ child, dir });
  const base = 'http://127.0.0.1:4387';
  for (let i = 0; i < 50; i += 1) { try { await fetch(`${base}/api/status`); break; } catch { await new Promise((r) => { setTimeout(r, 100); }); } }
  const h = { 'content-type': 'application/json', origin: base };
  const unlocked = await fetch(`${base}/api/unlock`, { method: 'POST', headers: h, body: JSON.stringify({ passphrase: 'an old long passphrase' }) });
  assert.equal(unlocked.status, 200);
  const cookie = unlocked.headers.get('set-cookie').split(';')[0];
  const changed = await fetch(`${base}/api/vault/passphrase`, { method: 'PUT', headers: { ...h, cookie }, body: JSON.stringify({ current: 'an old long passphrase', next: '2468' }) });
  assert.equal(changed.status, 200);
  await fetch(`${base}/api/lock`, { method: 'POST', headers: { ...h, cookie: changed.headers.get('set-cookie').split(';')[0] }, body: '{}' });
  assert.equal((await fetch(`${base}/api/unlock`, { method: 'POST', headers: h, body: JSON.stringify({ passphrase: '2468' }) })).status, 200);
});
