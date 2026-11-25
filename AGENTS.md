# ✦ Vela

**Vela** is a minimal, high-performance desktop and web control plane for local coding agents. A Node/Effect WebSocket & HTTP server wraps local provider CLIs and agents (Codex, Claude Code, Cursor, Antigravity, Pi, OpenCode, Grok, Kiro, Muse Code, fx, and ACP agents) and serves the Vela web and Electron desktop clients.

Vela is a customized, standalone product forked from MIT-licensed open-source foundations, featuring monochrome `✦ Vela` branding, local-first operation (external cloud relay / marketing telemetry disabled), project configuration via `vela.json` (with read-only fallback to `t3.json`), and built-in **Unified MCP Management** (`/settings/mcp`, `/api/vela/mcp/*`).

## Core principles

1. **Local-first & minimal**: Keep the UI clean, monochrome, and fast. Avoid unnecessary cloud prompts, marketing banners, or heavy background animations.
2. **Performance without compromise**: Keep WebSocket payloads bounded, avoid GPU-pegging CSS animations, and keep large lists responsive.
3. **Multi-provider parity**: When adding capabilities, keep provider adapters cleanly separated at the adapter boundary.
4. **Config safety**: Never clobber unrelated user settings or comments when editing external CLI configs (`~/.codex/config.toml`, `~/.claude.json`, etc.). Always mask secrets in API responses and preserve `.vela.bak` backups.

## Architecture & where code lives

- `apps/server` — Effect/Node WebSocket & HTTP server, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), providers, checkpointing, and Unified MCP manager (`apps/server/src/mcp/UnifiedMcpManager.ts` & `unifiedMcpRoutes.ts`).
- `apps/web` — React + Vite UI, including `/settings/mcp` (`UnifiedMcpSettingsPanel.tsx`) and TanStack Router routes.
- `apps/desktop` — Electron desktop wrapper (`Vela` / `Vela (Dev).app`) bundling the local server runner and native menus.
- `packages/contracts` — Effect/Schema wire contracts shared across server, web, and desktop (note: workspace packages retain internal `@t3tools/*` / `t3` package identifiers to avoid unnecessary import churn).
- `packages/shared` — Shared runtime utilities with subpath exports.
- `packages/client-runtime` — Client connection and domain state shared across clients.
- `packages/provider-*` — Individual coding agent CLI adapters (`provider-pi`, `provider-cursor`, `provider-acp`, `provider-opencode`, `provider-kiro`, `provider-grok`, `provider-muse`, `provider-fx`, `provider-core`).

## Project configuration (`vela.json`)

Repositories opened in Vela can define project actions, icons, and worktree setup commands in `vela.json` at the repo root (read-only fallback to legacy `t3.json` is preserved in `apps/server/src/project/T3ProjectFileLoader.ts`).

## Safety rules

1. **Never kill processes by broad pattern** (`pkill -f`, `pgrep | kill`). Only stop PIDs captured at spawn or verified port owners.
2. **Never bake dev origins**: Do not set `VITE_HTTP_URL` or `VITE_WS_URL` in dev; Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`.
3. **Do not commit or push automatically**: Leave git working tree changes uncommitted unless explicitly asked by the user.

## Development & verification

- Tooling uses **Vite+** (`vp`, installed via `~/.config/vite-plus/env`).
- Start desktop dev environment: `vp run dev:desktop`
- Typecheck affected packages: `vp run --filter t3 --filter @t3tools/web typecheck` (uses `effect-tsgo tsrs --noEmit`)
- Run focused tests: `cd apps/server && vp test run <file>`
- Update translations after UI copy edits: `vp run --filter @t3tools/web i18n:generate`

## Coding conventions

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Server services use Effect (`Effect.fn("Service.operation")`) with thin HTTP/RPC handlers; avoid `try/catch` directly inside `Effect.gen` (use `Effect.try`).
- Keep `apps/web/src/components/ui` primitives consistent with Vela's monochrome design tokens.
- Prefer inferred types over redundant annotations; avoid `any`.
- Keep comments concise and only for non-obvious invariants or external quirks.
- React `useEffect` is only for syncing with external systems; annotate justified effects with `// oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <reason>`.
