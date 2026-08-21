import pino from 'pino';
import { redact } from './util/redact.js';

const level = process.env.LOG_LEVEL ?? 'info';

export const logger = pino({
  level,
  base: undefined,
  formatters: {
    log(object) {
      return redact(object) as Record<string, unknown>;
    },
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
