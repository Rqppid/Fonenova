import * as React from 'react'
import { cn } from '@/lib/utils'

type Variant = 'default' | 'ghost' | 'outline' | 'primary'
type Size = 'sm' | 'md' | 'icon'

const variants: Record<Variant, string> = {
  default: 'bg-surface border border-line text-ink hover:bg-subtle hover:border-line-strong',
  outline: 'border border-line text-ink-2 hover:text-ink hover:bg-subtle',
  ghost: 'text-ink-2 hover:text-ink hover:bg-black/[0.04]',
  primary: 'bg-navy text-white hover:bg-navy-2',
}
const sizes: Record<Size, string> = {
  // Phone-sized below 640px (44px tall), the original desktop sizes from there up.
  sm: 'h-11 px-3.5 text-[14px] gap-1.5 sm:h-8 sm:px-2.5 sm:text-[13px]',
  md: 'h-11 px-3.5 text-sm gap-2 sm:h-9 sm:px-3',
  icon: 'h-11 w-11 justify-center sm:h-8 sm:w-8',
}

export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(
  ({ className, variant = 'default', size = 'md', type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
)
Button.displayName = 'Button'
