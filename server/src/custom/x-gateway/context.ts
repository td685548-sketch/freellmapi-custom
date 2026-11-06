import { AsyncLocalStorage } from 'node:async_hooks';

export interface XGatewayScope {
  gateway: 'x';
  combo?: string;
  outputSavers: string[];
  inputSaver: string;
  inputTokensSaved: number;
}

const storage = new AsyncLocalStorage<XGatewayScope>();

export function runInGatewayScope<T>(scope: XGatewayScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function getGatewayScope(): XGatewayScope | undefined {
  return storage.getStore();
}
