import type { QuotaObservationContext } from '../../services/provider-quota.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChatMessage, Platform } from '@freellmapi/shared/types.js';
import { BaseProvider, type CompletionOptions } from '../../providers/base.js';
import { normalizeReasoningEffort } from '../../lib/sampling-params.js';
import { withKeyProxy } from '../../lib/proxy.js';
import { X_GATEWAY_OAUTH_EXECUTORS, resolveXGatewayProvider, getXGatewayProvider } from './catalog.js';
import { accountModels, accountRow, getProviderModelConfig, resolveXGatewayAccountProxy, updateAccountCredential, type AccountRow } from './store.js';
import { withAccountCredential, resolveAccountCredential, isUnauthorizedError } from './oauth-lifecycle.js';
import { parseOAuthCredential } from './oauth-credentials.js';

export function resolveAccountProvider(account: AccountRow): BaseProvider | undefined {
  const catalog = getXGatewayProvider(account.provider);
  if (catalog?.category === 'oauth' && !X_GATEWAY_OAUTH_EXECUTORS.has(account.provider)) return undefined;
  const providerCfg = getProviderModelConfig(account.provider);
  const delegate = resolveXGatewayProvider(account.provider, account.base_url, providerCfg.customHeaders);
  if (!delegate) return undefined;

  const applyThinkingOptions = (options?: CompletionOptions): CompletionOptions | undefined => {
    if (!providerCfg.thinkingMode || providerCfg.thinkingMode === 'auto') return options;
    if (options?.reasoning_effort !== undefined) return options;
    const effort = normalizeReasoningEffort(providerCfg.thinkingMode);
    if (!effort) return options;
    return { ...options, reasoning_effort: effort };
  };

  // Web-session providers rotate their cookies on use (Gemini Web mints a new
  // `__Secure-1PSIDTS`). Persist the issued value so the next request — and the
  // next process — starts from the live chain instead of the pasted snapshot.
  let expectedCipher = account.encrypted_key;
  const persistRotatedCredential = (next: string): void => {
    try {
      if (updateAccountCredential(account.id, next, expectedCipher)) {
        expectedCipher = accountRow(account.id).encrypted_key;
      }
    } catch {
      // A rotation that cannot be stored must never fail the chat turn: the
      // in-memory session still carries the fresh cookie for this process.
    }
  };
  const withCredentialPersistence = (options?: CompletionOptions): CompletionOptions => ({
    ...(options ?? {}),
    onCredentialUpdate: options?.onCredentialUpdate ?? persistRotatedCredential,
  });

  class AccountProvider extends BaseProvider {
    readonly platform: Platform = delegate!.platform;
    readonly name = delegate!.name;
    override get supportsKeyValidation() { return delegate!.supportsKeyValidation; }
    private run<T>(fn: (credential: string) => Promise<T>): Promise<T> {
      return withKeyProxy(resolveXGatewayAccountProxy(account), () => withAccountCredential(account, fn));
    }
    override chatCompletion(_credential: string, messages: ChatMessage[], model: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext) {
      const effectiveOptions = withCredentialPersistence(applyThinkingOptions(options));
      return this.run(credential => {
        effectiveOptions.signal?.throwIfAborted();
        return delegate!.chatCompletion(credential, messages, model, effectiveOptions, quotaContext);
      });
    }
    override streamChatCompletion(_credential: string, messages: ChatMessage[], model: string, options?: CompletionOptions, quotaContext?: QuotaObservationContext) {
      // Capture the quota observer/proxy context before returning a lazy generator.
      const context = AsyncLocalStorage.snapshot();
      const proxy = resolveXGatewayAccountProxy(account);
      const step = <T>(fn: () => T): T => context(() => withKeyProxy(proxy, fn));
      const effectiveOptions = withCredentialPersistence(applyThinkingOptions(options));
      return (async function*() {
        let credential = await step(() => resolveAccountCredential(account));
        effectiveOptions.signal?.throwIfAborted();
        let iterator = delegate!.streamChatCompletion(credential, messages, model, effectiveOptions, quotaContext);
        try {
          let first;
          try { first = await step(() => iterator.next()); }
          catch (error) {
            await iterator.return(undefined).catch(() => {});
            if (!isUnauthorizedError(error) || !parseOAuthCredential(credential) || effectiveOptions?.signal?.aborted) throw error;
            const next = await step(() => resolveAccountCredential(account, { forceRefresh: true }));
            if (next === credential) throw error;
            credential = next;
            iterator = delegate!.streamChatCompletion(credential, messages, model, effectiveOptions, quotaContext);
            first = await step(() => iterator.next());
          }
          if (!first.done) yield first.value;
          while (!first.done) {
            effectiveOptions?.signal?.throwIfAborted();
            first = await step(() => iterator.next());
            if (!first.done) yield first.value;
          }
        } finally { await step(() => iterator.return(undefined)).catch(() => {}); }
      })();
    }
    override validateKey(_credential: string, quotaContext?: QuotaObservationContext) { return this.run(async credential => {
      if (delegate!.supportsKeyValidation) {
        return delegate!.validateKey(credential, quotaContext);
      }
      const model = accountModels(account)[0]?.id;
      if (!model) throw new Error('Configure an eligible model before testing this account.');
      const result = await delegate!.chatCompletion(
        credential,
        [{ role: 'user', content: 'Reply OK.' }],
        model,
        withCredentialPersistence({ max_tokens: 8, timeoutMs: 20_000 }),
      );
      return result.choices.length > 0;
    }); }
  }
  return new AccountProvider();
}
