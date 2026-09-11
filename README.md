# dsh-plugins

Collection of DeepSeek Harness (DSH) plugins. Each directory is a standalone pnpm package.

| Package | Description |
| ------- | ----------- |
| `dsh-fff-follow-workspace` | Persistent fff search tools (`ffgrep` / `fffind` / `fff_multi_grep`) bridged over MCP stdio; one server rooted at each active session workspace |
| `dsh-ina-theme` | Ina theme for DSH: eggplant-indigo surfaces with rose-magenta brand and amber highlights, plus a Settings page for Auto/Light/Dark variants |
| `dsh-sidebar-security-audit` | `dsh-better-sidebar` panel for the cloudflare/security-audit skill: severity stats, finding cards, one-click report opening |
| `dsh-phoenix-tracing` | Arize Phoenix tracing backend: projects session telemetry onto OpenInference spans and exports them over OTLP/HTTP |
| `dsh-shtv` | Inline Playwright MCP screenshot card + Live Browser sidebar panel for the DSH web GUI; host serves workspace screenshots and a live frame pump over fenced loopback routes (`/api/dsh-shtv`) |

## Install

Each package is a standalone pnpm package, installable directly from this repo:

```sh
pnpm add github:silentdragonz/dsh-plugins#path:/dsh-phoenix-tracing
```
