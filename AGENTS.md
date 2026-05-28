# LLMWiki Health Cognitive System — AGENTS.md

Codebase patterns, conventions, and gotchas for AI agents working in this project.

## Project Overview

LLMWiki is a Node.js/Express health wiki backend that:
- Stores structured patient health data as Markdown files
- Serves a REST API consumed by a React frontend (Vite)
- Integrates with Doubao (ByteDance) LLM for AI-powered wiki sync

## File Structure

```
/Users/cc/llmwiki/
├── server.cjs              # Express REST API (main backend)
├── data/
│   ├── clients.json        # Patient list database (JSON array)
│   ├── wiki/{clientId}/    # Per-patient Markdown wiki pages
│   │   ├── index.md
│   │   ├── medical_history.md
│   │   ├── medication_plan.md
│   │   └── communication_timeline.md
│   └── logs/{clientId}.json  # Per-patient raw log array (JSON)
├── tests/
│   └── test_api.cjs        # PRD compliance test suite (85 tests)
├── src/
│   ├── App.jsx             # React frontend
│   └── components/HealthWikiRenderer.jsx  # Markdown renderer
└── scripts/ralph/          # Ralph autonomous agent loop
    ├── prd.json            # User stories
    ├── CLAUDE.md           # Ralph agent prompt
    └── progress.txt        # Iteration notes
```

## API Patterns

### Error Response Shape
**ALL** API errors must return `{ "error": "description string" }`:
```
400 = Bad Request (missing/invalid required fields)
404 = Not Found (client/resource doesn't exist)
500 = Server Error (LLM failure, disk error)
```

### Success Response Shape
- `POST` create → `201` with full created object
- `GET` list → `200` with array
- `GET` wiki → `200` with `{ "filename.md": "content..." }` object
- `PUT` update → `200` with updated object or `{ success: true, message: "..." }`
- `DELETE` → `200` with `{ success: true, message: "..." }`

## Validation Rules

### Client Creation (`POST /api/clients`)
- `name` is required and must be non-empty string
- `age` is optional integer
- `gender` is optional string  
- `phone` is optional string
- `allergies` is optional string

### Log Creation (`POST /api/clients/:id/logs`)
- `type` is **required** and must be exactly one of: `phone | video | wechat | ocr`
- `content` is **required** and must be non-empty
- `title` is optional (auto-generated if missing)
- **Strict enum enforcement** — any other type string returns 400

### Wiki Page Writes (`PUT /api/clients/:id/wiki/:pageName`)
- `pageName` must end with `.md` — any other extension returns 400
- `pageName` must not contain `..` — path traversal prevention
- `content` is required in request body

## PRD 8-Section Cognitive Skeleton

Every new patient's wiki must contain these 8 sections across the 4 default pages:

| # | Section | Page | Chinese |
|---|---------|------|---------|
| 1 | Current Key Concerns | index.md | 当前主要关注 |
| 2 | Timeline | index.md | 事件时间轴 |
| 3 | Physiologic Signals | medical_history.md | 生理信号 |
| 4 | Laboratory Findings | medical_history.md | 化验结果 |
| 5 | Functional Changes | medical_history.md | 功能变化 |
| 6 | Active Interventions | medication_plan.md | 当前干预措施 |
| 7 | Monitoring Targets | communication_timeline.md | 监测目标 |
| 8 | Source Evidence | communication_timeline.md | 原始溯源证据 |

This is defined in `createDefaultWiki()` in `server.cjs`.

## Citation Format

Evidence traceability uses this format in Markdown content:
```
[🔗 溯源](log_id_here)
```
Where `log_id_here` is the `id` field of a log entry (e.g. `log_1779347385975`).

The `HealthWikiRenderer.jsx` automatically converts these to clickable badge elements.

## AI Safety Rules (PRD Compliance)

The following phrases are **forbidden** in any AI-generated wiki content:
- `AI确诊` / `AI诊断为` / `人工智能诊断`
- `confirmed by AI` / `AI confirms` / `AI判断`
- `危及生命` / `life-threatening`

AI should:
- Observe and record, NOT diagnose
- Use observation language: "患者反映..." / "检测显示..." / "记录显示..."
- Tag every claim with a `[🔗 溯源](log_id)` citation

## LLM Integration

- Model: Doubao (`doubao-1.5-pro-32k-250115` or env `ARK_MODEL`)
- API: ByteDance Volcano (`ark.cn-beijing.volces.com/api/v3`)
- Config: `.env` file with `ARK_API_KEY`, `ARK_BASE_URL`, `ARK_MODEL`
- Server port: `5050` (set via `PORT` in `.env`)

## Running Tests

```bash
# Server must be running first
node server.cjs &

# Run the full test suite (85 tests)
node tests/test_api.cjs
```

The test suite uses no external dependencies — pure Node.js `fetch`.

## Common Gotchas

1. **Test isolation**: The wiki PUT test in section 3 overwrites `medical_history.md`. Skeleton structure tests (section 7) use a **separate fresh client** with `try/finally` cleanup to avoid contamination.

2. **Port**: Server runs on `5050` (not 5000). This comes from `.env` `PORT=5050`.

3. **Wiki storage**: Wiki pages are stored as raw `.md` files on disk, NOT in a database. The `data/wiki/{clientId}/` directory is created on client creation.

4. **Log storage**: Logs are stored as a JSON array in `data/logs/{clientId}.json`. The `synced` field tracks whether the log has been incorporated into the wiki via LLM sync.

5. **createDefaultWiki()**: When editing the default wiki template, test immediately with `node tests/test_api.cjs` — the test creates fresh clients and checks for required sections.
