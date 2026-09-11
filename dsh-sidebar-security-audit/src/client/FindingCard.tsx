/**
 * One finding card: severity/confidence badges, collapsible sections for
 * description, root cause, trace, evidence, conditions, execution and
 * remediation. Blocked (needs validation) findings render an amber card
 * with blockers and validation plan; rejected findings stay collapsed with
 * the rejection reason.
 */
import { useState, type ReactNode } from 'react'
import { isConfirmed, isBlocked } from './types.ts'
import type { Finding, TraceStep, EvidenceItem } from './types.ts'
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

function CodeRef(props: {
  file: string
  line?: number
  onOpenFile?: ((file: string, line?: number) => void) | undefined
}): ReactNode {
  const label = `${props.file}${props.line !== undefined ? `:${props.line}` : ''}`
  if (props.onOpenFile === undefined) return <span className="dsa-code-ref">{label}</span>
  return (
    <button
      type="button"
      className="dsa-code-ref dsa-link"
      onClick={e => { e.stopPropagation(); props.onOpenFile?.(props.file, props.line) }}
      title={`Open ${label} in the editor`}
    >
      {label}
    </button>
  )
}

function TraceList(props: { steps: TraceStep[]; onOpenFile?: (file: string, line?: number) => void }): ReactNode {
  return (
    <ol className="dsa-trace">
      {props.steps.map((step, i) => (
        <li key={i}>
          {step.kind !== undefined && <span className="dsa-kind">{step.kind}</span>}
          {step.file !== undefined && (
            <CodeRef file={step.file} line={step.line} onOpenFile={props.onOpenFile} />
          )}
          {step.scope !== undefined && <span className="dsa-code-ref"> {step.scope}()</span>}
          {step.description !== undefined && <div className="dsa-text">{step.description}</div>}
        </li>
      ))}
    </ol>
  )
}

function EvidenceList(props: { items: EvidenceItem[]; onOpenFile?: (file: string, line?: number) => void }): ReactNode {
  return (
    <ul className="dsa-trace">
      {props.items.map((item, i) => (
        <li key={i}>
          {item.file !== undefined && (
            <CodeRef file={item.file} line={item.line} onOpenFile={props.onOpenFile} />
          )}
          {item.description !== undefined && <div className="dsa-text">{item.description}</div>}
        </li>
      ))}
    </ul>
  )
}

export interface FindingCardProps {
  finding: Finding
  index: number
  /** Opens the file (line included when known) in the harness-selected editor; undefined = inert refs. */
  onOpenFile?: (file: string, line?: number) => void
}

export function FindingCard(props: FindingCardProps): ReactNode {
  const [open, setOpen] = useState(false)
  const { finding } = props

  if (isBlocked(finding)) {
    const trace = finding.trace ?? []
    const evidence = finding.evidence ?? []
    return (
      <div className="dsa-card" style={{ borderLeftColor: '#e8b931' }}>
        <div className="dsa-card-head" onClick={() => setOpen(o => !o)}>
          <span className="dsa-badges">
            <Badge color="#e8b931" label="needs validation" />
          </span>
          <div className="dsa-card-title">{finding.title ?? `Blocked candidate #${props.index + 1}`}</div>
        </div>
        {open && (
          <div className="dsa-card-body">
            {finding.description !== undefined && (
              <Section title="Description" defaultOpen>
                <div className="dsa-text">{finding.description}</div>
              </Section>
            )}
            {finding.claimed_root_cause !== undefined && (
              <Section title="Claimed root cause" defaultOpen>
                <div className="dsa-text">{finding.claimed_root_cause}</div>
              </Section>
            )}
            {trace.length > 0 && (
              <Section title={`Trace (${trace.length} steps)`} defaultOpen>
                <TraceList steps={trace} onOpenFile={props.onOpenFile} />
              </Section>
            )}
            {evidence.length > 0 && (
              <Section title={`Evidence (${evidence.length})`}>
                <EvidenceList items={evidence} onOpenFile={props.onOpenFile} />
              </Section>
            )}
            {(finding.blockers ?? []).length > 0 && (
              <Section title={`Blockers (${(finding.blockers ?? []).length})`} defaultOpen>
                <ul className="dsa-text" style={{ margin: '4px 0 4px 18px', padding: 0 }}>
                  {(finding.blockers ?? []).map((b, i) => <li key={i}>{b}</li>)}
                </ul>
              </Section>
            )}
            {finding.validation_plan !== undefined && (
              <Section title="Validation plan">
                {finding.validation_plan.local !== undefined && (
                  <div className="dsa-text"><b>Local:</b> {finding.validation_plan.local}</div>
                )}
                {finding.validation_plan.deployment !== undefined && (
                  <div className="dsa-text"><b>Deployment:</b> {finding.validation_plan.deployment}</div>
                )}
              </Section>
            )}
          </div>
        )}
      </div>
    )
  }

  if (!isConfirmed(finding)) {
    const trace = finding.trace ?? []
    const evidence = finding.evidence ?? []
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
          {finding.reason !== undefined && (
            <Section title="Rejection reason" defaultOpen>
              <div className="dsa-text">{finding.reason}</div>
            </Section>
          )}
          {finding.description !== undefined && (
            <Section title="Description">
              <div className="dsa-text">{finding.description}</div>
            </Section>
          )}
          {finding.claimed_root_cause !== undefined && (
            <Section title="Claimed root cause">
              <div className="dsa-text">{finding.claimed_root_cause}</div>
            </Section>
          )}
          {trace.length > 0 && (
            <Section title={`Trace (${trace.length} steps)`}>
              <TraceList steps={trace} onOpenFile={props.onOpenFile} />
            </Section>
          )}
          {evidence.length > 0 && (
            <Section title={`Evidence (${evidence.length})`}>
              <EvidenceList items={evidence} onOpenFile={props.onOpenFile} />
            </Section>
          )}
          {finding.reason === undefined && finding.claimed_root_cause === undefined && trace.length === 0 && evidence.length === 0 && (
            <div className="dsa-text">(no reason recorded)</div>
          )}
        </div>
      )}
    </div>
  )
  }

  const severity = asSeverity(finding.severity?.overall_severity)
  const color = SEVERITY_COLORS[severity]
  const trace = finding.trace ?? []
  const evidence = finding.evidence ?? []
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
              <TraceList steps={trace} onOpenFile={props.onOpenFile} />
            </Section>
          )}
          {evidence.length > 0 && (
            <Section title={`Evidence (${evidence.length})`}>
              <EvidenceList items={evidence} onOpenFile={props.onOpenFile} />
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
              {(execution.observed_result ?? execution.expected_result) !== undefined && (
                <div className="dsa-text" style={{ marginTop: 4 }}><b>Observed result:</b> {execution.observed_result ?? execution.expected_result}</div>
              )}
            </Section>
          )}
          {remediation !== undefined && (
            <Section title="Remediation">
              {remediation.strategy !== undefined && <div className="dsa-text">{remediation.strategy}</div>}
              {(remediation.code_changes ?? []).map((c, i) => (
                <div key={i}>
                  {c.file_name !== undefined && <CodeRef file={c.file_name} onOpenFile={props.onOpenFile} />}
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
