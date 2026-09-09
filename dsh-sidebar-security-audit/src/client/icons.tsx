/**
 * Tab / UI icons: inline SVGs sized by the sidebar (no icon dependency).
 */
import { createElement } from 'react'

export interface IconProps {
  size?: number
}

export function ShieldIcon(props: IconProps) {
  const size = props.size ?? 16
  return createElement(
    'svg',
    {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const, 'aria-hidden': true,
    },
    createElement('path', { d: 'M12 3l7 3v5c0 4.5-2.9 8.4-7 10-4.1-1.6-7-5.5-7-10V6l7-3z' }),
    createElement('path', { d: 'M9.2 12.2l1.9 1.9 3.7-4' }),
  )
}
