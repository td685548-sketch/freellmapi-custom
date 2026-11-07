import { describe, expect, it } from 'vitest';
import {
  getConsoleLogs,
  clearConsoleLogs,
  getConsoleEmitter,
  initConsoleLogCapture,
} from '../../custom/x-gateway/console-stream-router.js';

describe('Console Stream Router & Logger', () => {
  it('ensures console log capture is initialized', () => {
    initConsoleLogCapture();
    expect(getConsoleLogs()).toBeDefined();
    expect(Array.isArray(getConsoleLogs())).toBe(true);
  });

  it('captures console.log and appends formatted lines', async () => {
    clearConsoleLogs();
    const testMessage = `Test console log message ${Date.now()}`;
    console.log(testMessage);

    // Give a brief tick for buffer append
    await new Promise((r) => setTimeout(r, 20));

    const logs = getConsoleLogs();
    expect(logs.some((line) => line.includes(testMessage))).toBe(true);
    expect(logs.some((line) => line.includes('[LOG]'))).toBe(true);
  });

  it('captures console.warn, console.error, and console.info with level tags', async () => {
    clearConsoleLogs();
    console.info('Test info message');
    console.warn('Test warning message');
    console.error('Test error message');

    await new Promise((r) => setTimeout(r, 20));

    const logs = getConsoleLogs();
    expect(logs.some((line) => line.includes('[INFO]') && line.includes('Test info message'))).toBe(true);
    expect(logs.some((line) => line.includes('[WARN]') && line.includes('Test warning message'))).toBe(true);
    expect(logs.some((line) => line.includes('[ERROR]') && line.includes('Test error message'))).toBe(true);
  });

  it('emits clear event and resets buffer on clearConsoleLogs', () => {
    let clearEmitted = false;
    const emitter = getConsoleEmitter();
    const handler = () => {
      clearEmitted = true;
    };
    emitter.once('clear', handler);

    console.log('Log to be cleared');
    clearConsoleLogs();

    expect(clearEmitted).toBe(true);
    expect(getConsoleLogs().length).toBe(0);
  });
});
