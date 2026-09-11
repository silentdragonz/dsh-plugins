/**
 * The Security Audit sidebar tab: discovers audit runs (host route), selects
 * one, parses its findings.json and renders severity stats, filters, finding
 * cards, and one-click opening of the run's markdown artifacts through the
 * better-sidebar file viewer. File refs inside findings (trace entry/sink
 * paths) open the file's directory in the harness open-in-app editor
 * (dsh >= 0.1.5-rc.1) when the host probed one.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TabComponentProps, BetterSidebarService } from 'dsh-better-sidebar'
import { api, openInApp } from './api.ts'
import { parseFindings, isConfirmed, type Finding, type RunInfo } from './types.ts'
import { SEVERITY_ORDER, SEVERITY_COLORS, SEVERITY_LABELS, asSeverity } from './severity.ts'
import { FindingCard } from './FindingCard.tsx'
import { injectStyles } from './styles.ts'

/** localStorage key for the root override. */
const ROOT_KEY = 'dsh-sidebar-security-audit:root'
/** localStorage key for the open-in-app editor choice (probed app id). */
const OPEN_APP_KEY = 'dsh-sidebar-security-audit:open-app'
/** Artifacts openable in the sidebar viewer (host-whitelisted). */
const ARTIFACTS = ['REPORT.md', 'FINDINGS-DETAIL.md', 'architecture.md'] as const
/**
 * Preferred default editors, in open-in-app catalog preference order. The
 * probed catalog lists file managers first (finder/explorer/filemanager —
 * xdg-open probes as installed on nearly every host), which is the wrong
 * default for a file link; editors come first here, file managers last.
 */
const EDITOR_PRIORITY: readonly string[] = [
  'cursor', 'vscode', 'windsurf', 'vscodeinsiders', 'zed',
  'sublimetext', 'xcode', 'androidstudio', 'finder', 'explorer', 'filemanager',
]

type VerdictFilter = 'all' | 'confirmed' | 'rejected'

function loadStoredRoot(): string {
  try {
    return window.localStorage.getItem(ROOT_KEY) ?? ''
  } catch {
    return ''
  }
}

function storeRoot(root: string): void {
  try {
    if (root === '') window.localStorage.removeItem(ROOT_KEY)
    else window.localStorage.setItem(ROOT_KEY, root)
  } catch { /* storage unavailable */ }
}

function formatTime(ms: number): string {
  if (ms <= 0) return 'unknown'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return 'unknown'
  }
}

export interface AuditPanelProps extends TabComponentProps {
  service: BetterSidebarService
}


/** The panel's default open-in-app app: the best probed editor, else the first probed app. */
function defaultOpenApp(apps: readonly string[]): string {
  for (const id of EDITOR_PRIORITY) {
    if (apps.includes(id)) return id
  }
  return apps[0] ?? ''
}
export function AuditPanel(props: AuditPanelProps): ReactNode {
  const { scope, service, visible } = props
  const [rootDraft, setRootDraft] = useState<string>(loadStoredRoot)
  const [root, setRoot] = useState<string>(loadStoredRoot)
  const [serverRoot, setServerRoot] = useState<string>('')
  const [workspace, setWorkspace] = useState<string>('')
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [selectedDir, setSelectedDir] = useState<string>('')
  const [findings, setFindings] = useState<Finding[]>([])
  const [parseError, setParseError] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [loadingRuns, setLoadingRuns] = useState(false)
  const [loadingFindings, setLoadingFindings] = useState(false)
  const [sevFilter, setSevFilter] = useState<Set<string>>(new Set())
  const [verdict, setVerdict] = useState<VerdictFilter>('all')
  const [query, setQuery] = useState('')
  const [openApps, setOpenApps] = useState<string[]>([])
  const [openChoice, setOpenChoice] = useState<string>(() => {
    try {
      return window.localStorage.getItem(OPEN_APP_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [openError, setOpenError] = useState<string>('')
  useEffect(() => { injectStyles() }, [])
  // Probe the open-in-app catalog once; a host without the harness routes
  // (dsh < 0.1.5-rc.1) answers empty and file refs render inert.
  useEffect(() => { void openInApp.apps().then(setOpenApps) }, [])

  const refresh = useCallback(async (rootOverride?: string) => {
    setLoadingRuns(true)
    setError('')
    setOpenError('')
    try {
      const resp = await api.runs(rootOverride !== undefined && rootOverride !== '' ? rootOverride : undefined)
      setRuns(resp.runs)
      setServerRoot(resp.root)
      setWorkspace(resp.workspace)
      setSelectedDir(prev => (
        resp.runs.some(r => r.dir === prev) ? prev : (resp.runs[0]?.dir ?? '')
      ))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setRuns([])
      setSelectedDir('')
    } finally {
      setLoadingRuns(false)
    }
  }, [])

  useEffect(() => {
    void refresh(root !== '' ? root : undefined)
  }, [refresh, root])

  // Refresh when the tab becomes visible (cheap: one scan of a small tree).
  useEffect(() => {
    if (visible) void refresh(root !== '' ? root : undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  const selected = useMemo(() => runs.find(r => r.dir === selectedDir), [runs, selectedDir])

  useEffect(() => {
    let cancelled = false
    if (selectedDir === '' || serverRoot === '') {
      setFindings([])
      setParseError('')
      return
    }
    setLoadingFindings(true)
    api.findings(selectedDir, serverRoot)
      .then(resp => {
        if (cancelled) return
        const parsed = parseFindings(resp.content)
        setFindings(parsed.findings)
        setParseError(parsed.parseError ?? (resp.truncated ? 'findings.json truncated (too large)' : ''))
      })
      .catch(e => {
        if (cancelled) return
        setFindings([])
        setParseError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => { if (!cancelled) setLoadingFindings(false) })
    return () => { cancelled = true }
  }, [selectedDir, serverRoot])

  const clientCounts = useMemo(() => {
    const counts = { total: findings.length, confirmed: 0, rejected: 0 }
    for (const f of findings) {
      if (isConfirmed(f)) counts.confirmed += 1
      else counts.rejected += 1
    }
    return counts
  }, [findings])

  const sevCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const f of findings) {
      if (!isConfirmed(f)) continue
      const sev = asSeverity(f.severity?.overall_severity)
      map[sev] = (map[sev] ?? 0) + 1
    }
    return map
  }, [findings])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const rankOf = (f: Finding): number => isConfirmed(f)
      ? SEVERITY_ORDER.indexOf(asSeverity(f.severity?.overall_severity))
      : SEVERITY_ORDER.length // rejected always last
    return findings
      .filter(f => {
        if (verdict === 'confirmed' && !isConfirmed(f)) return false
        if (verdict === 'rejected' && isConfirmed(f)) return false
        if (isConfirmed(f) && sevFilter.size > 0 && !sevFilter.has(asSeverity(f.severity?.overall_severity))) return false
        if (q !== '') {
          const hay = isConfirmed(f)
            ? `${f.title ?? ''} ${f.description ?? ''} ${f.root_cause ?? ''}`
            : `${f.title ?? ''} ${f.reason ?? ''}`
          if (!hay.toLowerCase().includes(q)) return false
        }
        return true
      })
      .sort((a, b) => rankOf(a) - rankOf(b))
  }, [findings, verdict, sevFilter, query])

  const toggleSev = (sev: string): void => {
    setSevFilter(prev => {
      const next = new Set(prev)
      if (next.has(sev)) next.delete(sev)
      else next.add(sev)
      return next
    })
  }

  const applyRoot = (): void => {
    const next = rootDraft.trim()
    storeRoot(next)
    setRoot(next)
  }

  /** Remember the open-in-app editor choice (probed app id). */
  const chooseOpenApp = (appId: string): void => {
    setOpenChoice(appId)
    try {
      window.localStorage.setItem(OPEN_APP_KEY, appId)
    } catch { /* storage unavailable */ }
  }

  /**
   * Launch the user's editor on the directory holding a finding's file ref.
   * Trace paths are repo-relative (absolute and `./`-prefixed are honored);
   * the harness open route takes directories only, so the file's parent
   * directory is the target.
   */
  const openFileRef = useCallback((file: string): void => {
    if (openApps.length === 0) return
    const clean = file.trim().replace(/^\.\//, '')
    const abs = clean !== '' && clean.startsWith('/')
      ? clean
      : workspace !== '' && clean !== '' ? `${workspace}/${clean}` : ''
    if (abs === '') {
      setOpenError('file ref is relative but no workspace is known')
      return
    }
    const slash = abs.lastIndexOf('/')
    const dir = slash > 0 ? abs.slice(0, slash) : workspace
    const app = openChoice !== '' && openApps.includes(openChoice) ? openChoice : defaultOpenApp(openApps)
    if (app === '') return
    setOpenError('')
    void openInApp.launch(app, dir).catch((e: unknown) => {
      setOpenError(e instanceof Error ? e.message : String(e))
    })
  }, [openApps, openChoice, workspace])

  const openArtifact = (file: string): void => {
    if (selected === undefined) return
    const path = `${selected.dir}/${file}`
    service.openFile(scope, path, `${selected.repo !== '.' ? selected.repo + '/' : ''}${selected.name} · ${file}`)
  }

  return (
    <div className="dsa-panel">
      <div className="dsa-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <b>Security Audit</b>
          <span style={{ flex: 1 }} />
          <button className="dsa-btn" onClick={() => void refresh(root !== '' ? root : undefined)} disabled={loadingRuns}>
            {loadingRuns ? 'Scanning…' : 'Refresh'}
          </button>
        </div>
        <div className="dsa-root-row">
          <input
            className="dsa-root-input"
            value={rootDraft}
            placeholder={serverRoot !== '' ? serverRoot : '~/security-audit-skill'}
            onChange={e => setRootDraft(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyRoot() }}
            spellCheck={false}
            title="Audit root directory (absolute, ~/…, or relative to the workspace)"
          />
          {root !== '' && (
            <button className="dsa-btn" onClick={() => { setRootDraft(''); storeRoot(''); setRoot('') }} title="Back to server default">
              Default
            </button>
          )}
          <button className="dsa-btn" onClick={applyRoot}>Go</button>
          {openApps.length > 0 && (
            <select
              className="dsa-select"
              value={openChoice !== '' && openApps.includes(openChoice) ? openChoice : defaultOpenApp(openApps)}
              onChange={e => chooseOpenApp(e.target.value)}
              title="Editor for finding file links (harness open-in-app)"
            >
              {openApps.map(id => <option key={id} value={id}>{id}</option>)}
            </select>
          )}
        </div>
        <div className="dsa-hint">
          Scans <code>{serverRoot !== '' ? serverRoot : '…'}</code> — prefers the workspace's
          .security-audit folder, else the skill's default output root.
        </div>
      </div>
      {error !== '' && <div className="dsa-error">Scan failed: {error}</div>}
      {openError !== '' && <div className="dsa-error">Open failed: {openError}</div>}

      <div className="dsa-scroll">
        {runs.length === 0 && !loadingRuns && error === '' && (
          <div className="dsa-empty">
            <div style={{ fontSize: 22, marginBottom: 6 }}>🛡️</div>
            <div>No audit runs found yet.</div>
            <div className="dsa-hint" style={{ marginTop: 8 }}>
              Ask the agent to run the <b>security-audit</b> skill on a repo; each run writes
              findings.json / REPORT.md under {'<root>/<repo>/run-<N>'}.
            </div>
          </div>
        )}

        {runs.length > 0 && (
          <>
            <select
              className="dsa-select"
              value={selectedDir}
              onChange={e => setSelectedDir(e.target.value)}
            >
              {runs.map(r => (
                <option key={r.dir} value={r.dir}>
                  {r.repo !== '.' ? `${r.repo} / ` : ''}{r.name}
                  {r.counts !== undefined ? ` — ${r.counts.confirmed} confirmed / ${r.counts.rejected} rejected` : ''}
                </option>
              ))}
            </select>

            {selected !== undefined && (
              <>
                <div className="dsa-hint" style={{ marginTop: 6 }}>
                  {selected.dir} · updated {formatTime(selected.updatedAt)}
                </div>
                {selected.parseError !== undefined && (
                  <div className="dsa-error" style={{ margin: '6px 0' }}>{selected.parseError}</div>
                )}

                <div className="dsa-files">
                  {ARTIFACTS.filter(f => selected.files[f] === true).map(f => (
                    <button key={f} className="dsa-btn" onClick={() => openArtifact(f)} title="Open in sidebar viewer">
                      📄 {f}
                    </button>
                  ))}
                </div>

                <div className="dsa-stats">
                  <span className="dsa-stat static"><b>{clientCounts.confirmed}</b>&nbsp;confirmed</span>
                  <span className="dsa-stat static"><b>{clientCounts.rejected}</b>&nbsp;rejected</span>
                  {SEVERITY_ORDER.map(sev => (
                    <span
                      key={sev}
                      className={`dsa-stat${sevFilter.has(sev) ? ' on' : ''}`}
                      style={{ color: SEVERITY_COLORS[sev] }}
                      onClick={() => toggleSev(sev)}
                      title="Filter by severity"
                    >
                      <span className="dsa-dot" style={{ background: SEVERITY_COLORS[sev] }} />
                      {SEVERITY_LABELS[sev]} <b>{sevCounts[sev] ?? 0}</b>
                    </span>
                  ))}
                </div>

                <div className="dsa-filters">
                  <button className={`dsa-btn${verdict === 'all' ? ' active' : ''}`} onClick={() => setVerdict('all')}>All</button>
                  <button className={`dsa-btn${verdict === 'confirmed' ? ' active' : ''}`} onClick={() => setVerdict('confirmed')}>Confirmed</button>
                  <button className={`dsa-btn${verdict === 'rejected' ? ' active' : ''}`} onClick={() => setVerdict('rejected')}>Rejected</button>
                  <input
                    className="dsa-search"
                    placeholder="Search findings…"
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                  />
                </div>
              </>
            )}

            {loadingFindings && <div className="dsa-hint">Loading findings.json…</div>}
            {!loadingFindings && parseError !== '' && (
              <div className="dsa-error">findings.json: {parseError}</div>
            )}
            {!loadingFindings && findings.length > 0 && (
              <>
                {filtered.map((f, i) => (
                  <FindingCard key={i} finding={f} index={i} onOpenFile={openApps.length > 0 ? openFileRef : undefined} />
                ))}
                {filtered.length === 0 && <div className="dsa-empty">No findings match the current filters.</div>}
              </>
            )}
            {!loadingFindings && findings.length === 0 && parseError === '' && selected !== undefined && selected.files['findings.json'] !== true && (
              <div className="dsa-hint">This run has no findings.json yet (structured output is Phase 5 of the skill).</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
