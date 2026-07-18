import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Compose class names conditionally (clsx) and resolve
// Tailwind conflicts last-wins (tailwind-merge).
export const cx = (...inputs: ClassValue[]): string =>
  twMerge(clsx(inputs))
