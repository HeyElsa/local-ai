import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMock } from './mock-upstream.js';
import { startOllama } from './mock-ollama.js';
import { signIn, signOut, keepSession, PASS, CODE } from './session.js';
import { maskText, unmaskText, describeHidden } from '../public/privacy.js';

const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'my-very-secret-chat-text';
let mock; let ollama; let child; let dir;
const OLD_CHAT = '22222222-2222-4222-8222-222222222222';

const headers = () => ({ 'content-type': 'application/json', origin: BASE });
const send = (p, body, method = 'POST') => fetch(BASE + p, { method, headers: headers(), body: JSON.stringify(body) });
const get = (p, extra = {}) => fetch(BASE + p, { headers: { ...extra } });
const upload = (bytes, q = '') => fetch(`${BASE}/api/media${q}`, { method: 'POST', headers: { ...headers(), 'content-type': 'video/mp4' }, body: bytes });

function start({ enter = true } = {}) {
  child = spawn(process.execPath, ['server.js'], {
    env: {
      ...process.env, PORT, MINIROUTER_KEY: 'mr-live-abcdefghijklmnopqrstuvwxyz', MINIROUTER_BASE_URL: mock.url,
      LOCAL_AI_OLLAMA_URL: ollama.url, LOCAL_AI_SETUP_CODE: CODE, LOCAL_AI_DATA_DIR: dir, LOCAL_AI_ENV_FILE: path.join(dir, '.env'),
      INFERO_KEY: '', OPENROUTER_KEY: '', INFERO_BASE_URL: 'http://127.0.0.1:9', OPENROUTER_BASE_URL: 'http://127.0.0.1:9',
      GROQ_KEY: '', CEREBRAS_KEY: '', TOGETHER_KEY: '', FIREWORKS_KEY: '', DEEPINFRA_KEY: '', CUSTOM_KEY: '', CUSTOM_BASE_URL: '', CUSTOM_NAME: '',
    },
    stdio: 'ignore',
  });
  return (async () => {
    for (let i = 0; i < 50; i += 1) {
      try { await fetch(`${BASE}/api/status`); if (enter) await signIn(BASE); return; } catch { await new Promise((r) => { setTimeout(r, 100); }); }
    }
    throw new Error('server did not start');
  })();
}
const restart = async (options) => {
  await new Promise((r) => { child.once('exit', r); child.kill(); });
  await start(options);
};

before(async () => {
  mock = await startMock();
  ollama = await startOllama();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ai-privacy-'));
  // A chat and a file saved by a version from before a passphrase was required.
  fs.mkdirSync(path.join(dir, 'chats'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'chats', `${OLD_CHAT}.json`), JSON.stringify({ id: OLD_CHAT, title: SECRET, updatedAt: Date.now(), messages: [{ role: 'user', content: SECRET }] }));
  fs.writeFileSync(path.join(dir, 'media', 'old-file.png'), `old ${SECRET} bytes`);
  await start({ enter: false });
});
after(() => {
  child.kill();
  for (const s of [mock.server, ollama.server]) { s.closeAllConnections(); s.close(); }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing works until a passphrase is chosen, and choosing one needs the setup code', async () => {
  const status = await (await get('/api/status')).json();
  assert.deepEqual(status, { vault: 'setup' });
  for (const r of await Promise.all([get('/api/chats'), get(`/api/chats/${OLD_CHAT}`), get('/media/old-file.png'), get('/api/models'),
    send('/api/chat', { model: 'x', messages: [] }), send('/api/key', { provider: 'infero', key: 'sk-infero-abcdefghijklmnop' }, 'PUT'),
    send('/api/custom', { base: 'https://attacker.example/v1' }, 'PUT'), send('/api/wipe', { confirm: 'DELETE' }), send('/api/unlock', { passphrase: PASS })])) {
    assert.ok([423, 409].includes(r.status), `${r.url} ${r.status}`);
  }
  assert.equal((await send('/api/vault/enable', { passphrase: PASS })).status, 401);
  assert.equal((await send('/api/vault/enable', { passphrase: PASS, code: 'WRONG-CODE' })).status, 401);
  for (const bad of ['123', '12345', 'abcd', '12 4', 'correct horse battery']) assert.equal((await send('/api/vault/enable', { passphrase: bad, code: CODE })).status, 400, bad);
  assert.ok(!fs.existsSync(path.join(dir, 'vault.json')));

  await signIn(BASE);
  assert.equal((await (await get('/api/status')).json()).vault, 'open');
  // It cannot be chosen a second time.
  assert.equal((await send('/api/vault/enable', { passphrase: '9999', code: CODE })).status, 409);
  // What an older version saved in the clear is now encrypted, and still readable when signed in.
  for (const file of [path.join(dir, 'chats', `${OLD_CHAT}.json`), path.join(dir, 'media', 'old-file.png')]) assert.ok(!fs.readFileSync(file).includes(SECRET), file);
  assert.equal((await (await get(`/api/chats/${OLD_CHAT}`)).json()).title, SECRET);
  assert.equal(await (await get('/media/old-file.png')).text(), `old ${SECRET} bytes`);
  assert.ok(!fs.readFileSync(path.join(dir, 'vault.json'), 'utf8').includes(PASS));
});

test('a hidden detail is restored in text and email links, but never inside a web address', () => {
  const masks = { 'ann@example.com': '[EMAIL 1]' };
  assert.equal(unmaskText('Write to [EMAIL 1].', masks), 'Write to ann@example.com.');
  assert.equal(unmaskText('[Mail her](mailto:[EMAIL 1])', masks), '[Mail her](mailto:ann@example.com)');
  for (const leak of ['[click](<https://evil.example/?q=[EMAIL 1]>)', '[click](https://evil.example/?q=[EMAIL 1])', '<https://evil.example/[EMAIL 1]>', '[a]: <https://evil.example/?[EMAIL 1]>']) {
    assert.equal(unmaskText(leak, masks), leak, leak);
  }
  assert.equal(unmaskText('[EMAIL 1] and [x](https://a.example/[EMAIL 1]) and [EMAIL 1]', masks), 'ann@example.com and [x](https://a.example/[EMAIL 1]) and ann@example.com');
});

test('masks details, keeps ordinary numbers, and restores answers', () => {
  const masks = {};
  const text = 'Mail ann@example.com or call +44 20 7946 0958, card 4242 4242 4242 4242, key sk-abcdefghijklmnop1234, ssn 078-05-1120. Years 1800 1900 1950 2000 and order 1234567890123.';
  const out = maskText(text, masks);
  for (const secret of ['ann@example.com', '7946', '4242', 'sk-abc', '078-05']) assert.ok(!out.includes(secret), secret);
  assert.ok(out.includes('1800 1900 1950 2000'));
  assert.ok(out.includes('1234567890123'));
  assert.equal(unmaskText(out, masks), text);
  assert.equal(maskText('again ann@example.com', masks), 'again [EMAIL 1]');
  assert.equal(describeHidden('[EMAIL 1] [EMAIL 2] [PHONE 1]'), '2 email addresses and 1 phone number');
});

test('a detail repeated in one message keeps one placeholder', () => {
  const masks = {};
  const out = maskText('mail a@b.com or a@b.com', masks);
  assert.equal(out, 'mail [EMAIL 1] or [EMAIL 1]');
  assert.equal(unmaskText(out, masks), 'mail a@b.com or a@b.com');
  assert.equal(maskText('also c@d.com', masks), 'also [EMAIL 2]');
});

test('local models are listed, cloud-backed Ollama models are not', async () => {
  const { models, ollama: running } = await (await get('/api/models')).json();
  assert.equal(running, true);
  const local = models.filter((m) => m.local).map((m) => m.id);
  assert.deepEqual(local, ['local/tiny:latest', 'local/eyes:4b']);
  assert.equal(models.find((m) => m.id === 'local/eyes:4b').seesImages, true);
  assert.equal((await send('/api/local/pull', { name: 'x:1-cloud' })).status, 400);
  assert.ok((await (await send('/api/local/pull', { name: 'eyes:4b' })).text()).includes('success'));
});

test('a local question reaches Ollama only, without tools', async () => {
  const before = mock.requests.filter((q) => q.url === '/chat/completions').length;
  const r = await send('/api/chat', { model: 'local/tiny:latest', web: true, messages: [{ role: 'user', content: 'hi' }] });
  assert.match(await r.text(), /on this computer/);
  assert.equal(mock.requests.filter((q) => q.url === '/chat/completions').length, before);
  const sent = ollama.requests.findLast((q) => q.url === '/v1/chat/completions').body;
  assert.equal(sent.model, 'tiny:latest');
  assert.equal(sent.tools, undefined);
  assert.equal((await send('/api/chat', { model: 'local/big:120b-cloud', messages: [{ role: 'user', content: 'hi' }] })).status, 400);
});

test('masked requests teach the model about placeholders', async () => {
  await (await send('/api/chat', { model: 'test/plain', masked: true, messages: [{ role: 'user', content: 'hi [EMAIL 1]' }] })).text();
  assert.match(mock.requests.findLast((q) => q.url === '/chat/completions').body.messages[0].content, /placeholder/);
});

test('private mode sends nothing to the cloud, and survives a restart', async () => {
  assert.equal((await send('/api/settings', { privateMode: true }, 'PUT')).status, 200);
  await restart();
  assert.equal((await (await get('/api/status')).json()).privateMode, true);
  const count = mock.requests.length;
  const { models } = await (await get('/api/models')).json();
  assert.ok(models.length && models.every((m) => m.local));
  const blocked = [
    send('/api/chat', { model: 'test/plain', messages: [{ role: 'user', content: 'hi' }] }),
    send('/api/images', { model: 'openai/gpt-image-1-mini', prompt: 'x' }),
    send('/api/videos', { model: 'google/veo-3.1-lite-generate-001', prompt: 'x' }),
    send('/api/speak', { text: 'hi', voice: 'nova' }),
    get('/api/videos/vid_1'),
    fetch(`${BASE}/api/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/wav', origin: BASE }, body: 'RIFF' }),
  ];
  for (const r of await Promise.all(blocked)) assert.equal(r.status, 403);
  assert.equal((await send('/api/chat', { model: 'local/tiny:latest', messages: [{ role: 'user', content: 'hi' }] })).status, 200);
  assert.equal(mock.requests.length, count);
  await send('/api/settings', { privateMode: false }, 'PUT');
});

test('private mode writes no chat and no file to disk', async () => {
  await send('/api/settings', { privateMode: true }, 'PUT');
  const listFiles = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).filter((n) => fs.statSync(path.join(d, n)).isFile()).sort() : []);
  const stored = () => [...listFiles(path.join(dir, 'chats')), ...listFiles(path.join(dir, 'media'))];
  const beforeFiles = stored();
  const id = randomUUID();
  assert.equal((await send(`/api/chats/${id}`, { title: 'secret', messages: [] }, 'PUT')).status, 403);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const upload = await fetch(`${BASE}/api/media`, { method: 'POST', headers: { ...headers(), 'content-type': 'image/png' }, body: png });
  assert.equal(upload.status, 200);
  const media = (await upload.json()).id;
  assert.ok(media.startsWith('temp-'));
  assert.deepEqual(stored(), beforeFiles);

  const served = await get(`/media/${media}`);
  assert.equal(served.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png);
  assert.equal((await get(`/media/${media}`, { range: 'bytes=0-3' })).status, 206);
  const asked = await send('/api/chat', { model: 'local/tiny:latest', messages: [{ role: 'user', content: 'look', attachments: [{ id: media, kind: 'image' }] }] });
  assert.equal(asked.status, 200);
  await asked.text();
  assert.deepEqual(stored(), beforeFiles);

  const again = (await (await fetch(`${BASE}/api/media`, { method: 'POST', headers: { ...headers(), 'content-type': 'image/png' }, body: png })).json()).id;
  assert.equal((await send(`/api/media/${media}`, {}, 'DELETE')).status, 200);
  assert.equal((await get(`/media/${media}`)).status, 404);
  await send('/api/settings', { privateMode: false }, 'PUT');
  assert.equal((await get(`/media/${again}`)).status, 404);
  assert.equal((await send(`/api/chats/${id}`, { title: 'ok', messages: [] }, 'PUT')).status, 200);
  await send(`/api/chats/${id}`, {}, 'DELETE');
});

test('temporary files are erasable and do not survive a restart; others cannot be deleted this way', async () => {
  const a = await (await upload(Buffer.from('one'), '?temporary=1')).json();
  const b = await (await upload(Buffer.from('two'), '?temporary=1')).json();
  const kept = await (await upload(Buffer.from('three'))).json();
  assert.match(a.id, /^temp-/);
  await fetch(`${BASE}/api/media/${a.id}`, { method: 'DELETE', headers: headers() });
  assert.equal((await get(`/media/${a.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/media/${kept.id}`, { method: 'DELETE', headers: headers() })).status, 404);
  await restart();
  await new Promise((r) => { setTimeout(r, 200); });
  assert.equal((await get(`/media/${b.id}`)).status, 404);
  assert.equal((await get(`/media/${kept.id}`)).status, 200);
});

test('media is never kept in the browser cache', async () => {
  const { id } = await (await upload(Buffer.from('x'))).json();
  assert.equal((await get(`/media/${id}`)).headers.get('cache-control'), 'no-store');
});

test('retention deletes only old chats', async () => {
  const oldId = randomUUID(); const newId = randomUUID();
  await send(`/api/chats/${oldId}`, { title: 'old', updatedAt: Date.now() - 10 * 864e5, messages: [] }, 'PUT');
  await send(`/api/chats/${newId}`, { title: 'new', updatedAt: Date.now(), messages: [] }, 'PUT');
  assert.equal((await send('/api/settings', { retentionDays: 3 }, 'PUT')).status, 400);
  await send('/api/settings', { retentionDays: 7 }, 'PUT');
  const { chats } = await (await get('/api/chats')).json();
  assert.ok(chats.some((c) => c.id === newId));
  assert.ok(!chats.some((c) => c.id === oldId));
  await send('/api/settings', { retentionDays: 0 }, 'PUT');
});

test('files are encrypted, need a session, lock, survive a restart, and the passphrase can be changed', async () => {
  const chatId = randomUUID();
  await send(`/api/chats/${chatId}`, { title: SECRET, updatedAt: Date.now(), messages: [{ role: 'user', content: SECRET }] }, 'PUT');
  const big = Buffer.alloc(200 * 1024);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
  const { id: video } = await (await upload(big)).json();
  const onDisk = () => [
    ...fs.readdirSync(path.join(dir, 'chats')).map((f) => fs.readFileSync(path.join(dir, 'chats', f))),
    ...fs.readdirSync(path.join(dir, 'media')).map((f) => fs.readFileSync(path.join(dir, 'media', f))),
  ];
  assert.ok(onDisk().every((b) => !b.includes(SECRET) && !b.includes(big.subarray(1000, 1100))));

  // Reads through the session, including ranges across a block boundary.
  assert.equal((await (await get(`/api/chats/${chatId}`)).json()).title, SECRET);
  const range = await get(`/media/${video}`, { range: 'bytes=65500-65600' });
  assert.equal(range.status, 206);
  assert.ok(Buffer.from(await range.arrayBuffer()).equals(big.subarray(65500, 65601)));
  assert.ok(Buffer.from(await (await get(`/media/${video}`)).arrayBuffer()).equals(big));
  const { id: fresh } = await (await upload(Buffer.from('new plain bytes'))).json();
  assert.ok(!fs.readFileSync(path.join(dir, 'media', fresh)).includes('new plain bytes'));

  // Another program on this computer has no session, whatever headers it sends.
  signOut(BASE);
  assert.equal((await get('/api/chats')).status, 423);
  assert.equal((await get(`/media/${video}`)).status, 423);
  assert.equal((await send('/api/chat', { model: 'x', messages: [] })).status, 423);
  assert.equal((await send('/api/custom', { base: 'https://attacker.example/v1' }, 'PUT')).status, 423);
  assert.equal((await send('/api/settings', { privateMode: false }, 'PUT')).status, 423);
  assert.equal((await fetch(`${BASE}/api/chats`, { headers: { cookie: `local_ai_session=${'a'.repeat(64)}` } })).status, 423);
  // Locked, the app says nothing about your providers or settings.
  assert.deepEqual(await (await get('/api/status')).json(), { vault: 'locked' });
  await signIn(BASE);

  // Locking, then restarting, both need the passphrase again.
  await send('/api/lock', {});
  assert.equal((await get('/api/chats')).status, 423);
  signOut(BASE);
  await restart();
  signOut(BASE);
  assert.equal((await send('/api/unlock', { passphrase: '0000' })).status, 401);
  await signIn(BASE);
  assert.equal((await (await get(`/api/chats/${chatId}`)).json()).messages[0].content, SECRET);

  // A tampered file is refused rather than returned.
  const file = path.join(dir, 'media', fresh);
  const raw = fs.readFileSync(file);
  raw[raw.length - 1] ^= 1;
  fs.writeFileSync(file, raw);
  const tampered = await get(`/media/${fresh}`).then((r) => r.arrayBuffer()).catch(() => null);
  assert.ok(tampered === null || !Buffer.from(tampered).includes('new plain bytes'));
  fs.rmSync(file);

  // Changing the passphrase keeps every file readable and stops the old one working.
  const NEXT = '7310';
  assert.equal((await send('/api/vault/passphrase', { current: '0000', next: NEXT }, 'PUT')).status, 401);
  assert.equal((await send('/api/vault/passphrase', { current: PASS, next: '12345' }, 'PUT')).status, 400);
  const changed = await send('/api/vault/passphrase', { current: PASS, next: NEXT }, 'PUT');
  assert.equal(changed.status, 200);
  keepSession(BASE, changed);
  assert.ok(Buffer.from(await (await get(`/media/${video}`)).arrayBuffer()).equals(big));
  signOut(BASE);
  await restart({ enter: false });
  assert.equal((await send('/api/unlock', { passphrase: PASS })).status, 401);
  await signIn(BASE, NEXT);
  assert.equal((await (await get(`/api/chats/${chatId}`)).json()).title, SECRET);
  keepSession(BASE, await send('/api/vault/passphrase', { current: NEXT, next: PASS }, 'PUT'));
});

test('delete everything needs confirming, and keeps the key', async () => {
  assert.equal((await send('/api/wipe', {})).status, 400);
  assert.equal((await send('/api/wipe', { confirm: 'DELETE' })).status, 200);
  assert.deepEqual((await (await get('/api/chats')).json()).chats, []);
  assert.equal((await (await get('/api/status')).json()).hasKey, true);
});
