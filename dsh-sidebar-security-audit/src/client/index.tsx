/**
 * Client half of dsh-sidebar-security-audit: registers the "Security Audit"
 * sidebar tab through the dsh-better-sidebar service. The tab component is
 * the panel; data comes from this plugin's own fenced host routes.
 * @module dsh-sidebar-security-audit/client
 */
import { createElement, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Triggers the ctx.betterSidebar type augmentation (erased at build).
import type {} from 'dsh-better-sidebar'
import { AuditPanel } from './AuditPanel.tsx'
import { ShieldIcon } from './icons.tsx'

/** Services required before mounting. */
export const inject = ['betterSidebar']

/** Plugin body. */
export function apply(ctx: Context): void {
  ctx.effect(() =>
    ctx.betterSidebar.registerTab({
      id: 'security-audit:panel',
      title: () => 'Security Audit',
      icon: (size: number): ReactNode => createElement(ShieldIcon, { size }),
      order: 45,
      single: true,
      component: (props): ReactNode => createElement(AuditPanel, { ...props, service: ctx.betterSidebar }),
    }),
    'dsh-sidebar-security-audit: tab',
  )
}
