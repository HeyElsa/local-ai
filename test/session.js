// Signing in for tests. The app needs a passphrase before anything else works, so
// this chooses one on a new test server and then sends its session with every request.
export const PASS = '4821';
export const CODE = 'TEST-CODE';

const sessions = new Map(); // server address -> session cookie
const plainFetch = globalThis.fetch;

globalThis.fetch = (input, init = {}) => {
  const address = String(input);
  const base = [...sessions.keys()].find((b) => address.startsWith(b));
  if (!base || init.headers?.cookie !== undefined) return plainFetch(input, init);
  return plainFetch(input, { ...init, headers: { ...init.headers, cookie: sessions.get(base) } });
};

const post = (base, path, body) => plainFetch(base + path, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify(body),
});

// Chooses the passphrase on a new server, or unlocks one that already has it.
export async function signIn(base, passphrase = PASS) {
  let r = await post(base, '/api/vault/enable', { passphrase, code: CODE });
  if (r.status === 409) r = await post(base, '/api/unlock', { passphrase });
  if (r.status !== 200) throw new Error(`could not sign in: ${r.status} ${await r.text()}`);
  sessions.set(base, r.headers.get('set-cookie').split(';')[0]);
}

export const signOut = (base) => sessions.delete(base);
export const keepSession = (base, response) => sessions.set(base, response.headers.get('set-cookie').split(';')[0]);
