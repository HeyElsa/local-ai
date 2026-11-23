// Optional encryption for chats and files. A random data key encrypts everything,
// and your passphrase encrypts that key. The data key is only ever held in memory.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };
const MAGIC = Buffer.from('LAIV1');
const SALT_BYTES = 16;
const HEADER = MAGIC.length + SALT_BYTES;
const BLOCK = 64 * 1024; // Files are sealed in blocks, so a video can seek without decrypting all of it.
const TAG = 16;

const stretch = (passphrase, salt) => new Promise((resolve, reject) => {
  scrypt(passphrase.normalize('NFKC'), salt, 32, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
});

function seal(key, data, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const out = Buffer.concat([cipher.update(data), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: out.toString('base64') };
}

function open(key, box, aad) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]);
}

const fileKey = (dataKey, salt, id) => Buffer.from(hkdfSync('sha256', dataKey, salt, `media:${id}`, 32));

function nonce(index) {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(BigInt(index), 4);
  return iv;
}

// The last block is marked, so cutting blocks off the end of a file is detected.
const blockAad = (isLast) => Buffer.from([isLast ? 1 : 0]);

export function plainSize(sealedSize) {
  const body = sealedSize - HEADER;
  return body - Math.ceil(body / (BLOCK + TAG)) * TAG;
}

export function createVault(file) {
  let dataKey = null;

  return {
    get enabled() { return fs.existsSync(file); },
    get isOpen() { return Boolean(dataKey); },

    async create(passphrase) {
      const salt = randomBytes(16);
      const key = randomBytes(32);
      const wrapped = seal(await stretch(passphrase, salt), key, MAGIC);
      // Written before anything is encrypted, so a crash part way can never lose the key.
      const tmp = `${file}.tmp`;
      const handle = await fsp.open(tmp, 'w', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, salt: salt.toString('base64'), wrapped }));
      await handle.sync();
      await handle.close();
      await fsp.rename(tmp, file);
      dataKey = key;
    },

    async unlock(passphrase) {
      const { salt, wrapped } = JSON.parse(await fsp.readFile(file, 'utf8'));
      try {
        dataKey = open(await stretch(passphrase, Buffer.from(salt, 'base64')), wrapped, MAGIC);
        return true;
      } catch {
        return false;
      }
    },

    // Checks a passphrase without changing whether the vault is open.
    async check(passphrase) {
      const { salt, wrapped } = JSON.parse(await fsp.readFile(file, 'utf8'));
      try {
        open(await stretch(passphrase, Buffer.from(salt, 'base64')), wrapped, MAGIC).fill(0);
        return true;
      } catch {
        return false;
      }
    },

    // Protects the same data key with a new passphrase. Nothing else needs re-encrypting.
    async changePassphrase(current, next) {
      const { salt, wrapped } = JSON.parse(await fsp.readFile(file, 'utf8'));
      let key;
      try {
        key = open(await stretch(current, Buffer.from(salt, 'base64')), wrapped, MAGIC);
      } catch {
        return false;
      }
      const newSalt = randomBytes(16);
      const rewrapped = seal(await stretch(next, newSalt), key, MAGIC);
      key.fill(0);
      const tmp = `${file}.tmp`;
      const handle = await fsp.open(tmp, 'w', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, salt: newSalt.toString('base64'), wrapped: rewrapped }));
      await handle.sync();
      await handle.close();
      await fsp.rename(tmp, file);
      return true;
    },

    lock() {
      dataKey?.fill(0);
      dataKey = null;
    },

    async remove() {
      this.lock();
      await fsp.rm(file, { force: true });
    },

    sealText(text, id) {
      return JSON.stringify({ sealed: 1, ...seal(dataKey, Buffer.from(text), Buffer.from(id)) });
    },

    openText(box, id) {
      return open(dataKey, box, Buffer.from(id)).toString('utf8');
    },

    // A pipeline step that encrypts a stream as it is written.
    encryptStream(id) {
      const key = dataKey;
      return async function* encrypt(source) {
        const salt = randomBytes(SALT_BYTES);
        const perFile = fileKey(key, salt, id);
        yield Buffer.concat([MAGIC, salt]);
        let index = 0;
        const block = (data, isLast) => {
          const cipher = createCipheriv('aes-256-gcm', perFile, nonce(index));
          index += 1;
          cipher.setAAD(blockAad(isLast));
          return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);
        };
        let held = Buffer.alloc(0);
        for await (const chunk of source) {
          held = held.length ? Buffer.concat([held, chunk]) : Buffer.from(chunk);
          // Always hold back a full block: only the end of the stream can be marked as last.
          while (held.length > BLOCK) {
            yield block(held.subarray(0, BLOCK), false);
            held = held.subarray(BLOCK);
          }
        }
        yield block(held, true);
      };
    },

    // Yields the plain bytes from start to end inclusive, checking each block it reads.
    async* decryptRange(path, id, start, end) {
      const handle = await fsp.open(path, 'r');
      try {
        const { size } = await handle.stat();
        const header = Buffer.alloc(HEADER);
        await handle.read(header, 0, HEADER, 0);
        const perFile = fileKey(dataKey, header.subarray(MAGIC.length), id);
        const blocks = Math.max(1, Math.ceil((size - HEADER) / (BLOCK + TAG)));
        const first = Math.floor(start / BLOCK);
        const last = Math.min(Math.floor(end / BLOCK), blocks - 1);
        for (let i = first; i <= last; i += 1) {
          const at = HEADER + i * (BLOCK + TAG);
          const length = Math.min(BLOCK + TAG, size - at);
          const sealed = Buffer.alloc(length);
          await handle.read(sealed, 0, length, at);
          const decipher = createDecipheriv('aes-256-gcm', perFile, nonce(i));
          decipher.setAAD(blockAad(i === blocks - 1));
          decipher.setAuthTag(sealed.subarray(length - TAG));
          const plain = Buffer.concat([decipher.update(sealed.subarray(0, length - TAG)), decipher.final()]);
          const from = i === first ? start - i * BLOCK : 0;
          const to = i === last ? end - i * BLOCK + 1 : plain.length;
          yield plain.subarray(from, to);
        }
      } finally {
        await handle.close();
      }
    },

    async sealFile(path, id) {
      const tmp = `${path}.tmp`;
      await pipeline(fs.createReadStream(path), this.encryptStream(id), fs.createWriteStream(tmp, { mode: 0o600 }));
      await fsp.rename(tmp, path);
    },

    async unsealFile(path, id) {
      const { size } = await fsp.stat(path);
      const tmp = `${path}.tmp`;
      const output = fs.createWriteStream(tmp, { mode: 0o600 });
      const total = plainSize(size);
      if (total > 0) await pipeline(this.decryptRange(path, id, 0, total - 1), output);
      else await fsp.writeFile(tmp, '', { mode: 0o600 });
      await fsp.rename(tmp, path);
    },
  };
}

export async function isSealedFile(path) {
  const handle = await fsp.open(path, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length);
    await handle.read(head, 0, MAGIC.length, 0);
    return head.equals(MAGIC);
  } finally {
    await handle.close();
  }
}
