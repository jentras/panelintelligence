# panelintelligence

Panel intelligence from the room, upgraded into a reusable knowledge-garden platform for events.

## What is included

- Speaker upload API (single + CSV import)
- Bidirectional link indexing for markdown and wiki-style links
- Graph JSON endpoint for network visualization
- Obsidian markdown export with backlinks
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
- `POST /api/links/reindex`
- `GET /api/backlinks/:slug`
- `GET /api/graph`
- `POST /api/quotes/:id/generate-card`
- `GET /api/export/obsidian`

## Open-source transfer

- Footer link in the main site points to `/how-this-was-made`.
- The guide explains architecture, deployment, and workflows for event managers and nonprofits.
