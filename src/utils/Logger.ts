export class Logger {
  private static formatMessage(level: string, message: string): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}`;
  }

  info(message: string): void {
    Logger.info(message);
  }

  warn(message: string): void {
    Logger.warn(message);
  }

  error(message: string): void {
    Logger.error(message);
  }

  debug(message: string): void {
    Logger.debug(message);
  }

  static info(message: string): void {
    console.log(this.formatMessage('INFO', message));
  }

  static warn(message: string): void {
    console.warn(this.formatMessage('WARN', message));
  }

  static error(message: string): void {
    console.error(this.formatMessage('ERROR', message));
  }

  static debug(message: string): void {
    console.log(this.formatMessage('DEBUG', message));
  }
}
