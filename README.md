# panelintelligence

Panel intelligence from the room, upgraded into a reusable knowledge-garden platform for events.

## What is included

- Graph-ready canonical schema (`data/schema.json`) for speakers/sessions/quotes/concepts/links + junction tables
- Speaker upload API (single + CSV import) with duplicate checks (slug/email)
- Admin upload flow (`/admin.html`) for CSV imports, headshot uploads, and review/publish controls
- Authenticated admin endpoints with audit logging (`data/audit-log.json`)
- Bidirectional link indexing for markdown/wiki/HTML links with typed relationships + dedupe/broken-link reports
- Graph JSON endpoint for network visualization
- Obsidian markdown export with wiki-links + backlinks
- Quote-card generator (SVG) for social sharing
- Public `How this was made` page for nonprofit/event replication

## Run locally

```bash
npm install
npm start
```

Server starts at `http://localhost:3000`.

## Core API

- `GET /api/speakers`
- `POST /api/speakers`
- `POST /api/speakers/import`
- `POST /admin/speakers/import` (auth)
- `POST /admin/speakers/:id/headshot` (auth)
- `GET /admin/speakers/review` (auth)
- `POST /admin/speakers/:id/publish` (auth)
- `POST /api/links/reindex`
- `GET /api/links/report`
- `GET /api/backlinks/:slug`
- `GET /api/graph`
- `POST /api/quotes/:id/generate-card`
- `GET /api/export/obsidian`
- `GET /api/schema`

## Open-source transfer

- Footer link in the main site points to `/how-this-was-made`.
- The guide explains architecture, deployment, and workflows for event managers and nonprofits.
