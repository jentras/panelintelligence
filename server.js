const fs = require('fs');
const path = require('path');
const http = require('http');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CARD_DIR = path.join(ROOT, 'cards');
const UPLOAD_RAW_DIR = path.join(ROOT, 'uploads', 'raw');
const UPLOAD_PUBLIC_DIR = path.join(ROOT, 'uploads', 'public');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'local-dev-token';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

for (const dir of [CARD_DIR, UPLOAD_RAW_DIR, UPLOAD_PUBLIC_DIR]) fs.mkdirSync(dir, { recursive: true });

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(text);
}

function readJson(file, fallback = []) {
  const filePath = path.join(DATA_DIR, file);
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(value, null, 2));
}

function nowIso() { return new Date().toISOString(); }

function slugify(value = '') {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function requireAdmin(req) {
  const token = req.headers['x-admin-token'];
  return token && token === ADMIN_TOKEN;
}

function appendAudit(event, req, meta = {}) {
  const log = readJson('audit-log.json', []);
  log.push({
    id: `audit_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    event,
    at: nowIso(),
    actor: req.headers['x-admin-user'] || 'unknown-admin',
    ip: req.socket.remoteAddress,
    meta
  });
  writeJson('audit-log.json', log);
}

function parseInternalLinks(content = '') {
  const links = new Set();
  const mdLinks = /\[[^\]]*\]\((\/)?([a-zA-Z0-9\-_/]+)\)/g;
  const wikiLinks = /\[\[([a-zA-Z0-9\-_/]+)(?:\|[^\]]+)?\]\]/g;
  const htmlLinks = /<a[^>]*href=["']\/?([a-zA-Z0-9\-_/]+)["'][^>]*>/g;

  for (const match of content.matchAll(mdLinks)) links.add((match[2] || '').split('/')[0]);
  for (const match of content.matchAll(wikiLinks)) links.add((match[1] || '').split('/')[0]);
  for (const match of content.matchAll(htmlLinks)) links.add((match[1] || '').split('/')[0]);

  return [...links].filter(Boolean);
}

function inferRelationType(content, targetSlug, defaultsTo) {
  const lower = content.toLowerCase();
  if (new RegExp(`inspired by[^.]{0,80}${targetSlug}`, 'i').test(lower)) return 'inspired_by';
  if (new RegExp(`cites?[^.]{0,80}${targetSlug}`, 'i').test(lower)) return 'cites';
  return defaultsTo;
}

function buildNodeIndex() {
  const speakers = readJson('speakers.json');
  const sessions = readJson('sessions.json');
  const concepts = readJson('concepts.json');
  const quotes = readJson('quotes.json');
  const nodes = new Map();
  speakers.filter((s) => !s.deleted_at).forEach((s) => nodes.set(s.slug, { type: 'speaker', slug: s.slug, title: s.name }));
  sessions.filter((s) => !s.deleted_at).forEach((s) => nodes.set(s.slug, { type: 'panel', slug: s.slug, title: s.title }));
  concepts.filter((c) => !c.deleted_at).forEach((c) => nodes.set(c.slug, { type: 'concept', slug: c.slug, title: c.name }));
  quotes.filter((q) => !q.deleted_at).forEach((q) => nodes.set(q.id, { type: 'note', slug: q.id, title: q.quote_text.slice(0, 70) }));
  return nodes;
}

function edgeKey(edge) {
  return [edge.source_type, edge.source_id, edge.target_type, edge.target_id, edge.relation_type].join('|');
}

function reindexLinks() {
  const speakers = readJson('speakers.json');
  const sessions = readJson('sessions.json');
  const concepts = readJson('concepts.json');
  const nodeIndex = buildNodeIndex();
  const links = [];
  const broken = [];

  function addEdge(edge) {
    if (!nodeIndex.has(edge.target_id)) {
      broken.push(edge);
      return;
    }
    links.push(edge);
  }

  speakers.filter((s) => !s.deleted_at).forEach((speaker) => {
    parseInternalLinks(speaker.bio_markdown).forEach((targetSlug) => {
      addEdge({ id: `lnk_${links.length + 1}`, source_type: 'speaker', source_id: speaker.slug, target_type: nodeIndex.get(targetSlug)?.type || 'unknown', target_id: targetSlug, relation_type: inferRelationType(speaker.bio_markdown, targetSlug, 'mentions'), created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    });
    (speaker.concepts || []).forEach((conceptSlug) => {
      addEdge({ id: `lnk_${links.length + 1}`, source_type: 'speaker', source_id: speaker.slug, target_type: 'concept', target_id: conceptSlug, relation_type: 'expertise', created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    });
  });

  sessions.filter((s) => !s.deleted_at).forEach((session) => {
    parseInternalLinks(session.abstract_markdown).forEach((targetSlug) => {
      addEdge({ id: `lnk_${links.length + 1}`, source_type: 'session', source_id: session.slug, target_type: nodeIndex.get(targetSlug)?.type || 'unknown', target_id: targetSlug, relation_type: inferRelationType(session.abstract_markdown, targetSlug, 'mentions'), created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    });
    (session.speaker_slugs || []).forEach((speakerSlug) => {
      addEdge({ id: `lnk_${links.length + 1}`, source_type: 'panel', source_id: session.slug, target_type: 'speaker', target_id: speakerSlug, relation_type: 'co_speaks_with', created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    });
  });

  concepts.filter((c) => !c.deleted_at).forEach((concept) => {
    if (!links.find((l) => l.target_id === concept.slug)) {
      links.push({ id: `lnk_${links.length + 1}`, source_type: 'concept', source_id: concept.slug, target_type: 'concept', target_id: concept.slug, relation_type: 'seed', created_at: nowIso(), updated_at: nowIso(), deleted_at: null });
    }
  });

  const seen = new Set();
  const deduped = links.filter((link) => {
    const key = edgeKey(link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  writeJson('links.json', deduped);
  writeJson('link-report.json', { generated_at: nowIso(), edges: deduped.length, deduped_count: links.length - deduped.length, broken_links: broken });
  return { deduped, broken, dedupedCount: links.length - deduped.length };
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
    req.on('data', (chunk) => { body += chunk; if (body.length > 4e6) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function ensureSpeakerShape(speaker) {
  return {
    website: '',
    socials: {},
    consent_flags: { quote_cards: true },
    email: '',
    created_at: nowIso(),
    updated_at: nowIso(),
    deleted_at: null,
    headshot_status: 'missing',
    ...speaker
  };
}

function serveStatic(reqPath, res) {
  const clean = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(ROOT, clean.replace(/\.\./g, ''));
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };
  const contentType = types[ext] || 'application/octet-stream';
  sendText(res, 200, fs.readFileSync(filePath), contentType);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/health') return sendJson(res, 200, { status: 'ok' });
    if (req.method === 'GET' && pathname === '/api/schema') return sendJson(res, 200, readJson('schema.json', {}));
    if (req.method === 'GET' && pathname === '/api/speakers') return sendJson(res, 200, readJson('speakers.json').filter((s) => !s.deleted_at));

    if (req.method === 'POST' && pathname === '/api/speakers') {
      const body = await getBody(req);
      const speakers = readJson('speakers.json');
      const { name, slug, bio_markdown, role = '', org = '', headshot_url = '', concepts = [], website = '', socials = {}, consent_flags = {}, email = '' } = body;
      const stableSlug = slugify(slug || name);
      if (!name || !stableSlug || !bio_markdown) return sendJson(res, 400, { error: 'name, slug, and bio_markdown are required' });
      if (speakers.find((s) => s.slug === stableSlug || (email && s.email && s.email === email))) return sendJson(res, 409, { error: 'speaker duplicate by slug or email' });
      const stamp = nowIso();
      const speaker = ensureSpeakerShape({ id: `spk_${stableSlug}`, name, slug: stableSlug, role, org, bio_markdown, headshot_url, concepts, website, socials, consent_flags: { quote_cards: true, ...consent_flags }, email, created_at: stamp, updated_at: stamp });
      speakers.push(speaker);
      writeJson('speakers.json', speakers);
      return sendJson(res, 201, speaker);
    }

    if (req.method === 'POST' && (pathname === '/api/speakers/import' || pathname === '/admin/speakers/import')) {
      if (pathname.startsWith('/admin') && !requireAdmin(req)) return sendJson(res, 401, { error: 'admin auth required' });
      const body = await getBody(req);
      if (!body.csv || typeof body.csv !== 'string') return sendJson(res, 400, { error: 'csv string is required' });
      const speakers = readJson('speakers.json');
      const rows = parseCsv(body.csv);
      const created = [];
      const skipped = [];
      rows.forEach((row) => {
        const slug = slugify(row.slug || row.name || '');
        const email = (row.email || '').toLowerCase();
        if (!row.name || !row.bio_markdown || !slug) return skipped.push({ row, reason: 'missing required fields' });
        if (speakers.find((s) => s.slug === slug || (email && s.email === email))) return skipped.push({ row, reason: 'duplicate speaker by slug/email' });
        speakers.push(ensureSpeakerShape({ id: `spk_${slug}`, name: row.name, slug, role: row.role || '', org: row.org || '', email, bio_markdown: row.bio_markdown, website: row.website || '', headshot_url: row.headshot_url || '', concepts: (row.concepts || '').split('|').filter(Boolean), socials: { linkedin: row.linkedin || '' }, consent_flags: { quote_cards: row.quote_cards !== 'false' } }));
        created.push(slug);
      });
      writeJson('speakers.json', speakers);
      if (pathname.startsWith('/admin')) appendAudit('admin.speakers.import', req, { created: created.length, skipped: skipped.length });
      return sendJson(res, 200, { created, skipped });
    }

    if (req.method === 'POST' && /^\/admin\/speakers\/[^/]+\/headshot$/.test(pathname)) {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'admin auth required' });
      const body = await getBody(req);
      const speakerSlug = pathname.split('/')[3];
      const speakers = readJson('speakers.json');
      const speaker = speakers.find((s) => s.slug === speakerSlug && !s.deleted_at);
      if (!speaker) return sendJson(res, 404, { error: 'speaker not found' });
      const { filename = `${speakerSlug}.png`, mime, data_base64, width, height, alt_text_draft = '' } = body;
      if (!mime || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) return sendJson(res, 400, { error: 'invalid image mime type' });
      if (!data_base64) return sendJson(res, 400, { error: 'data_base64 required' });
      if (!width || !height || width < 256 || height < 256 || width > 5000 || height > 5000) return sendJson(res, 400, { error: 'image dimensions out of range' });

      const rawBuffer = Buffer.from(data_base64, 'base64');
      if (rawBuffer.length > MAX_IMAGE_BYTES) return sendJson(res, 400, { error: 'image too large' });

      const rawName = `${speakerSlug}-${Date.now()}-${filename}`;
      const rawPath = path.join(UPLOAD_RAW_DIR, rawName);
      fs.writeFileSync(rawPath, rawBuffer);

      const webpName = `${speakerSlug}.webp`;
      const pngName = `${speakerSlug}.png`;
      fs.writeFileSync(path.join(UPLOAD_PUBLIC_DIR, webpName), rawBuffer);
      fs.writeFileSync(path.join(UPLOAD_PUBLIC_DIR, pngName), rawBuffer);

      speaker.headshot_url = `/uploads/public/${webpName}`;
      speaker.headshot_fallback_url = `/uploads/public/${pngName}`;
      speaker.headshot_status = 'pending_review';
      speaker.headshot_alt_text_draft = alt_text_draft || `Headshot of ${speaker.name}`;
      speaker.updated_at = nowIso();
      writeJson('speakers.json', speakers);

      appendAudit('admin.speakers.headshot.upload', req, { speaker: speakerSlug, rawPath: `/uploads/raw/${rawName}` });
      return sendJson(res, 200, { ok: true, speaker_slug: speakerSlug, raw_upload: `/uploads/raw/${rawName}`, transformed: [speaker.headshot_url, speaker.headshot_fallback_url], review_status: speaker.headshot_status });
    }

    if (req.method === 'GET' && pathname === '/admin/speakers/review') {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'admin auth required' });
      const pending = readJson('speakers.json').filter((s) => s.headshot_status === 'pending_review' && !s.deleted_at);
      return sendJson(res, 200, { pending });
    }

    if (req.method === 'POST' && /^\/admin\/speakers\/[^/]+\/publish$/.test(pathname)) {
      if (!requireAdmin(req)) return sendJson(res, 401, { error: 'admin auth required' });
      const speakerSlug = pathname.split('/')[3];
      const speakers = readJson('speakers.json');
      const speaker = speakers.find((s) => s.slug === speakerSlug && !s.deleted_at);
      if (!speaker) return sendJson(res, 404, { error: 'speaker not found' });
      speaker.headshot_status = 'approved';
      speaker.updated_at = nowIso();
      writeJson('speakers.json', speakers);
      appendAudit('admin.speakers.publish', req, { speaker: speakerSlug });
      return sendJson(res, 200, { ok: true, speaker: speakerSlug, status: 'approved' });
    }

    if (req.method === 'POST' && pathname === '/api/links/reindex') {
      const indexResult = reindexLinks();
      return sendJson(res, 200, { edges: indexResult.deduped.length, deduped: indexResult.dedupedCount, broken: indexResult.broken.length });
    }

    if (req.method === 'GET' && pathname === '/api/links/report') return sendJson(res, 200, readJson('link-report.json', { generated_at: null, edges: 0, deduped_count: 0, broken_links: [] }));

    if (req.method === 'GET' && pathname.startsWith('/api/backlinks/')) {
      const slug = pathname.split('/').pop();
      const backlinks = readJson('links.json').filter((l) => l.target_id === slug && !l.deleted_at).map((l) => ({ source_type: l.source_type, source_id: l.source_id, relation_type: l.relation_type }));
      return sendJson(res, 200, { slug, backlinks });
    }

    if (req.method === 'GET' && pathname === '/api/graph') {
      const nodeIndex = buildNodeIndex();
      const allEdges = readJson('links.json').filter((l) => !l.deleted_at);
      const speakers = readJson('speakers.json').filter((s) => !s.deleted_at);
      const sessions = readJson('sessions.json').filter((sess) => !sess.deleted_at);
      const quotes = readJson('quotes.json').filter((q) => !q.deleted_at);
      const edges = [];
      const edgeSeen = new Set();
      const incoming = new Map();
      const outgoing = new Map();

      function remember(source, target) {
        outgoing.set(source, (outgoing.get(source) || 0) + 1);
        incoming.set(target, (incoming.get(target) || 0) + 1);
      }

      function addGraphEdge(source, target, relation, isInferred = false) {
        if (!nodeIndex.has(source) || !nodeIndex.has(target)) return;
        const key = `${source}|${target}|${relation}`;
        if (edgeSeen.has(key)) return;
        edgeSeen.add(key);
        edges.push({ source, target, relation, isInferred });
        remember(source, target);
      }

      allEdges.forEach((edge) => {
        addGraphEdge(edge.source_id, edge.target_id, edge.relation_type, false);
        addGraphEdge(edge.target_id, edge.source_id, `backlink:${edge.relation_type}`, true);
      });

      quotes.forEach((quote) => {
        addGraphEdge(quote.id, quote.speaker_slug, 'quote_of', true);
        addGraphEdge(quote.speaker_slug, quote.id, 'has_quote', true);
        addGraphEdge(quote.id, quote.session_slug, 'from_panel', true);
        addGraphEdge(quote.session_slug, quote.id, 'panel_note', true);
      });

      sessions.forEach((session) => {
        (session.speaker_slugs || []).forEach((speakerSlug) => {
          addGraphEdge(session.slug, speakerSlug, 'panel_speaker', true);
          addGraphEdge(speakerSlug, session.slug, 'speaker_panel', true);
        });
      });

      speakers.forEach((speaker, i) => {
        (speaker.concepts || []).forEach((conceptSlug) => {
          addGraphEdge(speaker.slug, conceptSlug, 'expertise', true);
          addGraphEdge(conceptSlug, speaker.slug, 'backlink:expertise', true);
        });
        for (let j = i + 1; j < speakers.length; j++) {
          const other = speakers[j];
          const overlap = (speaker.concepts || []).filter((concept) => (other.concepts || []).includes(concept));
          if (overlap.length) {
            addGraphEdge(speaker.slug, other.slug, `shared_topic:${overlap[0]}`, true);
            addGraphEdge(other.slug, speaker.slug, `shared_topic:${overlap[0]}`, true);
          }
        }
      });

      const nodes = [...nodeIndex.values()].map((node) => ({
        ...node,
        degree: (incoming.get(node.slug) || 0) + (outgoing.get(node.slug) || 0),
        outgoing: outgoing.get(node.slug) || 0,
        incoming: incoming.get(node.slug) || 0
      }));
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
      const bg = theme === 'dark' ? '#111111' : theme === 'minimal' ? '#f5f5f5' : '#E8500A';
      const fg = theme === 'minimal' ? '#111111' : '#ffffff';
      const safeQuote = quote.quote_text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      const subtitle = `${speaker ? speaker.name : quote.speaker_slug} • panelintelligence`;
      const svg = `<?xml version="1.0" encoding="UTF-8"?><svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="${bg}"/><text x="64" y="160" fill="${fg}" font-size="48" font-family="Arial" font-weight="700">“${safeQuote}”</text><text x="64" y="${height - 80}" fill="${fg}" font-size="28" font-family="Arial">${subtitle}</text><text x="${width - 260}" y="${height - 32}" fill="${fg}" font-size="24" font-family="Arial">panelintelligence.org</text></svg>`;
      const filename = `${id}-${theme}-${width}x${height}.svg`;
      fs.writeFileSync(path.join(CARD_DIR, filename), svg, 'utf8');
      return sendJson(res, 200, { ok: true, url: `/cards/${filename}` });
    }

    if (req.method === 'GET' && pathname === '/api/export/obsidian') {
      const speakers = readJson('speakers.json').filter((s) => !s.deleted_at);
      const sessions = readJson('sessions.json').filter((s) => !s.deleted_at);
      const concepts = readJson('concepts.json').filter((c) => !c.deleted_at);
      const links = readJson('links.json').filter((l) => !l.deleted_at);
      const notes = [];
      const pushNote = (slug, title, body, tags = [], id = '') => {
        const backlinks = links.filter((l) => l.target_id === slug).map((l) => `- [[${l.source_id}]] (${l.relation_type})`).join('\n');
        const wikiBody = (body || '').replace(/\[[^\]]*\]\(\/?([a-zA-Z0-9\-_/]+)\)/g, '[[$1]]');
        notes.push({ slug, markdown: `---\nid: ${id}\ntitle: ${title}\nslug: ${slug}\ntags: [${tags.join(', ')}]\n---\n\n${wikiBody}\n\n## Backlinks\n${backlinks || '_None yet_'}\n` });
      };
      speakers.forEach((s) => pushNote(s.slug, s.name, s.bio_markdown, ['speaker'], s.id));
      sessions.forEach((s) => pushNote(s.slug, s.title, s.abstract_markdown, ['session'], s.id));
      concepts.forEach((c) => pushNote(c.slug, c.name, c.description, ['concept'], c.id));
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
