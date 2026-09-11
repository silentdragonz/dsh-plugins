/**
 * Panel styles: one <style> tag injected once. Colors are theme-neutral
 * (translucent grays + fixed severity colors) so the panel reads on both
 * light and dark shells.
 */
export const STYLE_TAG_ID = 'dsh-sidebar-security-audit-styles'

export const PANEL_CSS = `.dsa-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; font-size: 12.5px; line-height: 1.5; }
.dsa-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 24px; }
.dsa-header { padding: 10px 12px 8px; border-bottom: 1px solid rgba(128,128,128,0.22); }
.dsa-root-row { display: flex; gap: 6px; align-items: center; margin-top: 6px; }
.dsa-root-input { flex: 1; min-width: 0; background: rgba(128,128,128,0.10); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 4px 8px; font-size: 11.5px; font-family: ui-monospace, monospace; }
.dsa-btn { background: rgba(128,128,128,0.14); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 4px 10px; font-size: 11.5px; cursor: pointer; white-space: nowrap; }
.dsa-btn:hover { background: rgba(128,128,128,0.24); }
.dsa-btn.active { background: rgba(77,107,254,0.25); border-color: rgba(77,107,254,0.6); }
.dsa-hint { color: rgba(128,128,128,0.95); font-size: 11px; margin-top: 4px; }
.dsa-error { margin: 8px 12px; padding: 8px 10px; border-radius: 8px; background: rgba(229,72,77,0.12); border: 1px solid rgba(229,72,77,0.45); }
.dsa-select { width: 100%; background: rgba(128,128,128,0.10); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 5px 8px; font-size: 12px; }
.dsa-stats { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 6px; }
.dsa-stat { display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px; border-radius: 999px; border: 1px solid rgba(128,128,128,0.28); background: rgba(128,128,128,0.08); font-size: 11.5px; cursor: pointer; user-select: none; }
.dsa-stat.static { cursor: default; }
.dsa-stat.on { border-color: currentColor; background: rgba(128,128,128,0.20); }
.dsa-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dsa-filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
.dsa-search { flex: 1; min-width: 120px; background: rgba(128,128,128,0.10); color: inherit; border: 1px solid rgba(128,128,128,0.28); border-radius: 6px; padding: 4px 8px; font-size: 11.5px; }
.dsa-files { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.dsa-card { border: 1px solid rgba(128,128,128,0.26); border-left-width: 3px; border-radius: 8px; margin-bottom: 8px; background: rgba(128,128,128,0.05); overflow: hidden; }
.dsa-card-head { padding: 8px 10px; cursor: pointer; }
.dsa-card-title { font-weight: 600; margin: 4px 0 0; }
.dsa-badges { display: inline-flex; gap: 5px; align-items: center; vertical-align: middle; }
.dsa-badge { font-size: 10px; font-weight: 700; letter-spacing: 0.4px; text-transform: uppercase; border-radius: 4px; padding: 1px 6px; color: #fff; }
.dsa-badge.ghost { color: inherit; border: 1px solid rgba(128,128,128,0.4); background: transparent; font-weight: 600; }
.dsa-card-body { padding: 2px 10px 10px; border-top: 1px dashed rgba(128,128,128,0.25); }
.dsa-sec { margin-top: 8px; }
.dsa-sec > summary { cursor: pointer; font-weight: 600; font-size: 11.5px; opacity: 0.9; }
.dsa-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 4px 0; }
.dsa-pre { white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(128,128,128,0.12); border-radius: 6px; padding: 6px 8px; margin: 4px 0; font-family: ui-monospace, monospace; font-size: 11px; }
.dsa-trace { list-style: none; margin: 4px 0; padding: 0; }
.dsa-trace li { margin: 4px 0; padding-left: 8px; border-left: 2px solid rgba(128,128,128,0.35); }
.dsa-code-ref { font-family: ui-monospace, monospace; font-size: 11px; background: rgba(128,128,128,0.14); border-radius: 4px; padding: 0 4px; }
.dsa-code-ref.dsa-link { color: inherit; border: 0; cursor: pointer; text-align: left; font: inherit; font-family: ui-monospace, monospace; font-size: 11px; background: rgba(128,128,128,0.14); border-radius: 4px; padding: 0 4px; }
.dsa-code-ref.dsa-link:hover { text-decoration: underline; }
.dsa-kind { font-size: 10px; font-weight: 700; text-transform: uppercase; border-radius: 4px; padding: 0 5px; margin-right: 4px; border: 1px solid rgba(128,128,128,0.4); }
.dsa-empty { padding: 28px 16px; text-align: center; opacity: 0.8; }
.dsa-rejected { border-left-color: #8d8d8d !important; opacity: 0.85; }
`

/** Inject the panel stylesheet once per document. */
export function injectStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_TAG_ID) !== null) return
  const tag = document.createElement('style')
  tag.id = STYLE_TAG_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
}
