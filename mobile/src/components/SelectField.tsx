import { ChangeEvent, ReactNode } from 'react'
import { mergeClasses } from '@/lib/merge-classes'

interface SelectFieldProps {
  id: string
  label: string
  value: string | number
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void
  children: ReactNode
  className?: string
}

/**
 * Labelled native `<select>` styled with the upstream design tokens.
 *
 * Deliberately not upstream's `Dropdown`: on a touch device the native control opens the OS
 * picker (bigger targets, native scroll/haptics, works with TalkBack out of the box), which a
 * custom listbox would have to reimplement. The chrome matches so it still reads as one system.
 */
export default function SelectField({ id, label, value, onChange, children, className }: SelectFieldProps) {
  return (
    <div className={mergeClasses('flex items-center justify-between gap-3 py-2', className)}>
      <label htmlFor={id} className="text-foreground text-sm">
        {label}
      </label>
      <div className="relative shrink-0">
        <select
          id={id}
          value={value}
          onChange={onChange}
          className="bg-primary border-border text-foreground focus-visible:outline-foreground-muted h-9 appearance-none rounded-md border py-1 ps-3 pe-8 text-sm focus-visible:outline-1"
        >
          {children}
        </select>
        <span className="material-symbols text-foreground-subdued pointer-events-none absolute end-1.5 top-1/2 -translate-y-1/2 text-lg" aria-hidden="true">
          expand_more
        </span>
      </div>
    </div>
  )
}
