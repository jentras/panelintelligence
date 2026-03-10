const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CARD_DIR = path.join(ROOT, 'cards');

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function nowIso() { return new Date().toISOString(); }

function parseInternalLinks(markdown = '') {
  const links = new Set();
  const mdLinks = /\[[^\]]*\]\(\/?([a-zA-Z0-9\-_/]+)\)/g;
  const wikiLinks = /\[\[([a-zA-Z0-9\-_/]+)\]\]/g;
  for (const match of markdown.matchAll(mdLinks)) links.add(match[1].replace(/^\//, '').split('/')[0]);
  for (const match of markdown.matchAll(wikiLinks)) links.add(match[1].replace(/^\//, '').split('/')[0]);
  return [...links].filter(Boolean);
}

function buildNodeIndex() {
  const speakers = readJson('speakers.json');
  const sessions = readJson('sessions.json');
  const concepts = readJson('concepts.json');
  const nodes = new Map();
  speakers.forEach((s) => nodes.set(s.slug, { type: 'speaker', slug: s.slug, title: s.name }));
  sessions.forEach((s) => nodes.set(s.slug, { type: 'session', slug: s.slug, title: s.title }));
  concepts.forEach((c) => nodes.set(c.slug, { type: 'concept', slug: c.slug, title: c.name }));
  return nodes;
}

function reindexLinks() {
  const speakers = readJson('speakers.json');
  const sessions = readJson('sessions.json');
  const concepts = readJson('concepts.json');
  const nodeIndex = buildNodeIndex();
  const links = [];

  speakers.forEach((speaker) => {
    parseInternalLinks(speaker.bio_markdown).forEach((targetSlug) => {
      if (!nodeIndex.has(targetSlug)) return;
      links.push({ id: `lnk_${links.length + 1}`, source_type: 'speaker', source_id: speaker.slug, target_type: nodeIndex.get(targetSlug).type, target_id: targetSlug, relation_type: 'mentions', created_at: nowIso() });
    });
    (speaker.concepts || []).forEach((conceptSlug) => {
      if (!nodeIndex.has(conceptSlug)) return;
      links.push({ id: `lnk_${links.length + 1}`, source_type: 'speaker', source_id: speaker.slug, target_type: 'concept', target_id: conceptSlug, relation_type: 'expertise', created_at: nowIso() });
    });
  });

  sessions.forEach((session) => {
    parseInternalLinks(session.abstract_markdown).forEach((targetSlug) => {
      if (!nodeIndex.has(targetSlug)) return;
      links.push({ id: `lnk_${links.length + 1}`, source_type: 'session', source_id: session.slug, target_type: nodeIndex.get(targetSlug).type, target_id: targetSlug, relation_type: 'references', created_at: nowIso() });
    });
    (session.speaker_slugs || []).forEach((speakerSlug) => {
      if (!nodeIndex.has(speakerSlug)) return;
      links.push({ id: `lnk_${links.length + 1}`, source_type: 'session', source_id: session.slug, target_type: 'speaker', target_id: speakerSlug, relation_type: 'features', created_at: nowIso() });
    });
  });

  concepts.forEach((concept) => {
    const incoming = links.filter((l) => l.target_id === concept.slug).length;
    if (incoming === 0) links.push({ id: `lnk_${links.length + 1}`, source_type: 'concept', source_id: concept.slug, target_type: 'concept', target_id: concept.slug, relation_type: 'seed', created_at: nowIso() });
  });

  writeJson('links.json', links);
  return links;
}

function parseCsv(csvText) {
  const [headerLine, ...lines] = csvText.trim().split(/\r?\n/);
  const headers = headerLine.split(',').map((h) => h.trim());
  return lines.filter(Boolean).map((line) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    return row;
  });
}

function getBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveStatic(reqPath, res) {
  const clean = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(ROOT, clean.replace(/\.\./g, ''));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
  const contentType = types[ext] || 'application/octet-stream';
  sendText(res, 200, fs.readFileSync(filePath), contentType);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && pathname === '/api/speakers') return sendJson(res, 200, readJson('speakers.json'));

    if (req.method === 'POST' && pathname === '/api/speakers') {
      const body = await getBody(req);
      const speakers = readJson('speakers.json');
      const { name, slug, bio_markdown, role = '', org = '', headshot_url = '', concepts = [] } = body;
      if (!name || !slug || !bio_markdown) return sendJson(res, 400, { error: 'name, slug, and bio_markdown are required' });
      if (speakers.find((s) => s.slug === slug)) return sendJson(res, 409, { error: 'speaker slug already exists' });
      const speaker = { id: `spk_${slug}`, name, slug, role, org, bio_markdown, headshot_url, concepts, socials: {}, consent_flags: { quote_cards: true } };
      speakers.push(speaker);
      writeJson('speakers.json', speakers);
      return sendJson(res, 201, speaker);
    }

    if (req.method === 'POST' && pathname === '/api/speakers/import') {
      const body = await getBody(req);
      if (!body.csv || typeof body.csv !== 'string') return sendJson(res, 400, { error: 'csv string is required' });
      const speakers = readJson('speakers.json');
      const rows = parseCsv(body.csv);
      const created = [];
      const skipped = [];
      rows.forEach((row) => {
        const slug = (row.slug || row.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        if (!row.name || !row.bio_markdown || !slug) return skipped.push({ row, reason: 'missing required fields' });
        if (speakers.find((s) => s.slug === slug)) return skipped.push({ row, reason: 'duplicate slug' });
        speakers.push({ id: `spk_${slug}`, name: row.name, slug, role: row.role || '', org: row.org || '', bio_markdown: row.bio_markdown, headshot_url: row.headshot_url || '', concepts: (row.concepts || '').split('|').filter(Boolean), socials: {}, consent_flags: { quote_cards: true } });
        created.push(slug);
      });
      writeJson('speakers.json', speakers);
      return sendJson(res, 200, { created, skipped });
    }

    if (req.method === 'POST' && pathname === '/api/links/reindex') return sendJson(res, 200, { edges: reindexLinks().length });

    if (req.method === 'GET' && pathname.startsWith('/api/backlinks/')) {
      const slug = pathname.split('/').pop();
      const backlinks = readJson('links.json').filter((l) => l.target_id === slug).map((l) => ({ source_type: l.source_type, source_id: l.source_id, relation_type: l.relation_type }));
      return sendJson(res, 200, { slug, backlinks });
    }

    if (req.method === 'GET' && pathname === '/api/graph') {
      const nodes = [...buildNodeIndex().values()];
      const edges = readJson('links.json').map((l) => ({ source: l.source_id, target: l.target_id, relation: l.relation_type }));
      return sendJson(res, 200, { nodes, edges });
    }

    if (req.method === 'POST' && /^\/api\/quotes\/[^/]+\/generate-card$/.test(pathname)) {
      const body = await getBody(req);
      const id = pathname.split('/')[3];
      const quotes = readJson('quotes.json');
      const speakers = readJson('speakers.json');
      const quote = quotes.find((q) => q.id === id);
      if (!quote) return sendJson(res, 404, { error: 'quote not found' });
      const speaker = speakers.find((s) => s.slug === quote.speaker_slug);
      const theme = body.theme || 'bold';
      const width = Number(body.width || 1200);
      const height = Number(body.height || 630);
      const bg = theme === 'dark' ? '#111111' : '#E8500A';
      const safeQuote = quote.quote_text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const subtitle = `${speaker ? speaker.name : quote.speaker_slug} • panelintelligence`;
      const svg = `<?xml version="1.0" encoding="UTF-8"?><svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${bg}"/><text x="64" y="160" fill="#fff" font-size="48" font-family="Arial" font-weight="700">“${safeQuote}”</text><text x="64" y="${height - 80}" fill="#fff" font-size="28" font-family="Arial">${subtitle}</text><text x="${width - 260}" y="${height - 32}" fill="#fff" font-size="24" font-family="Arial">panelintelligence.org</text></svg>`;
      const filename = `${id}-${theme}-${width}x${height}.svg`;
      fs.writeFileSync(path.join(CARD_DIR, filename), svg, 'utf8');
      return sendJson(res, 200, { ok: true, url: `/cards/${filename}` });
    }

    if (req.method === 'GET' && pathname === '/api/export/obsidian') {
      const speakers = readJson('speakers.json');
      const sessions = readJson('sessions.json');
      const concepts = readJson('concepts.json');
      const links = readJson('links.json');
      const notes = [];
      const pushNote = (slug, title, body, tags = []) => {
        const backlinks = links.filter((l) => l.target_id === slug).map((l) => `- [[${l.source_id}]] (${l.relation_type})`).join('\n');
        notes.push({ slug, markdown: `---\ntitle: ${title}\nslug: ${slug}\ntags: [${tags.join(', ')}]\n---\n\n${body}\n\n## Backlinks\n${backlinks || '_None yet_'}\n` });
      };
      speakers.forEach((s) => pushNote(s.slug, s.name, s.bio_markdown, ['speaker']));
      sessions.forEach((s) => pushNote(s.slug, s.title, s.abstract_markdown, ['session']));
      concepts.forEach((c) => pushNote(c.slug, c.name, c.description, ['concept']));
      return sendJson(res, 200, { notes });
    }

    if (req.method === 'GET' && pathname === '/how-this-was-made') {
      return sendText(res, 200, fs.readFileSync(path.join(ROOT, 'how-this-was-made.html')), 'text/html; charset=utf-8');
    }

    if (serveStatic(pathname, res)) return;
    return sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, () => {
  console.log(`panelintelligence server listening on http://localhost:${PORT}`);
});
