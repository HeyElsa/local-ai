// Downloads a file from an address a provider chose. A provider must not be able
// to make this computer fetch its own services or anything on the local network.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

// True for addresses on this computer, a private network, or otherwise not on the public internet.
export function isPrivateAddress(address) {
  const ip = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(ip) === 6) {
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    return ip === '::' || ip === '::1' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || /^ff/.test(ip) || ip.startsWith('::ffff:') || ip.startsWith('64:ff9b:');
  }
  return true; // Not an address at all.
}

// Names that only mean something on this computer or the local network.
export const isLocalName = (hostname) => {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.local') || name.endsWith('.internal') || (isIP(name) !== 0 && isPrivateAddress(name));
};

async function checkPublic(address) {
  let url;
  try { url = new URL(address); } catch { throw new Error('is not a valid address'); }
  if (url.protocol !== 'https:') throw new Error('is not an https address');
  if (url.username || url.password) throw new Error('has a username or password in it');
  const found = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => []);
  if (!found.length || found.some((entry) => isPrivateAddress(entry.address))) throw new Error('points at this computer or a private network');
  return url;
}

// Fetches a public https address, checking every redirect, and stops at `limit` bytes.
export async function fetchPublicFile(address, { fetcher = fetch, signal, limit = 50 * 1024 * 1024 } = {}) {
  let url = await checkPublic(address);
  for (let hop = 0; ; hop += 1) {
    const r = await fetcher(url.href, { signal, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      if (hop >= 3) throw new Error('redirected too many times');
      await r.body?.cancel();
      url = await checkPublic(new URL(r.headers.get('location'), url).href);
      continue;
    }
    if (!r.ok) throw new Error(`answered ${r.status}`);
    const parts = [];
    let size = 0;
    for await (const chunk of r.body) {
      size += chunk.length;
      if (size > limit) throw new Error('is too large');
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  }
}
