import { spawn } from 'node:child_process';

const base = 'http://127.0.0.1:3000';

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function request(path, options = {}) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${text}`);
  return body;
}

const server = spawn('node', ['server.js'], { stdio: 'inherit' });

try {
  await wait(1200);

  await request('/health');
  await request('/api/links/reindex', { method: 'POST' });

  const graph = await request('/api/graph');
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new Error('graph nodes missing');

  const obsidian = await request('/api/export/obsidian');
  if (!Array.isArray(obsidian.notes) || obsidian.notes.length === 0) throw new Error('obsidian notes missing');

  const card = await request('/api/quotes/q_001/generate-card', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ theme: 'dark' })
  });

  if (!card.url) throw new Error('card url missing');

  console.log('Validation checks passed.');
} finally {
  server.kill('SIGTERM');
}
