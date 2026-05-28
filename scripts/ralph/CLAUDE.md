# Ralph Agent Instructions - LLMWiki Health Cognitive System

You are an autonomous coding agent fixing and improving the **LLMWiki Health Cognitive System** — an AI-native health wiki backend built with Node.js/Express.

## Project Location

All code is at: `/Users/cc/llmwiki/`

Key files:
- `server.cjs` — Express REST API (the main file you'll edit)
- `tests/test_api.cjs` — Test suite to validate your changes
- `data/clients.json` — Client database (JSON file)
- `data/wiki/{clientId}/*.md` — Per-client wiki pages
- `data/logs/{clientId}.json` — Per-client raw logs

## Your Task

1. Read the PRD at `scripts/ralph/prd.json`
2. Read progress notes at `scripts/ralph/progress.txt`
3. Ensure you are on branch `ralph/wiki-prd-compliance` (create from main if needed)
4. Pick the **highest priority** user story where `passes: false`
5. Implement the fix (mostly in `server.cjs` or `data/wiki/` templates)
6. Run the quality check: `node tests/test_api.cjs`
   - ⚠️ The test server must be running: `node server.cjs` (it should already be running)
   - If server is not running, start it in background: `node server.cjs &` then wait 2 seconds
   - Server binds to port 5050 (from .env PORT=5050)
7. If quality checks pass, commit ALL changes: `git add -A && git commit -m "fix: [Story ID] - [Story Title]"`
8. Update `scripts/ralph/prd.json` to set `passes: true` for the completed story
9. Append progress to `scripts/ralph/progress.txt`

## Quality Check Command

```bash
# Make sure server is running on port 5000 first!
node tests/test_api.cjs
```

All sections relevant to the current story must pass. The test will exit 1 if any tests fail.

## Project Patterns

### Error Response Shape
All API errors MUST return `{ "error": "description" }` with appropriate HTTP status code:
- 400 = Bad Request (missing/invalid fields)
- 404 = Not Found (client/resource doesn't exist)
- 500 = Server Error (LLM failure etc.)

### Successful Response Shape
- POST creates: return 201 with the created object
- GET list: return 200 with array
- GET single/wiki: return 200 with object
- PUT update: return 200 with updated object or `{ success: true }`
- DELETE: return 200 with `{ success: true, message: "..." }`

### Client Validation
- `name` is required for client creation
- `type` must be one of: `phone | video | wechat | ocr` for logs
- `content` is required for log creation

### Wiki File Security
- Only `.md` file extensions are allowed for wiki writes
- File names must not contain `..` (path traversal prevention)

### PRD 8-Section Cognitive Skeleton
New client wikis must follow this structure:
1. Current Key Concerns (当前主要关注) — in index.md
2. Timeline (事件时间轴) — in index.md
3. Physiologic Signals (生理信号) — in medical_history.md
4. Laboratory Findings (化验结果) — in medical_history.md
5. Functional Changes (功能变化) — in medical_history.md
6. Active Interventions (当前干预措施) — in medication_plan.md
7. Monitoring Targets (监测目标) — in communication_timeline.md
8. Source Evidence (原始溯源证据) — in communication_timeline.md

### Citation Format
Evidence traceability uses: `[🔗 溯源](log_id_here)`

## Stop Condition

After completing a user story, check if ALL stories in `prd.json` have `passes: true`.

If ALL complete, reply with:
<promise>COMPLETE</promise>

If more remain, end your response normally.

## Important

- Work on ONE story per iteration
- Only edit `server.cjs` (and wiki template strings within it) for most stories
- The test suite is at `tests/test_api.cjs` — do NOT modify it
- Server runs on port 5050 (configured via .env PORT=5050)
- Keep git history clean with semantic commit messages
