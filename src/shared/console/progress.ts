import readline from 'node:readline';
import type { ProgressReporter } from '../../domain/ports';

function buildProgressBar(current: number, total: number, width = 24): string {
  if (total <= 0) {
    return `[${'-'.repeat(width)}] 0% (0/0)`;
  }

  const ratio = Math.max(0, Math.min(1, current / total));
  const filledWidth = Math.round(ratio * width);
  const bar = `${'#'.repeat(filledWidth)}${'-'.repeat(width - filledWidth)}`;
  const percent = Math.round(ratio * 100);

  return `[${bar}] ${percent}% (${current}/${total})`;
}

export function createProgressLogger(total: number): ProgressReporter {
  const baseLog = console.log.bind(console);
  const baseError = console.error.bind(console);
  const interactive = Boolean(process.stdout.isTTY || process.env.TERM_PROGRAM === 'vscode');
  let current = 0;
  let visible = false;
  let installed = false;

  function render(): void {
    if (!interactive || total <= 0) {
      return;
    }

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`Progression: ${buildProgressBar(current, total)}`);
    visible = true;
  }

  function clear(): void {
    if (!interactive || !visible) {
      return;
    }

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    visible = false;
  }

  function write(fn: (...args: unknown[]) => void, args: unknown[]): void {
    clear();
    fn(...args);
    render();
  }

  function patchedLog(...args: unknown[]): void {
    write(baseLog, args);
  }

  function patchedError(...args: unknown[]): void {
    write(baseError, args);
  }

  return {
    update: (nextCurrent: number) => {
      current = nextCurrent;
      if (interactive) {
        render();
      } else if (total > 0) {
        baseLog(`Progression: ${buildProgressBar(current, total)}`);
      }
    },
    clear,
    install: () => {
      if (installed) {
        return;
      }

      console.log = patchedLog;
      console.error = patchedError;
      installed = true;
    },
    restore: () => {
      if (!installed) {
        return;
      }

      console.log = baseLog;
      console.error = baseError;
      installed = false;
    },
  };
}
