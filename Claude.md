# Axiom Implementation Guardrails

These rules are mandatory for Copilot execution in this workspace.

## Priority Order
1. Core vault/search/notes reliability first
2. PDF and annotation stability second
3. AI webview automation last (behind feature flag)

## Non-Negotiable Engineering Rules
- AI transfer must always work, even if DOM injection fails:
	- Try provider-specific injection
	- Then synthetic paste
	- Then clipboard fallback with clear user prompt
- Never ship AI send flow without graceful degradation.
- Keep provider health states (`ready`, `degraded`, `offline`) visible in UI logs/status.

## Data Layer Rules (Phase 2)
- Use schema migrations, not only `CREATE IF NOT EXISTS`.
- Maintain `schema_migrations` table and ordered migration files.
- Include file change tracking in schema (`mtime_ms`, optional `content_hash`).
- Keep DB indexes in Phase 2 initialization/migrations:
	- `idx_chunks_file_id`
	- `idx_files_subject`
	- `idx_notes_subject`

## IPC Contract Rules
- Define typed IPC channel names and request/response contracts in `src/shared/ipc/*` before handlers.
- Main, preload, and renderer must import shared contract types (single source of truth).
- Do not add ad-hoc untyped `ipcRenderer.invoke` payloads.

## Delivery Sequence Rules
- Before advanced features, complete a vertical slice:
	- Open vault
	- Index `.md/.txt`
	- Spotlight search
	- Open note from results
- Defer AI DOM automation until vault/search/notes are stable and checkpoints are green.
- PDF page virtualization must be implemented in Phase 3 (not postponed).

## Feature Flag Defaults
- `ENABLE_AI_DOM_AUTOMATION=false`
- `ENABLE_PDF_INDEXING=false` and `ENABLE_PPTX_INDEXING=false` only during vertical-slice bring-up; enable afterward.

## Definition of Done (per phase)
- No unhandled promise rejections in main or renderer.
- New IPC paths are typed and validated.
- Failure paths tested (network down, corrupted file, provider DOM mismatch).
- Manual debug checklist for that phase is fully green.
