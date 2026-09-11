/**
 * Client-side mirror of the security-audit skill's findings.json shape
 * (cloudflare/security-audit report-schema.json) — deliberately lenient
 * (everything optional except verdict) so partially-written or drifted
 * outputs still render instead of crashing the panel.
 */
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'informational'

export interface TraceStep {
  kind?: 'entrypoint' | 'propagation' | 'sink' | string
  file?: string
  line?: number
  scope?: string
  description?: string
}

export interface EvidenceItem {
  file?: string
  line?: number
  description?: string
}

export interface ConditionItem {
  kind?: string
  description?: string
}

export interface ExecutionInfo {
  attacker_perspective?: string
  payloads?: string[]
  instructions?: string[]
  /** Latest schema name (required in the confirmed variant). */
  observed_result?: string
  /** Pre-rename outputs; rendered as a fallback. */
  expected_result?: string
}

export interface RemediationInfo {
  strategy?: string
  code_changes?: { file_name?: string; fixed_code?: string }[]
}

export interface SeverityInfo {
  likelihood?: { score?: string; reason?: string }
  impact?: { score?: string; reason?: string }
  overall_severity?: Severity | string
}

export interface ConfidenceInfo {
  score?: 'low' | 'medium' | 'high' | string
  reason?: string
}

export interface ValidationPlan {
  local?: string
  deployment?: string
}

export interface ConfirmedFinding {
  verdict: 'confirmed'
  title?: string
  description?: string
  root_cause?: string
  intended_behavior?: string
  trace?: TraceStep[]
  evidence?: EvidenceItem[]
  conditions?: ConditionItem[]
  execution?: ExecutionInfo
  remediation?: RemediationInfo
  severity?: SeverityInfo
  confidence?: ConfidenceInfo
}

/** A candidate whose decisive validation is blocked (schema verdict 'needs_validation'). */
export interface BlockedFinding {
  verdict: 'needs_validation'
  title?: string
  description?: string
  claimed_root_cause?: string
  trace?: TraceStep[]
  evidence?: EvidenceItem[]
  blockers?: string[]
  validation_plan?: ValidationPlan
}

export interface RejectedFinding {
  verdict: string
  title?: string
  description?: string
  claimed_root_cause?: string
  trace?: TraceStep[]
  evidence?: EvidenceItem[]
  reason?: string
}

export type Finding = ConfirmedFinding | BlockedFinding | RejectedFinding

export function isConfirmed(finding: Finding): finding is ConfirmedFinding {
  return finding.verdict === 'confirmed'
}

export function isBlocked(finding: Finding): finding is BlockedFinding {
  return finding.verdict === 'needs_validation'
}

export interface FindingCounts {
  total: number
  confirmed: number
  needsValidation: number
  rejected: number
  severity: Record<Severity, number>
}

export interface RunInfo {
  repo: string
  name: string
  dir: string
  files: Record<string, boolean | undefined>
  updatedAt: number
  counts?: FindingCounts
  parseError?: string
}

export interface RunsResponse {
  root: string
  /** The live workspace (session cwd) — base for workspace-relative file refs. */
  workspace: string
  runs: RunInfo[]
}

export interface TextFileResponse {
  dir: string
  file: string
  content: string
  truncated: boolean
}

/** Parse findings.json content leniently; returns the finding list. */
export function parseFindings(content: string): { findings: Finding[]; parseError?: string } {
  try {
    const parsed: unknown = JSON.parse(content)
    if (!Array.isArray(parsed)) return { findings: [], parseError: 'findings.json is not an array' }
    return { findings: parsed as Finding[] }
  } catch (e) {
    return { findings: [], parseError: e instanceof Error ? e.message : String(e) }
  }
}
