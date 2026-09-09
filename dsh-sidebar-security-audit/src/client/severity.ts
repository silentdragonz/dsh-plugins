/**
 * Severity presentation map: color, order and labels shared by stats,
 * filters and finding cards.
 */
import type { Severity } from './types.ts'

export const SEVERITY_ORDER: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'informational']

export const SEVERITY_COLORS: Record<Severity, string> = {
  critical: '#e5484d',
  high: '#f76b15',
  medium: '#e8b931',
  low: '#46a758',
  informational: '#8d8d8d',
}

export const SEVERITY_LABELS: Record<Severity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
  informational: 'Info',
}

/** Coerce any severity-ish string to a known severity (default informational). */
export function asSeverity(value: unknown): Severity {
  return typeof value === 'string' && (SEVERITY_ORDER as readonly string[]).includes(value)
    ? (value as Severity)
    : 'informational'
}
