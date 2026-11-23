// Local AI server. Uses only Node built-ins, and listens on this computer only.
// It holds the API keys, stores chats on disk and relays requests to the cloud
// providers (Infero first, then MiniRouter and OpenRouter) or to Ollama.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { systemPrompt } from './prompt.js';
import { createVault, isSealedFile, plainSize } from './vault.js';
import { PROVIDERS, provider as providerById } from './providers.js';
import { fetchPublicFile, isLocalName } from './safe-fetch.js';
import { firstWith, isLocalId, providerOf, routeFor, searchHelpers, upstreamId } from './public/routing.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = process.env.LOCAL_AI_ENV_FILE || path.join(ROOT, '.env');
const DATA_DIR = process.env.LOCAL_AI_DATA_DIR || path.join(ROOT, 'data');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PUBLIC_DIR = path.join(ROOT, 'public');
const HOST = '127.0.0.1';
const MAX_BODY = 20 * 1024 * 1024;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const MODELS_TTL = 60 * 60 * 1000;
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const vault = createVault(path.join(DATA_DIR, 'vault.json'));

// Local models must really be local, so any other address is refused.
const OLLAMA = (() => {
  const fallback = 'http://127.0.0.1:11434';
  const wanted = process.env.LOCAL_AI_OLLAMA_URL || fallback;
  try {
    const { hostname } = new URL(wanted);
    if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return wanted.replace(/\/$/, '');
  } catch { /* use the default below */ }
  console.error('LOCAL_AI_OLLAMA_URL must point at this computer, so it was ignored.');
  return fallback;
})();
const MEDIA_TYPES = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};
const MEDIA_MIME = Object.fromEntries(Object.entries(MEDIA_TYPES).map(([mime, ext]) => [ext, mime]));

function readEnvFile() {
  try {
    const out = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
  } catch {
    return {};
  }
}

const fileEnv = readEnvFile();
const keys = Object.fromEntries(PROVIDERS.map((p) => [p.id, process.env[p.envKey] || fileEnv[p.envKey] || '']));
// The custom endpoint is set up in Settings: its address, a name, and a key only if it needs one.
const CUSTOM = providerById('custom');
CUSTOM.base = (process.env.CUSTOM_BASE_URL || fileEnv.CUSTOM_BASE_URL || '').replace(/\/$/, '');
CUSTOM.name = process.env.CUSTOM_NAME || fileEnv.CUSTOM_NAME || 'Custom endpoint';
// Whether a provider can be used: a key, or for the custom endpoint an address.
const usable = (p) => (p.custom ? Boolean(p.base) : Boolean(keys[p.id]));
const keyFlags = () => Object.fromEntries(PROVIDERS.map((p) => [p.id, usable(p)]));
const PORT = Number(process.env.PORT || fileEnv.PORT || 4317);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json',
};

// Only these installed packages are reachable from the browser.
const VENDOR = new Set([
  'chart.js', 'marked', 'dompurify', 'katex', 'mermaid', '@highlightjs/cdn-assets',
  '@fontsource-variable/jetbrains-mono',
]);

// connect-src 'self' means the page cannot send anything anywhere except this server,
// and img-src stops a model answer from loading a remote image to leak chat text.
const CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:", "img-src 'self' data: blob:", "media-src 'self' blob:", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Send JSON.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'This message is too large. The limit is 20 MB.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'The request was not valid JSON.');
  }
}

// Other websites open in your browser can reach localhost, so only requests
// addressed to this app, and originating from it, are accepted.
function isAllowedRequest(req) {
  const allowed = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowed.includes(req.headers.host)) return false;
  if (req.method === 'GET' || req.method === 'HEAD') {
    // The page and its scripts hold nothing private, so links from elsewhere can open the app.
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/') && !path.startsWith('/media/')) return true;
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin' || site === 'none';
  }
  return allowed.some((host) => req.headers.origin === `http://${host}`);
}

/* ---------- key ---------- */

// Sets or removes lines in .env, which only your user account can read.
async function writeEnv(values) {
  const lines = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const kept = lines.filter((l) => l.trim() && !Object.keys(values).some((name) => new RegExp(`^\\s*${name}\\s*=`).test(l)));
  for (const [name, value] of Object.entries(values)) if (value) kept.push(`${name}=${value}`);
  await fsp.writeFile(ENV_FILE, kept.join('\n') + '\n', { mode: 0o600 });
  await fsp.chmod(ENV_FILE, 0o600);
}

async function saveKey(p, key) {
  await writeEnv({ [p.envKey]: key });
  keys[p.id] = key;
  modelsCache.delete(p.id); // A new key may see a different catalogue.
}

// An empty address turns the custom endpoint off.
async function saveCustom(req, res) {
  const { base = '', name = '', key = '' } = await readJson(req);
  let address = '';
  if (base) {
    let url;
    try { url = new URL(String(base).trim()); } catch { throw new HttpError(400, 'Enter the full address, such as https://llm.example.com/v1.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new HttpError(400, 'Use an http or https address without a username or password in it.');
    }
    // Plain http would send your key and chats unencrypted, so it is only for this computer or network.
    if (url.protocol === 'http:' && !isLocalName(url.hostname)) {
      throw new HttpError(400, 'Use an https address. Plain http is only allowed for a server on this computer or your local network.');
    }
    address = url.href.replace(/\/$/, '');
  }
  const label = String(name).trim();
  if (label && !/^[\w .()-]{1,40}$/.test(label)) throw new HttpError(400, 'Use a short name, up to 40 letters, numbers and spaces.');
  if (typeof key !== 'string' || (key && !/^[\x21-\x7e]{1,500}$/.test(key.trim()))) throw new HttpError(400, 'That key has characters a key cannot have.');
  // A blank key keeps the saved one, unless the endpoint is being turned off.
  const nextKey = !address ? '' : key.trim() || keys.custom;
  await writeEnv({ CUSTOM_BASE_URL: address, CUSTOM_NAME: address ? label : '', CUSTOM_KEY: nextKey });
  Object.assign(CUSTOM, { base: address, name: (address && label) || 'Custom endpoint' });
  keys.custom = nextKey;
  modelsCache.delete('custom');
  return sendJson(res, 200, statusKeys());
}

/* ---------- settings ---------- */

// speakVia and transcribeVia are the providers chosen to read answers aloud and to write
// speech down, or 'auto' for the first one with a key.
// searchVia is the provider that searches for models whose own provider cannot.
// imageVia limits Image mode to one provider's models; the page applies it.
const settings = { privateMode: false, retentionDays: 0, autoLockMinutes: 15, speakVia: 'auto', transcribeVia: 'auto', searchVia: 'auto', imageVia: 'auto' };
const VOICE_JOBS = { speakVia: 'speak', transcribeVia: 'transcribe' };
try {
  Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
} catch { /* first run */ }

async function saveSettings() {
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fsp.writeFile(SETTINGS_FILE, JSON.stringify(settings), { mode: 0o600 });
}

/* ---------- lock ---------- */

const sessions = new Set();
let lastActive = Date.now();
let failedUnlocks = 0;
let unlockBlockedUntil = 0;

// Choosing the first passphrase needs a code only the person who started the app can see.
// Without it, another program on this computer could set the passphrase first.
const SETUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const setupCode = process.env.LOCAL_AI_SETUP_CODE
  || Array.from({ length: 8 }, () => SETUP_ALPHABET[randomInt(SETUP_ALPHABET.length)]).join('').replace(/^(....)/, '$1-');
const sameText = (a, b) => {
  const x = Buffer.from(String(a).toUpperCase().replace(/[^A-Z0-9]/g, ''));
  const y = Buffer.from(String(b).toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return x.length === y.length && timingSafeEqual(x, y);
};
// The passcode is 4 numbers, so guessing must be slow: after every 5 wrong
// tries the wait doubles, from 30 seconds up to an hour. Trying all 10,000 codes would take months.
let lockouts = 0;
const waitText = (ms) => (ms >= 90000 ? `${Math.ceil(ms / 60000)} minutes` : `${Math.ceil(ms / 1000)} seconds`);
function tooManyTries() {
  const left = unlockBlockedUntil - Date.now();
  if (left > 0) throw new HttpError(429, `Too many wrong tries. Wait ${waitText(left)} and try again.`);
}
function wrongTry(message) {
  failedUnlocks += 1;
  if (failedUnlocks >= 5) {
    failedUnlocks = 0;
    unlockBlockedUntil = Date.now() + Math.min(30000 * 2 ** lockouts, 3600000);
    lockouts += 1;
  }
  throw new HttpError(401, message);
}
const rightTry = () => { failedUnlocks = 0; lockouts = 0; };
const validPasscode = (text) => typeof text === 'string' && /^[0-9]{4}$/.test(text);

const sessionFrom = (req) => (req.headers.cookie || '').match(/(?:^|;\s*)local_ai_session=([a-f0-9]{64})/)?.[1];
const hasSession = (req) => vault.isOpen && sessions.has(sessionFrom(req));

function startSession(res) {
  const token = randomBytes(32).toString('hex');
  sessions.add(token);
  lastActive = Date.now();
  res.setHeader('set-cookie', `local_ai_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
}

function lockVault() {
  vault.lock();
  sessions.clear();
  memoryMedia.clear(); // Attachments held for Private mode go with the lock.
}

// 'setup' until a passphrase has been chosen. After that every browser must sign in with it.
function vaultState(req) {
  if (!vault.enabled) return 'setup';
  return hasSession(req) ? 'open' : 'locked';
}

setInterval(() => {
  if (vault.isOpen && settings.autoLockMinutes > 0 && Date.now() - lastActive > settings.autoLockMinutes * 60000) lockVault();
}, 15000).unref();

// Encrypts or decrypts everything already saved. Each file is checked first, so
// running it again after an interruption simply finishes the job.
async function convertAll(sealing) {
  await fsp.mkdir(CHATS_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  for (const name of await fsp.readdir(CHATS_DIR)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    const file = path.join(CHATS_DIR, name);
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (Boolean(parsed.sealed) === sealing) continue;
    const text = sealing ? vault.sealText(JSON.stringify(parsed), id) : vault.openText(parsed, id);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, text, { mode: 0o600 });
    await fsp.rename(tmp, file);
  }
  for (const id of await fsp.readdir(MEDIA_DIR)) {
    if (id.endsWith('.tmp')) { await fsp.rm(path.join(MEDIA_DIR, id), { force: true }); continue; }
    const file = path.join(MEDIA_DIR, id);
    if (await isSealedFile(file) === sealing) continue;
    await (sealing ? vault.sealFile(file, id) : vault.unsealFile(file, id));
  }
}

/* ---------- models on this computer ---------- */

// Ollama can also list models that really run on its cloud. Those are never offered here.
const isCloudTag = (m) => /(^|[-:])cloud$/i.test(m.name || m.model || '') || Boolean(m.remote_host || m.remote_model);

async function ollamaModels() {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { running: false, models: [] };
    const { models = [] } = await r.json();
    const list = await Promise.all(models.filter((m) => !isCloudTag(m)).map(async (m) => {
      const show = await fetch(`${OLLAMA}/api/show`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(3000),
      }).then((x) => (x.ok ? x.json() : {})).catch(() => ({}));
      if (isCloudTag(show)) return null;
      return {
        id: `local/${m.name}`, name: m.name, provider: 'On this computer', kind: 'chat', local: true,
        size: m.size || 0, input: 0, output: 0, canSearch: false,
        seesImages: Boolean(show.capabilities?.includes('vision')),
      };
    }));
    return { running: true, models: list.filter(Boolean) };
  } catch {
    return { running: false, models: [] };
  }
}

async function pullModel(req, res) {
  const { name } = await readJson(req);
  if (typeof name !== 'string' || !/^[a-z0-9][\w./-]*(:[\w.-]+)?$/i.test(name) || /(^|[-:])cloud$/i.test(name)) {
    throw new HttpError(400, 'Enter a model name from the Ollama library, such as gemma3:4b. Cloud models are not allowed.');
  }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  let r;
  try {
    r = await fetch(`${OLLAMA}/api/pull`, {
      method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: name, stream: true }),
    });
  } catch {
    throw new HttpError(503, 'Ollama is not running. Open it and try again.');
  }
  if (!r.ok) throw new HttpError(r.status, `Ollama could not download ${name}.`);
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  try {
    await pipeline(Readable.fromWeb(r.body), res);
  } catch {
    if (!res.destroyed) res.destroy();
  }
}

/* ---------- models ---------- */

// One cache per provider, so one that is down or slow never hides the others.
const modelsCache = new Map();

async function getModels() {
  const local = await ollamaModels();
  if (settings.privateMode) return local.models;
  const cloud = await getCloudModels().catch((err) => {
    if (!local.models.length) throw err;
    return [];
  });
  return [...local.models, ...cloud];
}

async function providerModels(p) {
  const cached = modelsCache.get(p.id);
  if (cached && Date.now() - cached.at < MODELS_TTL) return cached.list;
  const urls = p.catalogUrls ? p.catalogUrls() : p.catalogPaths.map((route) => `${p.base}${route}`);
  const pages = await Promise.all(urls.map(async (address) => {
    const r = await callUpstream(address, { headers: authHeaders(p, false), signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new HttpError(502, `${p.name} returned ${r.status} when listing models.`);
    return r.json();
  }));
  const list = p.parseModels(pages);
  modelsCache.set(p.id, { at: Date.now(), list });
  return list;
}

// Only providers you have a key for are listed, in order of preference.
async function getCloudModels() {
  const results = await Promise.allSettled(PROVIDERS.filter(usable).map(providerModels));
  const failed = results.filter((r) => r.status === 'rejected');
  for (const f of failed) console.error('Could not list models:', f.reason.message);
  if (results.length && failed.length === results.length) throw failed[0].reason;
  return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/* ---------- chats (one JSON file each, readable only by your user) ---------- */

const chatPath = (id) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'That chat ID is not valid.');
  return path.join(CHATS_DIR, `${id}.json`);
};

async function listChats() {
  await fsp.mkdir(CHATS_DIR, { recursive: true, mode: 0o700 });
  const files = (await fsp.readdir(CHATS_DIR)).filter((f) => f.endsWith('.json'));
  const chats = await Promise.all(files.map(async (f) => {
    try {
      const { id, title, updatedAt } = await readChat(f.slice(0, -5));
      return { id, title, updatedAt };
    } catch {
      return null;
    }
  }));
  return chats.filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function readChat(id) {
  const parsed = JSON.parse(await fsp.readFile(chatPath(id), 'utf8'));
  return parsed.sealed ? JSON.parse(vault.openText(parsed, id)) : parsed;
}

async function saveChat(id, chat) {
  const file = chatPath(id);
  await fsp.mkdir(CHATS_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const text = JSON.stringify({ ...chat, id });
  await fsp.writeFile(tmp, vault.isOpen ? vault.sealText(text, id) : text, { mode: 0o600 });
  await fsp.rename(tmp, file);
}

async function deleteChat(id) {
  const chat = await readChat(id).catch(() => ({}));
  await Promise.all(chatMediaIds(chat).map((m) => fsp.rm(mediaPath(m), { force: true }).catch(() => {})));
  await fsp.rm(chatPath(id), { force: true });
}

// Deletes chats past the age chosen in Settings. Encrypted chats wait until they are unlocked.
async function applyRetention() {
  if (!settings.retentionDays || (vault.enabled && !vault.isOpen)) return;
  const cutoff = Date.now() - settings.retentionDays * 864e5;
  for (const { id, updatedAt } of await listChats()) {
    if (updatedAt < cutoff) await deleteChat(id);
  }
}
setInterval(() => { applyRetention().catch((err) => console.error('Could not delete old chats:', err.message)); }, 60 * 60 * 1000).unref();

// Files from temporary chats are removed when the chat closes. This catches any
// left behind if the browser or this server quit first.
async function removeTemporaryFiles() {
  const names = await fsp.readdir(MEDIA_DIR).catch(() => []);
  await Promise.all(names.filter((n) => n.startsWith('temp-')).map((n) => fsp.rm(path.join(MEDIA_DIR, n), { force: true })));
}

async function wipeEverything() {
  memoryMedia.clear();
  await Promise.all([CHATS_DIR, MEDIA_DIR].map((dir) => fsp.rm(dir, { recursive: true, force: true })));
  await fsp.mkdir(CHATS_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
}

/* ---------- media (attachments and generated files, kept on this computer) ---------- */

const mediaPath = (id) => {
  if (typeof id !== 'string' || !/^[\w-]{1,120}\.(png|jpg|webp|gif|mp4|webm|mov)$/.test(id)) {
    throw new HttpError(400, 'That file ID is not valid.');
  }
  return path.join(MEDIA_DIR, id);
};

// Files attached in Private mode are held here and never touch the disk. They go
// when the chat closes, Private mode ends, the app locks or this server stops.
const memoryMedia = new Map();
const MAX_MEMORY_MEDIA = 512 * 1024 * 1024;
const memoryMediaSize = () => [...memoryMedia.values()].reduce((sum, data) => sum + data.length, 0);

async function holdInMemory(req, res, id, mime) {
  const parts = [];
  let size = memoryMediaSize();
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_MEMORY_MEDIA) throw new HttpError(413, 'Private mode keeps attachments in memory only, so they are limited to 512 MB in total. Remove one or attach a smaller file.');
    parts.push(chunk);
  }
  memoryMedia.set(id, Buffer.concat(parts));
  sendJson(res, 200, { id, mime });
}

const newMediaId = (ext, temporary) => `${temporary ? 'temp-' : ''}${randomUUID()}.${ext}`;
const sealStep = (id) => (vault.isOpen ? [vault.encryptStream(id)] : []);

async function uploadMedia(req, res, temporary) {
  const mime = (req.headers['content-type'] || '').split(';')[0];
  const ext = MEDIA_TYPES[mime];
  if (!ext) throw new HttpError(415, 'Attach a PNG, JPEG, WebP or GIF image, or an MP4, WebM or MOV video.');
  if (settings.privateMode) return holdInMemory(req, res, newMediaId(ext, true), mime);
  await fsp.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  const id = newMediaId(ext, temporary);
  let size = 0;
  const limiter = async function* (source) {
    for await (const chunk of source) {
      size += chunk.length;
      if (size > MAX_UPLOAD) throw new HttpError(413, 'This file is too large. The limit is 2 GB.');
      yield chunk;
    }
  };
  try {
    await pipeline(req, limiter, ...sealStep(id), fs.createWriteStream(mediaPath(id), { mode: 0o600 }));
  } catch (err) {
    await fsp.rm(mediaPath(id), { force: true });
    throw err;
  }
  sendJson(res, 200, { id, mime });
}

async function serveMedia(req, res, id) {
  const file = mediaPath(id);
  const held = memoryMedia.get(id);
  let stat;
  try {
    stat = held ? null : await fsp.stat(file);
  } catch {
    throw new HttpError(404, 'That file no longer exists.');
  }
  // no-store keeps a decrypted copy out of the browser's disk cache.
  const headers = {
    'content-type': MEDIA_MIME[path.extname(file).slice(1)],
    'accept-ranges': 'bytes', 'cache-control': 'no-store',
  };
  const sealed = !held && await isSealedFile(file);
  const size = held ? held.length : sealed ? plainSize(stat.size) : stat.size;
  const read = (start, end) => (held ? Readable.from([held.subarray(start, end + 1)]) : sealed ? Readable.from(vault.decryptRange(file, id, start, end)) : fs.createReadStream(file, { start, end }));
  const range = (req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(size - Number(range[2]), 0);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end) {
      res.writeHead(416, { 'content-range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}` });
    return pipeline(read(start, end), res);
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (!size) return res.end();
  return pipeline(read(0, size - 1), res);
}

async function readMedia(id, file) {
  if (!await isSealedFile(file)) return fsp.readFile(file);
  const parts = [];
  const size = plainSize((await fsp.stat(file)).size);
  if (size) for await (const part of vault.decryptRange(file, id, 0, size - 1)) parts.push(part);
  return Buffer.concat(parts);
}

async function dataUrl(id) {
  const file = mediaPath(id);
  const data = memoryMedia.get(id) || await readMedia(id, file).catch(() => {
    throw new HttpError(400, 'A file attached to this chat no longer exists.');
  });
  return `data:${MEDIA_MIME[path.extname(file).slice(1)]};base64,${data.toString('base64')}`;
}

async function saveGenerated(buffer, ext, temporary) {
  await fsp.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
  const id = newMediaId(ext, temporary);
  await pipeline(Readable.from([buffer]), ...sealStep(id), fs.createWriteStream(mediaPath(id), { mode: 0o600 }));
  return id;
}

function chatMediaIds(chat) {
  const ids = [];
  for (const m of chat.messages || []) {
    if (m.media?.id) ids.push(m.media.id);
    for (const a of m.attachments || []) {
      if (a.id) ids.push(a.id);
      for (const f of a.frames || []) if (f.id) ids.push(f.id);
    }
  }
  return ids;
}

/* ---------- upstream helpers ---------- */

const PRIVATE_MESSAGE = 'Private mode is on, so nothing can leave this computer. Turn it off to use this.';

function requireKey(p) {
  if (settings.privateMode) throw new HttpError(403, PRIVATE_MESSAGE);
  if (!usable(p)) throw new HttpError(401, p.custom ? 'Set up the custom endpoint in Settings to continue.' : `Add your ${p.name} key in Settings to continue.`);
}

// The provider for a voice job: the one chosen in Settings while it has a key,
// otherwise the first that can, in order of preference. Infero comes first.
function voiceProvider(setting) {
  const job = VOICE_JOBS[setting];
  const flags = keyFlags();
  const chosen = providerById(settings[setting]);
  if (chosen?.supports[job] && flags[chosen.id]) return chosen;
  const found = firstWith(job, flags);
  return found ? providerById(found.id) : null;
}

function requireVoiceProvider(setting) {
  if (settings.privateMode) throw new HttpError(403, PRIVATE_MESSAGE);
  const p = voiceProvider(setting);
  if (!p) throw new HttpError(401, 'Add a key in Settings for a provider that can do this, such as Infero.');
  return p;
}

const voiceOptions = (setting) => PROVIDERS.filter((p) => p.supports[VOICE_JOBS[setting]] && keyFlags()[p.id]).map((p) => ({ id: p.id, name: p.name }));

const authHeaders = (p, json = true) => ({
  ...(keys[p.id] ? { authorization: `Bearer ${keys[p.id]}` } : {}),
  ...(json ? { 'content-type': 'application/json' } : {}),
});

async function upstreamError(r, p) {
  const text = await r.text();
  let message = text.slice(0, 500);
  try {
    const parsed = JSON.parse(text);
    message = parsed.error?.message || parsed.error || parsed.message || message;
  } catch { /* keep the raw text */ }
  if (typeof message !== 'string') message = JSON.stringify(message).slice(0, 500);
  const hint = r.status === 401 ? ` Check your ${p.name} key in Settings.`
    : r.status === 402 ? ` Add credit to your ${p.name} account, or choose a model from another provider.` : '';
  return new HttpError(r.status, `${p.name} returned ${r.status}: ${message}${hint}`);
}

// Every request to the cloud passes through here, so Private mode cannot be missed.
async function callUpstream(url, init) {
  if (settings.privateMode) throw new HttpError(403, PRIVATE_MESSAGE);
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    const host = PROVIDERS.find((p) => p.base && url.startsWith(p.base))?.name || 'the provider';
    throw new HttpError(502, `Could not reach ${host}: ${err.cause?.code || err.message}. Check your connection and try again.`);
  }
}

async function findModel(id, kind) {
  const model = (await getModels()).find((m) => m.id === id && m.kind === kind);
  if (!model) throw new HttpError(400, `${id} is not available for this request. Choose another model.`);
  return model;
}

/* ---------- chat relay ---------- */

async function buildMessage({ role, content, attachments, media }) {
  if (!['user', 'assistant'].includes(role)) throw new HttpError(400, 'A message in this chat is malformed.');
  const text = typeof content === 'string' ? content : '';
  if (role === 'assistant') {
    return { role, content: text || (media ? `(Generated a ${media.kind} for the user.)` : '(No answer.)') };
  }
  if (!attachments?.length) return { role, content: text };

  const parts = [];
  for (const a of attachments) {
    if (a.kind === 'video') {
      // Videos go as still frames, the documented input that every vision model accepts.
      const times = (a.frames || []).map((f) => `${Math.round(f.t)}s`).join(', ');
      parts.push({ type: 'text', text: `The user attached a video, "${a.name}". These are still frames from it at ${times}. There is no audio.` });
      for (const f of a.frames || []) parts.push({ type: 'image_url', image_url: { url: await dataUrl(f.id) } });
    } else {
      parts.push({ type: 'image_url', image_url: { url: await dataUrl(a.id) } });
    }
  }
  parts.push({ type: 'text', text: text || 'Describe what you see.' });
  return { role, content: parts };
}

// Answers from a model on this computer. There is no fallback to the cloud.
async function relayLocal(res, model, clean) {
  const { running, models } = await ollamaModels();
  if (!running) throw new HttpError(503, 'Ollama is not running, so this model cannot answer. Open Ollama and try again. Nothing was sent anywhere.');
  if (!models.some((m) => m.id === model)) throw new HttpError(400, `${model.slice(6)} is not installed on this computer. Choose another model.`);
  const abort = new AbortController();
  res.on('close', () => abort.abort());
  let upstream;
  try {
    upstream = await fetch(`${OLLAMA}/v1/chat/completions`, {
      method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: model.slice(6), stream: true,
        messages: [{ role: 'system', content: systemPrompt({ local: true }) }, ...clean],
      }),
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    throw new HttpError(503, 'Ollama stopped responding. Open it and try again. Nothing was sent anywhere.');
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    let message = text.slice(0, 300);
    try { message = JSON.parse(text).error?.message || message; } catch { /* keep the raw text */ }
    throw new HttpError(upstream.status, `Ollama returned ${upstream.status}: ${message}`);
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-served-model': model, 'x-search-available': 'false' });
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    if (!abort.signal.aborted) console.error('Stream ended early:', err.code || err.message);
    if (!res.destroyed) res.destroy();
  }
}

async function relayChat(req, res) {
  const { model, messages, web, masked } = await readJson(req);
  if (typeof model !== 'string' || !Array.isArray(messages) || !messages.length) {
    throw new HttpError(400, 'A model and at least one message are required.');
  }
  if (isLocalId(model)) return relayLocal(res, model, await Promise.all(messages.map(buildMessage)));
  if (settings.privateMode) throw new HttpError(403, PRIVATE_MESSAGE);
  // A model whose provider cannot search hands a question that needs search to
  // one that can. The page shows the same destination before you send.
  const models = await getModels().catch(() => []);
  const route = routeFor(model, Boolean(web), { models, keys: keyFlags(), searchVia: settings.searchVia });
  const p = providerById(providerOf(route.model).id);
  requireKey(p);
  const clean = await Promise.all(messages.map(buildMessage));
  const wantsSearch = route.search;

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const send = (search) => callUpstream(`${p.base}/chat/completions`, {
    method: 'POST',
    signal: abort.signal,
    headers: authHeaders(p),
    body: JSON.stringify({
      model: upstreamId(route.model),
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'system', content: systemPrompt({ search, masked: Boolean(masked) }) }, ...clean],
      ...(search ? p.searchBody() : {}),
    }),
  });

  let upstream;
  let searched = wantsSearch;
  try {
    upstream = await send(wantsSearch);
    // Some routes reject server tools. Answer without search rather than fail.
    if (wantsSearch && upstream.status === 400) {
      await upstream.body?.cancel();
      searched = false;
      upstream = await send(false);
    }
  } catch (err) {
    if (abort.signal.aborted) return;
    throw err;
  }
  if (!upstream.ok) throw await upstreamError(upstream, p);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    'x-served-model': (p.servedHeader && upstream.headers.get(p.servedHeader)) || route.model,
    'x-served-via': p.id,
    'x-handed-off': route.handedOff ? 'true' : 'false',
    'x-balance-usd': (p.balanceHeader && upstream.headers.get(p.balanceHeader)) || '',
    'x-search-available': String(searched),
  });
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (err) {
    // A stopped answer closes the stream on purpose. Anything else is a dropped
    // connection, which the browser sees as an answer that ended early.
    if (!abort.signal.aborted) console.error('Stream ended early:', err.code || err.message);
    if (!res.destroyed) res.destroy();
  }
  return undefined;
}

/* ---------- voice ---------- */

const MAX_AUDIO = 8 * 1024 * 1024;

// The voices the provider that reads answers aloud offers, for Settings.
function voiceChoice() {
  const p = voiceProvider('speakVia');
  return p ? { via: p.id, name: p.name, list: p.voices, limit: p.speakLimit || 4096 } : null;
}

// What the page needs to know about providers. Never the keys themselves.
const statusKeys = () => ({
  hasKey: Object.values(keyFlags()).some(Boolean), keys: keyFlags(), voices: voiceChoice(),
  transcriber: voiceProvider('transcribeVia')?.name || null,
  speakVia: settings.speakVia, speakOptions: voiceOptions('speakVia'),
  transcribeVia: settings.transcribeVia, transcribeOptions: voiceOptions('transcribeVia'),
  searchVia: settings.searchVia, searchOptions: searchHelpers(keyFlags()).map((p) => ({ id: p.id, name: p.name })),
  imageVia: settings.imageVia, imageOptions: PROVIDERS.filter((p) => p.supports.image && keyFlags()[p.id]).map((p) => ({ id: p.id, name: p.name })),
  custom: CUSTOM.base ? { name: CUSTOM.name, base: CUSTOM.base, hasKey: Boolean(keys.custom) } : null,
});

// Recordings are held in memory only for this request and never written to disk.
async function transcribe(req, res) {
  const p = requireVoiceProvider('transcribeVia');
  if ((req.headers['content-type'] || '').split(';')[0] !== 'audio/wav') throw new HttpError(415, 'Send a WAV recording.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_AUDIO) throw new HttpError(413, 'This recording is too long. The limit is about 4 minutes.');
    chunks.push(chunk);
  }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  // Some providers take the recording as JSON, others as a file upload.
  const { json, form } = p.transcribeBody(Buffer.concat(chunks));
  const r = await callUpstream(p.transcribeUrl ? p.transcribeUrl() : `${p.base}/audio/transcriptions`, {
    method: 'POST', signal: abort.signal, headers: authHeaders(p, Boolean(json)),
    body: json ? JSON.stringify(json) : form,
  });
  if (!r.ok) throw await upstreamError(r, p);
  const { text } = await r.json();
  sendJson(res, 200, { text: (text || '').trim() });
}

async function speak(req, res) {
  const p = requireVoiceProvider('speakVia');
  const { text, voice } = await readJson(req);
  const limit = p.speakLimit || 4096;
  if (typeof text !== 'string' || !text.trim() || text.length > limit) {
    throw new HttpError(400, `Each piece of text to read must be 1 to ${limit.toLocaleString('en')} characters for ${p.name}.`);
  }
  if (!p.voices.some((v) => v.id === voice)) throw new HttpError(400, 'Choose one of the voices in Settings.');
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  const r = await callUpstream(p.speakUrl ? p.speakUrl() : `${p.base}/audio/speech`, {
    method: 'POST', signal: abort.signal, headers: authHeaders(p),
    body: JSON.stringify(p.speakBody(text, voice)),
  });
  if (!r.ok) throw await upstreamError(r, p);
  res.writeHead(200, { 'content-type': r.headers.get('content-type') || 'audio/mpeg', 'cache-control': 'no-store' });
  try {
    await pipeline(Readable.fromWeb(r.body), res);
  } catch (err) {
    if (!abort.signal.aborted) console.error('Audio ended early:', err.code || err.message);
    if (!res.destroyed) res.destroy();
  }
}

/* ---------- image and video generation ---------- */

async function generateImage(req, res) {
  const { model, prompt, temporary } = await readJson(req);
  const p = providerById(providerOf(model).id);
  requireKey(p);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'Describe the image you want.');
  const info = await findModel(model, 'image');
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableEnded) abort.abort(); });
  const r = await callUpstream(`${p.base}${p.imagePath}`, {
    method: 'POST', signal: abort.signal, headers: authHeaders(p),
    body: JSON.stringify(p.imageBody(upstreamId(model), prompt, info.imageRequired)),
  });
  if (!r.ok) throw await upstreamError(r, p);
  const body = await r.json();
  const item = body.data?.[0];
  let buffer;
  if (item?.b64_json) buffer = Buffer.from(item.b64_json, 'base64');
  else if (item?.url) {
    // The provider chose this address, so it must be a public one, and what comes back must be a picture.
    buffer = await fetchPublicFile(String(item.url), { fetcher: callUpstream, signal: abort.signal }).catch((err) => {
      if (err instanceof HttpError || abort.signal.aborted) throw err;
      throw new HttpError(502, `${p.name} sent a link to the image that this app will not open: it ${err.message}.`);
    });
  } else throw new HttpError(502, `${p.name} returned no image. Try again or choose another model.`);
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isWebp = buffer.subarray(8, 12).toString() === 'WEBP';
  const isPng = buffer.subarray(1, 4).toString() === 'PNG';
  if (!isJpeg && !isWebp && !isPng) throw new HttpError(502, `${p.name} did not return a PNG, JPEG or WebP image. Try again or choose another model.`);
  const id = await saveGenerated(buffer, isJpeg ? 'jpg' : isWebp ? 'webp' : 'png', Boolean(temporary));
  sendJson(res, 200, {
    media: { kind: 'image', id },
    cost: Number(p.costHeader && r.headers.get(p.costHeader)) || body.usage?.cost || null,
  });
}

// Only MiniRouter makes videos, so video jobs always belong to it.
const VIDEO = providerById('minirouter');

async function createVideo(req, res) {
  requireKey(VIDEO);
  const { model, prompt, seconds, size } = await readJson(req);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'Describe the video you want.');
  await findModel(model, 'video');
  if (providerOf(model).id !== VIDEO.id) throw new HttpError(400, `${model} cannot make videos. Choose another model.`);
  const r = await callUpstream(`${VIDEO.base}/videos`, {
    method: 'POST', headers: authHeaders(VIDEO), body: JSON.stringify({ model, prompt, seconds, size }),
  });
  if (!r.ok) throw await upstreamError(r, VIDEO);
  const job = await r.json();
  sendJson(res, 200, { jobId: job.id, status: job.status });
}

async function pollVideo(res, jobId) {
  requireKey(VIDEO);
  if (!/^[\w.:-]{1,200}$/.test(jobId)) throw new HttpError(400, 'That video ID is not valid.');
  const base = `${VIDEO.base}/videos/${encodeURIComponent(jobId)}`;
  const r = await callUpstream(base, { headers: authHeaders(VIDEO) });
  if (!r.ok) throw await upstreamError(r, VIDEO);
  const job = await r.json();
  if (job.status === 'failed') {
    const reason = job.error?.message || job.error || 'The provider could not make this video.';
    return sendJson(res, 200, { status: 'failed', error: `${reason} You were not charged.` });
  }
  if (job.status !== 'completed') return sendJson(res, 200, { status: job.status, progress: job.progress ?? 0 });

  const id = `video-${jobId.replace(/[^\w-]/g, '_').slice(0, 100)}.mp4`;
  if (!fs.existsSync(mediaPath(id))) {
    const file = await callUpstream(`${base}/content`, { headers: authHeaders(VIDEO) });
    if (!file.ok) throw await upstreamError(file, VIDEO);
    await fsp.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
    const tmp = `${mediaPath(id)}.tmp`;
    await pipeline(Readable.fromWeb(file.body), ...sealStep(id), fs.createWriteStream(tmp, { mode: 0o600 }));
    await fsp.rename(tmp, mediaPath(id));
  }
  return sendJson(res, 200, { status: 'completed', media: { kind: 'video', id }, cost: job.cost?.usd ?? null });
}

/* ---------- static files ---------- */

async function serveStatic(res, urlPath) {
  let base = PUBLIC_DIR;
  let rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  if (urlPath.startsWith('/vendor/')) {
    const parts = urlPath.slice('/vendor/'.length).split('/');
    const pkgLen = parts[0].startsWith('@') ? 2 : 1;
    const pkg = parts.slice(0, pkgLen).join('/');
    if (!VENDOR.has(pkg)) throw new HttpError(404, 'Not found.');
    base = path.join(ROOT, 'node_modules', pkg);
    rel = parts.slice(pkgLen).join('/');
  }
  const file = path.resolve(base, rel);
  const type = CONTENT_TYPES[path.extname(file)];
  if (!type || !file.startsWith(base + path.sep)) throw new HttpError(404, 'Not found.');
  let data;
  try {
    data = await fsp.readFile(file);
  } catch {
    throw new HttpError(404, 'Not found.');
  }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  res.end(data);
}

/* ---------- privacy settings ---------- */

async function unlock(req, res) {
  if (!vault.enabled) throw new HttpError(409, 'Choose a passcode first.');
  tooManyTries();
  const { passphrase } = await readJson(req);
  // Another browser unlocking must prove the passphrase too, even while the vault is open.
  const good = typeof passphrase === 'string' && (vault.isOpen ? await vault.check(passphrase) : await vault.unlock(passphrase));
  if (!good) wrongTry('That passcode is not right.');
  rightTry();
  await convertAll(true); // Finishes any encryption that was interrupted.
  await applyRetention();
  startSession(res);
  return sendJson(res, 200, { ok: true });
}

// First run: choose the passphrase that protects the app from then on.
async function enableVault(req, res) {
  if (vault.enabled) throw new HttpError(409, 'A passcode has already been chosen.');
  tooManyTries();
  const { passphrase, code } = await readJson(req);
  if (typeof code !== 'string' || !sameText(code, setupCode)) wrongTry('That setup code is not right. It is shown in the terminal where the app was started.');
  rightTry();
  if (!validPasscode(passphrase)) throw new HttpError(400, 'Use exactly 4 numbers.');
  await fsp.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await vault.create(passphrase);
  startSession(res);
  await convertAll(true);
  return sendJson(res, 200, { ok: true });
}

// Other browsers are signed out; this one stays in.
async function changePassphrase(req, res) {
  tooManyTries();
  const { current, next } = await readJson(req);
  if (!validPasscode(next)) throw new HttpError(400, 'Use exactly 4 numbers.');
  if (typeof current !== 'string' || !await vault.changePassphrase(current, next)) wrongTry('Your current passcode is not right.');
  rightTry();
  sessions.clear();
  startSession(res);
  return sendJson(res, 200, { ok: true });
}

async function updateSettings(req, res) {
  const body = await readJson(req);
  const { privateMode, retentionDays, autoLockMinutes, searchVia, imageVia } = body;
  if (imageVia !== undefined) {
    if (imageVia !== 'auto' && !providerById(imageVia)?.supports.image) throw new HttpError(400, 'Choose one of the listed providers.');
    settings.imageVia = imageVia;
  }
  if (searchVia !== undefined) {
    const helper = providerById(searchVia);
    if (searchVia !== 'auto' && !(helper?.supports.search && helper.autoModel)) throw new HttpError(400, 'Choose one of the listed providers.');
    settings.searchVia = searchVia;
  }
  for (const [setting, job] of Object.entries(VOICE_JOBS)) {
    const value = body[setting];
    if (value === undefined) continue;
    if (value !== 'auto' && !providerById(value)?.supports[job]) throw new HttpError(400, 'Choose one of the listed providers.');
    settings[setting] = value;
  }
  if (privateMode !== undefined) {
    settings.privateMode = Boolean(privateMode);
    if (!settings.privateMode) memoryMedia.clear();
  }
  if (retentionDays !== undefined) {
    if (![0, 1, 7, 30, 90].includes(retentionDays)) throw new HttpError(400, 'Choose one of the listed periods.');
    settings.retentionDays = retentionDays;
  }
  if (autoLockMinutes !== undefined) {
    if (![0, 5, 15, 60].includes(autoLockMinutes)) throw new HttpError(400, 'Choose one of the listed times.');
    settings.autoLockMinutes = autoLockMinutes;
  }
  await saveSettings();
  await applyRetention();
  return sendJson(res, 200, { ok: true });
}

/* ---------- routes ---------- */

async function handle(req, res) {
  let url;
  let p;
  try {
    url = new URL(req.url, `http://${HOST}`);
    p = decodeURIComponent(url.pathname);
  } catch {
    throw new HttpError(400, 'That address is not valid.');
  }
  const { method } = req;

  if (p === '/api/status' && method === 'GET') {
    // Before signing in, only whether the app is locked. After, which providers have
    // a key, never the keys themselves.
    if (!hasSession(req)) return sendJson(res, 200, { vault: vaultState(req) });
    return sendJson(res, 200, {
      ...statusKeys(),
      vault: 'open', privateMode: settings.privateMode,
      retentionDays: settings.retentionDays, autoLockMinutes: settings.autoLockMinutes,
    });
  }
  if (p === '/api/unlock' && method === 'POST') return unlock(req, res);
  if (p === '/api/vault/enable' && method === 'POST') return enableVault(req, res);
  // The terms, privacy notice and license are the repository's own files, so the app
  // and the repository always say the same thing. They hold nothing private.
  const legal = { '/legal/terms': 'TERMS.md', '/legal/privacy': 'PRIVACY.md', '/legal/license': 'LICENSE' }[p];
  if (legal && method === 'GET') {
    const text = await fsp.readFile(path.join(ROOT, legal), 'utf8').catch(() => null);
    if (text === null) throw new HttpError(404, 'Not found.');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(text);
  }
  // Everything else needs the session you get by entering the passphrase. Checking where a
  // request came from stops other websites, but any program on this computer can fake that.
  const guarded = p.startsWith('/api/') || p.startsWith('/media/');
  if (guarded && !hasSession(req)) throw new HttpError(423, vault.enabled ? 'Unlock the app to continue.' : 'Choose a passcode to continue.');
  if (guarded && !p.startsWith('/api/videos/')) lastActive = Date.now();

  if (!p.startsWith('/api/')) {
    if (method !== 'GET') throw new HttpError(405, 'Method not allowed.');
    const media = p.match(/^\/media\/([^/]+)$/);
    return media ? serveMedia(req, res, media[1]) : serveStatic(res, p);
  }
  if (p === '/api/activity' && method === 'POST') return sendJson(res, 200, { ok: true });
  if (p === '/api/lock' && method === 'POST') {
    lockVault();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/vault/passphrase' && method === 'PUT') return changePassphrase(req, res);
  if (p === '/api/settings' && method === 'PUT') return updateSettings(req, res);
  if (p === '/api/wipe' && method === 'POST') {
    const { confirm } = await readJson(req);
    if (confirm !== 'DELETE') throw new HttpError(400, 'Confirm before deleting everything.');
    await wipeEverything();
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/local/pull' && method === 'POST') return pullModel(req, res);
  if (p === '/api/key' && method === 'PUT') {
    const { key, provider = 'minirouter' } = await readJson(req);
    const p = providerById(provider);
    if (!p || p.custom) throw new HttpError(400, 'Choose one of the providers in Settings.');
    if (typeof key !== 'string' || !/^[\w-]{16,200}$/.test(key.trim())) {
      throw new HttpError(400, `That does not look like a ${p.name} key. ${p.keyHint}`);
    }
    await saveKey(p, key.trim());
    return sendJson(res, 200, statusKeys());
  }
  if (p === '/api/custom' && method === 'PUT') return saveCustom(req, res);
  if (p === '/api/models' && method === 'GET') {
    const models = await getModels();
    return sendJson(res, 200, { models, ollama: (await ollamaModels()).running });
  }
  if (p === '/api/chat' && method === 'POST') return relayChat(req, res);
  if (p === '/api/media' && method === 'POST') return uploadMedia(req, res, url.searchParams.get('temporary') === '1');
  const temp = p.match(/^\/api\/media\/(temp-[^/]+)$/);
  if (temp && method === 'DELETE') {
    memoryMedia.delete(temp[1]);
    await fsp.rm(mediaPath(temp[1]), { force: true });
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/transcribe' && method === 'POST') return transcribe(req, res);
  if (p === '/api/speak' && method === 'POST') return speak(req, res);
  if (p === '/api/images' && method === 'POST') return generateImage(req, res);
  if (p === '/api/videos' && method === 'POST') return createVideo(req, res);
  const job = p.match(/^\/api\/videos\/([^/]+)$/);
  if (job && method === 'GET') return pollVideo(res, job[1]);
  if (p === '/api/chats' && method === 'GET') return sendJson(res, 200, { chats: await listChats() });

  const m = p.match(/^\/api\/chats\/([^/]+)$/);
  if (m) {
    const file = chatPath(m[1]);
    if (method === 'GET') {
      try {
        return sendJson(res, 200, await readChat(m[1]));
      } catch {
        throw new HttpError(404, 'That chat no longer exists.');
      }
    }
    if (method === 'PUT') {
      if (settings.privateMode) throw new HttpError(403, 'Private mode is on, so this chat was not saved.');
      await saveChat(m[1], await readJson(req));
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'DELETE') {
      await deleteChat(m[1]);
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Not found.');
}

const server = http.createServer(async (req, res) => {
  res.setHeader('content-security-policy', CSP);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  try {
    if (!isAllowedRequest(req)) throw new HttpError(403, 'This app only accepts requests from itself.');
    await handle(req, res);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) { res.destroy(); return; }
    const status = err instanceof HttpError ? err.status : 500;
    sendJson(res, status, { error: err instanceof HttpError ? err.message : 'Something failed in the local server. See its terminal for details.' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT in .env to use another one.`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Local AI is running at http://localhost:${PORT}`);
  if (!vault.enabled) console.log(`First run: open it and choose a passcode. Your setup code is ${setupCode}`);
  if (!Object.values(keys).some(Boolean)) console.log('No provider key yet. Paste your Infero key into the app when it opens.');
  removeTemporaryFiles().catch(() => {});
  applyRetention().catch((err) => console.error('Could not delete old chats:', err.message));
});
