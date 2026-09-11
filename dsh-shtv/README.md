# dsh-shtv — inline screenshots + Live Browser panel for DSH web

A self-contained DSH profile bundle (no desktop browser) that makes Playwright MCP
browser output visible in the DSH web GUI:

1. **Inline screenshot card** — replaces the tool row for
   `mcp__browser__browser_take_screenshot` with an actual `<img>`. Click for a
   full-size modal (Esc / click-away to close).
2. **Live Browser sidebar tab** (`dsh-better-sidebar`) — a live view of the
   headless browser while it is in use, with Play / Pause.

Images reach the browser as plain **same-origin** URLs (`/api/dsh-shtv/…`), so
they satisfy the page CSP (`img-src 'self'`) and survive reload — no blob/base64.

## Architecture

```
headless Chromium  (Playwright MCP, --isolated)
      │  page.screenshot({path})            ← "frame pump" runs inside the MCP
      ▼                                       server process; agent starts it
.playwright-mcp/live/frame.jpg               via browser_run_code_unsafe
      │  fs.readFile
      ▼
Host route  /api/dsh-shtv/live/frame         ← this bundle, loopback-trusted
      │  same-origin <img src=…?tick=N>
      ▼
Live Browser sidebar tab / standalone /live/page
```

* Host routes (all `GET`, loopback / `trustedHosts` only, cross-site refused):
  * `/health` → `{ok, workspace}`
  * `/image?path=<rel|abs>` → any workspace image, symlink-escape refused, 8 MB cap
  * `/live/frame` → newest pump frame, `cache-control: no-store`
  * `/live/meta` → `{exists, bytes, ageMs, active, pump}`
  * `/live/stopstate` → pump heartbeat + play/pause flag (the pump polls this)
  * `/live/set?on=1|0` → panel Play/Pause toggles `active`
  * `/live/page` → self-refreshing standalone viewer
* Client bundle registers the `tool.call.toolview` card (keyed takeover) and the
  sidebar tab. The tab's Play, when no pump heartbeat is seen, sends a message to
  the current conversation asking the agent to seed the pump.

## The frame pump (agent-run)

Only the agent can inject code into the MCP browser. When you ask for **live
view** (or press Play with no pump), run this via `browser_run_code_unsafe`:

```js
async (page) => {
  const dir = '/workspace/workspace/research/.playwright-mcp/live';
  const state = async () => {
    try { const r = await page.request.get('http://127.0.0.1:3080/api/dsh-shtv/live/stopstate'); return await r.json(); }
    catch (e) { return null; }
  };
  void (async () => {
    while (true) {
      const st = await state();
      if (st === null || st.stop) break;              // host gone or stop
      if (st.active) {
        try { await page.screenshot({ path: dir + '/frame.jpg', type: 'jpeg', quality: 55, scale: 'css' }); }
        catch (e) { break; }                          // page closed
      }
      try { await page.waitForTimeout(st.active ? 600 : 1000); } catch (e) { break; }
    }
  })();
  return { pump: 'armed (host-paused until Play)' };
}
```

The pump **idles** until the panel is in Play (or `/live/set?on=1`), so it costs
nothing when nobody is watching. `page.request` runs Node-side in the MCP server,
so it reaches the host regardless of the page's CSP / mixed-content rules.

## Install / update (profile-scoped, survives restart)

```sh
dsh plugin --profile web add file:/workspace/workspace/research/dsh-shtv
# then restart the `web` profile so the Host route family re-registers
```

`cordis.patch.yml` is a self-composing bundle patch — the `shtv` row mounts on
every profile boot with no per-session approval. Remove with
`dsh plugin --profile web remove dsh-shtv`.

## Notes

* Workspace defaults to `/workspace/workspace/research`; override with plugin
  `config.workspace`.
* The pump targets the MCP browser's current page. Navigation in that page is
  what you want to watch; a page crash ends the pump (it re-arms on next seed).
* Frame cadence ~1.5 fps (jpeg q55) — a preview, not video. Uses the same
  Playwright capture path the normal tool uses; no extra browser is launched.
