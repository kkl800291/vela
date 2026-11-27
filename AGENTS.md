# ✦ Vela

**Vela** is a minimal, high-performance desktop and web control plane for local coding agents. A Node/Effect WebSocket & HTTP server wraps local provider CLIs and agents (Codex, Claude Code, Cursor, Antigravity, Pi, OpenCode, Grok, Kiro, Muse Code, fx, and ACP agents) and serves the Vela web and Electron desktop clients.

Vela is a customized, standalone product forked from MIT-licensed open-source foundations, featuring monochrome `✦ Vela` branding, local-first operation (external cloud relay / marketing telemetry disabled), project configuration via `vela.json` (with read-only fallback to `t3.json`), and built-in **Unified MCP Management** (`/settings/mcp`, `/api/vela/mcp/*`).

## Core principles

1. **Local-first & minimal**: Keep the UI clean, monochrome, and fast. Avoid unnecessary cloud prompts, marketing banners, or heavy background animations.
2. **Performance without compromise**: Keep WebSocket payloads bounded, avoid GPU-pegging CSS animations, and keep large lists responsive.
3. **Multi-provider parity**: When adding capabilities, keep provider adapters cleanly separated at the adapter boundary.
4. **Config safety**: Never clobber unrelated user settings or comments when editing external CLI configs (`~/.codex/config.toml`, `~/.claude.json`, etc.). Always mask secrets in API responses and preserve `.vela.bak` backups.
5. **Single-orchestrator multi-agent collaboration**: Keep one main thread as orchestrator and reviewer while parallel dev workers run in isolated worktrees. Never flood the user with ephemeral review threads.

## Multi-agent collaboration

Authoritative architecture and invariants live in [docs/internals/18_multi-agent-collaboration.md](./docs/internals/18_multi-agent-collaboration.md). Any work touching dispatch, multi-agent delegation, review queues, or worktree delivery must uphold these rules:

1. **Orchestrator owns verdicts; separate context hygiene from thread noise**: One main thread plans, reviews, and delivers; parallel dev workers execute in isolated managed worktrees. Reuse existing threads for continuous multi-turn discussions and dev repairs; perform routine step-by-step review sequentially in the main thread (author ≠ reviewer). Reserve fresh-context read-only audits for an optional single pre-delivery batch cold audit (`base..delivery`) or an explicitly requested high-risk second opinion—folded into the collaboration card with findings returned to the orchestrator for final verdict.
2. **Bind review and delivery to immutable snapshots**: Automated gates, orchestrator verdicts, serial integration, and final delivery must bind to frozen Git workspace snapshots (`refs/vela/collab/*` synthetic commits that never touch user branches or the real Git index). If integration alters the effective changes, re-run gates and re-review; never read live worktrees or live `HEAD` as the delivery source.
3. **Queue collaboration wakes with durable recovery**: Deliver orchestrator inbox items strictly in persisted FIFO order (`mode: "queue"`, never `auto` or promoted to `steer`), with at most one active collaboration item per parent thread and verified dedicated `runId` binding. Commit state transitions, receipts, and outbox intents in SQLite before running external Git, thread, or filesystem side effects, and reconcile on startup.
4. **Integrate in isolation; apply once on user confirmation**: Only approved immutable snapshots enter the hidden integration workspace, unlocking dependent DAG steps only after integration reconciles. Run batch cross-step verification before exposing one unified delivery diff for explicit user application (preserving the target workspace's real index and manual edits; never auto-commit or push).
5. **Isolate failures along dependencies**: Conflicts, human decisions, repair limits, and incomplete review turns pause only the affected step and its downstream dependents while independent work and the review queue continue. Recovery and revert paths must reject stale evidence and preserve user edits.
6. **Server owns collaboration state**: Chat-initiated and panel-initiated collaborations share one server-owned durable engine and one live collaboration card. Clients render bounded projections, evidence is read on demand by snapshot ID, and provider quirks stay at the adapter boundary.

## Architecture & where code lives

- `apps/server` — Effect/Node WebSocket & HTTP server, event-sourced orchestration (`Orchestrator` → `EventSink` → `EffectWorker`), multi-agent collaboration & dispatch (`apps/server/src/dispatch`), providers, checkpointing, and Unified MCP manager (`apps/server/src/mcp/UnifiedMcpManager.ts` & `unifiedMcpRoutes.ts`).
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
