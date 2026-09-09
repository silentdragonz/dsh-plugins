/**
 * One finding card: severity/confidence badges, collapsible sections for
 * description, root cause, trace, conditions, execution and remediation.
 * Rejected findings render collapsed with the rejection reason.
 */
import { useState, type ReactNode } from 'react'
import type { Finding, TraceStep } from './types.ts'
import { isConfirmed } from './types.ts'
import { asSeverity, SEVERITY_COLORS, SEVERITY_LABELS } from './severity.ts'

function Badge(props: { color: string; label: string }): ReactNode {
  return <span className="dsa-badge" style={{ background: props.color }}>{props.label}</span>
}

function Section(props: { title: string; defaultOpen?: boolean; children: ReactNode }): ReactNode {
  return (
    <details className="dsa-sec" open={props.defaultOpen || undefined}>
      <summary>{props.title}</summary>
      {props.children}
    </details>
  )
}

function TraceList(props: { steps: TraceStep[] }): ReactNode {
  return (
    <ol className="dsa-trace">
      {props.steps.map((step, i) => (
        <li key={i}>
          {step.kind !== undefined && <span className="dsa-kind">{step.kind}</span>}
          {step.file !== undefined && (
            <span className="dsa-code-ref">
              {step.file}{step.line !== undefined ? `:${step.line}` : ''}
              {step.scope !== undefined ? ` ${step.scope}()` : ''}
            </span>
          )}
          {step.description !== undefined && <div className="dsa-text">{step.description}</div>}
        </li>
      ))}
    </ol>
  )
}

export interface FindingCardProps {
  finding: Finding
  index: number
}

export function FindingCard(props: FindingCardProps): ReactNode {
  const [open, setOpen] = useState(false)
  const { finding } = props

  if (!isConfirmed(finding)) {
    return (
      <div className="dsa-card dsa-rejected">
        <div className="dsa-card-head" onClick={() => setOpen(o => !o)}>
          <span className="dsa-badges">
            <Badge color="#8d8d8d" label="rejected" />
          </span>
          <div className="dsa-card-title">{finding.title ?? `Rejected candidate #${props.index + 1}`}</div>
        </div>
        {open && (
          <div className="dsa-card-body">
            <div className="dsa-text">{finding.reason ?? '(no reason recorded)'}</div>
          </div>
        )}
      </div>
    )
  }

  const severity = asSeverity(finding.severity?.overall_severity)
  const color = SEVERITY_COLORS[severity]
  const trace = finding.trace ?? []
  const conditions = finding.conditions ?? []
  const execution = finding.execution
  const remediation = finding.remediation

  return (
    <div className="dsa-card" style={{ borderLeftColor: color }}>
      <div className="dsa-card-head" onClick={() => setOpen(o => !o)}>
        <span className="dsa-badges">
          <Badge color={color} label={SEVERITY_LABELS[severity]} />
          {finding.confidence?.score !== undefined && (
            <span className="dsa-badge ghost">{String(finding.confidence.score)} conf.</span>
          )}
        </span>
        <div className="dsa-card-title">{finding.title ?? '(untitled finding)'}</div>
        {finding.root_cause !== undefined && !open && (
          <div className="dsa-hint" style={{ marginTop: 4 }}>{finding.root_cause}</div>
        )}
      </div>
      {open && (
        <div className="dsa-card-body">
          {finding.description !== undefined && (
            <Section title="Description" defaultOpen>
              <div className="dsa-text">{finding.description}</div>
            </Section>
          )}
          {finding.root_cause !== undefined && (
            <Section title="Root cause" defaultOpen>
              <div className="dsa-text">{finding.root_cause}</div>
            </Section>
          )}
          {finding.intended_behavior !== undefined && (
            <Section title="Intended behavior">
              <div className="dsa-text">{finding.intended_behavior}</div>
            </Section>
          )}
          {trace.length > 0 && (
            <Section title={`Trace (${trace.length} steps)`} defaultOpen>
              <TraceList steps={trace} />
            </Section>
          )}
          {conditions.length > 0 && (
            <Section title={`Exploitation conditions (${conditions.length})`}>
              <ul className="dsa-text" style={{ margin: '4px 0 4px 18px', padding: 0 }}>
                {conditions.map((c, i) => (
                  <li key={i}><span className="dsa-kind">{c.kind ?? 'condition'}</span>{c.description}</li>
                ))}
              </ul>
            </Section>
          )}
          {execution !== undefined && (
            <Section title="Execution">
              {execution.attacker_perspective !== undefined && (
                <div className="dsa-text"><b>Attacker:</b> {execution.attacker_perspective}</div>
              )}
              {(execution.payloads ?? []).length > 0 && (
                <>
                  <div style={{ marginTop: 6 }}><b>Payloads</b></div>
                  {(execution.payloads ?? []).map((p, i) => <pre className="dsa-pre" key={i}>{p}</pre>)}
                </>
              )}
              {(execution.instructions ?? []).length > 0 && (
                <>
                  <div style={{ marginTop: 6 }}><b>Instructions</b></div>
                  <ol style={{ margin: '4px 0 4px 18px', padding: 0 }}>
                    {(execution.instructions ?? []).map((s, i) => <li key={i} className="dsa-text">{s}</li>)}
                  </ol>
                </>
              )}
              {execution.expected_result !== undefined && (
                <div className="dsa-text" style={{ marginTop: 4 }}><b>Expected result:</b> {execution.expected_result}</div>
              )}
            </Section>
          )}
          {remediation !== undefined && (
            <Section title="Remediation">
              {remediation.strategy !== undefined && <div className="dsa-text">{remediation.strategy}</div>}
              {(remediation.code_changes ?? []).map((c, i) => (
                <div key={i}>
                  {c.file_name !== undefined && <div className="dsa-code-ref">{c.file_name}</div>}
                  {c.fixed_code !== undefined && <pre className="dsa-pre">{c.fixed_code}</pre>}
                </div>
              ))}
            </Section>
          )}
          {finding.severity?.likelihood?.reason !== undefined && (
            <Section title="Severity rationale">
              <div className="dsa-text">
                Likelihood ({String(finding.severity.likelihood.score ?? '-')}): {finding.severity.likelihood.reason}
              </div>
              {finding.severity.impact?.reason !== undefined && (
                <div className="dsa-text">
                  Impact ({String(finding.severity.impact.score ?? '-')}): {finding.severity.impact.reason}
                </div>
              )}
            </Section>
          )}
        </div>
      )}
    </div>
  )
}
