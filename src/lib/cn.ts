import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes so a caller's override actually wins over a component default. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))
