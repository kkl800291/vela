<p align="center">
  <img src="./apps/web/public/icon-192.png" width="76" height="76" alt="Vela logo" />
</p>

<h1 align="center">✦ Vela</h1>

<p align="center">多代理编程工作台 — 统一驱动本机所有编码 Agent 与 MCP 服务。</p>

---

**Vela** 是一款极简、高性能的本地桌面端与 Web 端多代理编程控制台。它通过统一的 Node/Effect 本地服务驱动你机器上已登录的各类编码 Agent CLI（Codex、Claude Code、Cursor、Antigravity、Pi、OpenCode、Grok、Kiro、Muse Code、fx 及任意 ACP 代理），在一个统一界面中完成会话编排、Git Worktree 隔离、Diff 审查、统一 MCP 管理与多代理协作。

## 核心特性

- **多引擎统一编排**：在同一工作台内无缝驱动 Codex、Claude Code、Cursor、Antigravity、Pi、Kiro 等本机 Agent，直接使用你已有的订阅与账号，不中转、不加价。
- **统一 MCP 管理 (`/settings/mcp`)**：一处查看、编辑、开关并跨引擎一键同步 Antigravity、Codex、Claude Code、Cursor、Factory 与 Kimi Code 的本机 MCP 配置（自动适配 JSON / TOML，支持敏感凭据脱敏与 `.vela.bak` 自动备份）。
- **内置 Git 与 Worktree**：每个会话支持独立 Worktree 隔离，内置改动对比、提交与快捷项目脚本（通过仓库根目录 `vela.json` 配置）。
- **极简高性能桌面体验**：黑白极简视觉体系，基于 Electron + React/Vite + Effect 构建，低开销、零多余云端打扰。

## 项目结构

- `apps/desktop` — Electron 桌面端壳应用（内置本地服务启动器与窗口管理）
- `apps/web` — React + Vite 主界面（含统一 MCP 管理页、会话视图、设置中心与多语言支持）
- `apps/server` — Effect/Node WebSocket 与 HTTP 服务端（事件溯源编排、Provider 适配、统一 MCP 管理器 `/api/vela/mcp`、Worktree 与终端管理）
- `packages/contracts` — 服务端与客户端共享的 Effect Schema 协议契约
- `packages/client-runtime` — 跨客户端共享的连接与状态同步运行时
- `packages/provider-*` — 各编码 Agent CLI 适配器（Codex、Claude Code、Cursor、Pi、ACP、OpenCode、Kiro 等）
- `packages/shared` — 公共工具模块

## 本地开发

本项目使用 [Vite+](https://vite.plus) (`vp`) 管理依赖、构建与类型检查：

```bash
# 安装依赖
vp i

# 启动桌面端开发环境（含服务端 + Web HMR + Electron）
vp run dev:desktop

# 类型检查
vp run --filter t3 --filter @t3tools/web typecheck
```

## 开源致谢与许可

本仓库源代码采用 [MIT License](./LICENSE) 开源许可，基于 MIT 协议的开源项目 [pingdotgg/t3code](https://github.com/pingdotgg/t3code) 进行独立定制与二次开发。**Vela** 为独立定制版本，拥有完全独立的品牌名称、图标与定制功能（如统一 MCP 管理与多代理协作扩展）。
