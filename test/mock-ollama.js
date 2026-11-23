// A stand-in for Ollama, so local models can be tested without downloading one.
import http from 'node:http';

export function startOllama() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    requests.push({ url: req.url, body });
    const json = (v) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (req.url === '/api/tags') {
      return json({ models: [
        { name: 'tiny:latest', size: 1e9 },
        { name: 'eyes:4b', size: 3.3e9 },
        { name: 'big:120b-cloud', size: 0 },
        { name: 'remote:1', size: 0, remote_host: 'https://ollama.com' },
      ] });
    }
    if (req.url === '/api/show') return json({ capabilities: body.model === 'eyes:4b' ? ['completion', 'vision'] : ['completion'] });
    if (req.url === '/api/pull') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ status: 'pulling', total: 100, completed: 50 })}\n`);
      return res.end(`${JSON.stringify({ status: 'success' })}\n`);
    }
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'Working it out on this computer.\n' } }] })}\n\n`);
      await new Promise((r) => { setTimeout(r, 1200); });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Answered on this computer.' } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404);
    return res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
