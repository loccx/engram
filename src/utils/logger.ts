import pinoImport from 'pino'
import type { Logger } from 'pino'

// Handle pino's dual CJS/ESM export patterns
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoFn: (...args: unknown[]) => Logger = (pinoImport as any).default ?? pinoImport

export const logger: Logger = pinoFn({
  level: process.env.LOG_LEVEL ?? 'info',
})
