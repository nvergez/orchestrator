import { pino, type Logger } from 'pino';
import { LogLevel, type Logger as BoltLogger } from '@slack/bolt';

export type { Logger };

/** Structured JSON on stdout — journald keeps it (spec §10). */
export function createLogger(level: string): Logger {
  return pino({ level });
}

const BOLT_LEVELS: Record<string, LogLevel> = {
  trace: LogLevel.DEBUG,
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  fatal: LogLevel.ERROR,
};

/** Routes Bolt's internal logging through pino so stdout stays pure JSON. */
export function toBoltLogger(logger: Logger): BoltLogger {
  const child = logger.child({ src: 'bolt' });
  const line = (msgs: unknown[]) => msgs.map(String).join(' ');
  return {
    debug: (...msgs) => child.debug(line(msgs)),
    info: (...msgs) => child.info(line(msgs)),
    warn: (...msgs) => child.warn(line(msgs)),
    error: (...msgs) => child.error(line(msgs)),
    setLevel: () => undefined,
    getLevel: () => BOLT_LEVELS[logger.level] ?? LogLevel.INFO,
    setName: () => undefined,
  };
}
