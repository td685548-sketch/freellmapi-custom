// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSupportRuntimeWidgetScript } from '../../custom/x-gateway/support-runtime-widget.js';

declare global {
  interface Window {
    FreeLLMAPISupport?: any;
  }
}

describe('AI Support Runtime Widget (support-runtime-widget.ts)', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as { FreeLLMAPISupport?: unknown }).FreeLLMAPISupport;
    try {
      window.sessionStorage.clear();
    } catch (_e) {}

    originalFetch = globalThis.fetch;
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if ((window as unknown as { FreeLLMAPISupport?: { _instance?: { destroy: () => void } } }).FreeLLMAPISupport?._instance) {
      (window as unknown as { FreeLLMAPISupport: { _instance: { destroy: () => void } } }).FreeLLMAPISupport._instance.destroy();
    }
    document.body.innerHTML = '';
    delete (window as unknown as { FreeLLMAPISupport?: unknown }).FreeLLMAPISupport;
  });

  function loadWidgetScript(scriptSrc?: string) {
    if (scriptSrc) {
      const script = document.createElement('script');
      script.src = scriptSrc;
      document.head.appendChild(script);
      Object.defineProperty(document, 'currentScript', {
        value: script,
        configurable: true
      });
    } else {
      Object.defineProperty(document, 'currentScript', {
        value: null,
        configurable: true
      });
    }

    const code = getSupportRuntimeWidgetScript();
    const fn = new Function('window', 'document', code);
    fn(window, document);
  }

  it('determines server base from currentScript.src and does not call embedding site origin', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    expect(window.FreeLLMAPISupport).toBeDefined();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Hello from remote gateway!',
        runtime: { conversationId: 'conv-remote-1' }
      })
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_remote_key',
      contextToken: 'signed_remote_tok'
    });

    expect(instance).toBeDefined();

    instance?.sendMessage('Test remote base');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const [callUrl, callInit] = mockFetch.mock.calls[0];
    expect(callUrl).toBe('https://remote-gateway.example.com/thruline/v1/support/chat');
    expect(JSON.parse(callInit.body)).toMatchObject({
      tenantKey: 'tenant_remote_key',
      contextToken: 'signed_remote_tok',
      messages: [{ role: 'user', content: 'Test remote base' }]
    });
  });

  it('honors explicit serverBase configuration over currentScript', async () => {
    loadWidgetScript('https://script-origin.example.com/thruline/v1/support/widget.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Hello from explicit base',
        runtime: { conversationId: 'conv-explicit-1' }
      })
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_explicit',
      contextToken: 'signed_token_exp',
      serverBase: 'https://override-gateway.example.com'
    });

    instance?.sendMessage('Testing override');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const [callUrl] = mockFetch.mock.calls[0];
    expect(callUrl).toBe('https://override-gateway.example.com/thruline/v1/support/chat');
  });

  it('restores conversation from server via authorized GET before render', async () => {
    loadWidgetScript();

    // First interaction creates conversation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'First reply',
        runtime: { conversationId: 'conv-saved-99' }
      })
    });

    const instance1 = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_test',
      contextToken: 'user_token_abc',
      serverBase: 'https://api.test'
    });

    instance1?.sendMessage('First message');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    instance1?.destroy();

    // Reload with stored conversation
    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        conversation: {
          id: 'conv-saved-99',
          status: 'active',
          messages: [
            { id: 'msg-1', role: 'user', content: 'Existing user question' },
            { id: 'msg-2', role: 'assistant', content: 'Authoritative server reply' }
          ]
        }
      })
    });

    const reloaded = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_test',
      contextToken: 'user_token_abc',
      serverBase: 'https://api.test'
    });

    expect(reloaded).toBeDefined();

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [getUrl] = mockFetch.mock.calls[0];
    expect(getUrl).toContain('/thruline/v1/support/conversations/conv-saved-99');

    // Wait for authoritative messages to render in DOM
    await vi.waitFor(() => {
      const msgs = document.querySelectorAll('.freellmapi-message');
      expect(msgs.length).toBe(2);
      expect(msgs[0].textContent).toContain('Existing user question');
      expect(msgs[1].textContent).toContain('Authoritative server reply');
    });
  });

  it('clears stored conversation when server returns 404/403 and does not render stale history', async () => {
    loadWidgetScript();

    // Create a stored conversation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Initial message',
        runtime: { conversationId: 'stale-conv-id' }
      })
    });

    const inst1 = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_stale',
      contextToken: 'tok_stale',
      serverBase: 'https://api.test'
    });
    inst1?.sendMessage('hello');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    inst1?.destroy();

    // Reload with 403 forbidden on resume GET
    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: 'ownership_denied' } })
    });

    const _inst2 = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_stale',
      contextToken: 'tok_stale',
      serverBase: 'https://api.test'
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const msgs = document.querySelectorAll('.freellmapi-message');
    expect(msgs.length).toBe(0);
  });

  it('triggers onAuthRequired and displays auth UI on 401 without silently downgrading to guest', async () => {
    loadWidgetScript();

    const onAuthRequired = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: { code: 'invalid_context_token' } })
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_signed',
      contextToken: 'expired_jwt_token',
      onAuthRequired
    });

    instance?.sendMessage('User message with expired token');

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(onAuthRequired).toHaveBeenCalledWith('token_expired'));

    const banner = document.querySelector('[data-testid="widget-banner"]');
    expect(banner?.textContent).toContain('Authentication required');

    const sendBtn = document.querySelector<HTMLButtonElement>('[data-testid="widget-send-btn"]');
    expect(sendBtn?.disabled).toBe(true);

    const calls = mockFetch.mock.calls.map(c => c[0]);
    expect(calls.some(url => url.includes('/guest-session'))).toBe(false);
  });

  it('updateContextToken clears old messages, aborts pending requests, and isolates identity', async () => {
    loadWidgetScript();

    let resolveUserA!: (val: unknown) => void;
    mockFetch.mockReturnValueOnce(
      new Promise(r => {
        resolveUserA = r;
      })
    );

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_switch',
      contextToken: 'token_user_a'
    });

    instance?.sendMessage('Secret message of User A');
    expect(document.querySelector('.freellmapi-message')?.textContent).toContain('Secret message of User A');

    // Switch to User B
    instance?.updateContextToken('token_user_b');

    // DOM must be cleared immediately
    expect(document.querySelectorAll('.freellmapi-message').length).toBe(0);

    // Late response for User A arrives after switch
    resolveUserA({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Sensitive response for User A',
        runtime: { conversationId: 'conv-a' }
      })
    });

    await new Promise(r => setTimeout(r, 30));

    // DOM still has NO messages
    expect(document.querySelectorAll('.freellmapi-message').length).toBe(0);
  });

  it('renders malicious strings safely via textContent without XSS injection', async () => {
    loadWidgetScript();

    const maliciousTitle = '<script>window.pwned=1</script><img src="x" onerror="window.imgPwned=1"/>';
    const maliciousUserText = '<script>window.msgPwned=1</script><b>Bold Text</b>';
    const maliciousReply = '<iframe src="javascript:alert(1)"></iframe>';

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: maliciousReply,
        runtime: { conversationId: 'conv-xss' }
      })
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_safe',
      contextToken: 'tok_safe_test',
      title: maliciousTitle
    });

    const titleEl = document.querySelector('[data-testid="widget-title"]');
    expect(titleEl?.textContent).toBe(maliciousTitle);
    expect(document.querySelector('script[src*="pwned"], img[src="x"]')).toBeNull();

    instance?.sendMessage(maliciousUserText);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    expect((window as unknown as { pwned?: number; imgPwned?: number; msgPwned?: number }).pwned).toBeUndefined();
    expect((window as unknown as { pwned?: number; imgPwned?: number; msgPwned?: number }).imgPwned).toBeUndefined();
    expect((window as unknown as { pwned?: number; imgPwned?: number; msgPwned?: number }).msgPwned).toBeUndefined();
    expect(document.querySelector('iframe')).toBeNull();

    const msgs = document.querySelectorAll('.freellmapi-message');
    expect(msgs[0].textContent).toBe(maliciousUserText);
    expect(msgs[1].textContent).toBe(maliciousReply);
  });

  it('preserves stable requestId on retry and prevents duplicate sends', async () => {
    loadWidgetScript();

    // First attempt fails
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_retry',
      contextToken: 'tok_retry_test'
    });

    instance?.sendMessage('Unstable connection text');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const firstRequestId = firstBody.requestId;
    expect(firstRequestId).toBeTruthy();

    const retryBtn = document.querySelector<HTMLButtonElement>('[data-testid="widget-retry-btn"]');
    expect(retryBtn).toBeTruthy();

    // Second attempt succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Success after retry',
        runtime: { conversationId: 'conv-retry-1', replayed: false }
      })
    });

    retryBtn?.click();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(secondBody.requestId).toBe(firstRequestId);
    expect(secondBody.messages[0].content).toBe('Unstable connection text');
  });

  it('handles escalation, displays pending approvals, polls staff replies, and submits CSAT', async () => {
    loadWidgetScript();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'AI reply before escalation',
        runtime: {
          conversationId: 'conv-esc-1',
          pendingActions: [
            { id: 'act-1', toolName: 'refund_customer', executionStatus: 'pending' }
          ]
        }
      })
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_esc',
      contextToken: 'tok_esc_test',
      pollInterval: 50
    });

    instance?.open();
    instance?.sendMessage('Please refund my order');

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Pending action displayed
    const pendingAction = document.querySelector('[data-testid="widget-pending-action"]');
    expect(pendingAction?.textContent).toContain('refund_customer');

    // Escalate to human agent
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, conversationId: 'conv-esc-1', status: 'escalated' })
    });

    const escalateBtn = document.querySelector<HTMLButtonElement>('[data-testid="widget-escalate-btn"]');
    escalateBtn?.click();

    await vi.waitFor(() => {
      const banner = document.querySelector('[data-testid="widget-banner"]');
      expect(banner?.textContent).toContain('Transferred to a human agent');
    });

    const [escUrl] = mockFetch.mock.calls[1];
    expect(escUrl).toContain('/thruline/v1/support/escalate');

    // Staff replies via conversation poll
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        conversation: {
          id: 'conv-esc-1',
          status: 'resolved',
          messages: [
            { id: 'm-staff-1', senderType: 'staff', senderName: 'Agent Dave', content: 'Refund processed manually.' }
          ]
        }
      })
    });

    await vi.waitFor(() => {
      const staffMsg = document.querySelector('.freellmapi-message-staff');
      expect(staffMsg?.textContent).toContain('Refund processed manually.');
      expect(staffMsg?.textContent).toContain('Agent Dave');
    }, { timeout: 7000 });

    // CSAT prompt should now appear because conversation status is 'resolved'
    const csatBtn5 = document.querySelector<HTMLButtonElement>('[data-testid="widget-csat-btn-5"]');
    expect(csatBtn5).toBeTruthy();

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true })
    });

    csatBtn5?.click();
    await vi.waitFor(() => {
      const csatContainer = document.querySelector('[data-testid="widget-csat-container"]');
      expect(csatContainer?.textContent).toContain('Thank you for your feedback!');
    });

    const [csatUrl, csatInit] = mockFetch.mock.calls[3];
    expect(csatUrl).toContain('/thruline/v1/support/csat');
    expect(JSON.parse(csatInit.body)).toMatchObject({ conversationId: 'conv-esc-1', score: 5 });

    instance?.destroy();
  });

  it('renews guest session using POST /guest-session when no contextToken provided', async () => {
    loadWidgetScript();

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          contextToken: 'guest_token_xyz',
          expiresIn: 900
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          reply: 'Hello Guest!',
          runtime: { conversationId: 'conv-guest-1' }
        })
      });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_guest_allowed',
      allowGuestSession: true
    });

    instance?.sendMessage('Hi, I am guest');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    const [guestUrl, guestInit] = mockFetch.mock.calls[0];
    expect(guestUrl).toContain('/thruline/v1/support/guest-session');
    expect(JSON.parse(guestInit.body)).toMatchObject({ tenantKey: 'tenant_guest_allowed' });

    const [chatUrl, chatInit] = mockFetch.mock.calls[1];
    expect(chatUrl).toContain('/thruline/v1/support/chat');
    expect(chatInit.headers['X-Support-Context-Token']).toBe('guest_token_xyz');
  });

  it('destroys widget cleanly, removing DOM and aborting polling', () => {
    loadWidgetScript();

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_cleanup'
    });

    expect(document.getElementById('freellmapi-support-widget-root')).toBeTruthy();

    instance?.destroy();

    expect(document.getElementById('freellmapi-support-widget-root')).toBeNull();
    expect(window.FreeLLMAPISupport._instance).toBeNull();
  });
  it('restores the guest credential and renders actual human/AI sender types after reload', async () => {
    loadWidgetScript();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ contextToken: 'guest-saved-token', expiresIn: 900 }) });
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ reply: 'Saved reply', runtime: { conversationId: 'conv-guest-saved' } }) });
    const first = window.FreeLLMAPISupport.init({ tenantKey: 'guest-reload', serverBase: 'https://api.test', allowGuestSession: true });
    first.sendMessage('Hello');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Saved reply'));
    first.destroy();
    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ conversation: { id: 'conv-guest-saved', status: 'escalated', messages: [
      { id: 'human1', senderType: 'human_agent', senderName: 'Agent Jane', content: 'Human answer' },
      { id: 'ai1', senderType: 'ai_assistant', content: 'AI answer' },
    ] } }) });
    window.FreeLLMAPISupport.init({ tenantKey: 'guest-reload', serverBase: 'https://api.test', allowGuestSession: true });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Human answer'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toContain('/conversations/conv-guest-saved');
    expect(mockFetch.mock.calls[0][1].headers['X-Support-Context-Token']).toBe('guest-saved-token');
    const messages = document.querySelectorAll('.freellmapi-message');
    expect(messages[0].textContent).toContain('Agent Jane');
    expect(messages[1].textContent).toContain('AI answer');
    expect((document.querySelector('input') as HTMLInputElement).disabled).toBe(true);
  });

  it('preserves a deployment base path inferred from the loaded script URL', async () => {
    loadWidgetScript('https://gateway.example.com/prefix/thruline/v1/support/widget.js');
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ reply: 'Path supported' }) });
    const instance = window.FreeLLMAPISupport.init({ tenantKey: 'prefixed', contextToken: 'signed' });
    instance.sendMessage('Hello');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    expect(mockFetch.mock.calls[0][0]).toBe('https://gateway.example.com/prefix/thruline/v1/support/chat');
  });

  it.each(['thruline', 'x'])('keeps the deployment prefix and canonical URLs throughout the %s script lifecycle', async (scriptPrefix) => {
    const apiBase = 'https://gateway.example.com/deployment/thruline/v1/support';
    loadWidgetScript(`https://gateway.example.com/deployment/${scriptPrefix}/v1/support/widget.js`);
    let escalated = false;
    mockFetch.mockImplementation(async (url: string) => {
      expect(url.startsWith(`${apiBase}/`)).toBe(true);
      let data: unknown;
      if (url.endsWith('/guest-session')) {
        data = { contextToken: 'prefixed-guest', expiresIn: 900 };
      } else if (url.endsWith('/chat')) {
        data = { reply: 'Prefixed answer', runtime: { conversationId: 'prefixed-conversation' } };
      } else if (url.endsWith('/escalate')) {
        escalated = true;
        data = { conversationId: 'prefixed-conversation', status: 'escalated' };
      } else if (url.endsWith('/conversations/prefixed-conversation')) {
        data = { conversation: { id: 'prefixed-conversation', status: escalated ? 'resolved' : 'open', messages: [] } };
      } else if (url.endsWith('/csat')) {
        data = { ok: true };
      } else {
        throw new Error(`Unexpected widget endpoint: ${url}`);
      }
      return { ok: true, status: 200, json: async () => data };
    });

    const instance = window.FreeLLMAPISupport.init({ tenantKey: 'prefixed-lifecycle', pollInterval: 10 });
    instance.open();
    instance.sendMessage('Hello');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Prefixed answer'));
    await vi.waitFor(() => expect(mockFetch.mock.calls.some(([url]) => url === `${apiBase}/conversations/prefixed-conversation`)).toBe(true));
    document.querySelector<HTMLButtonElement>('[data-testid="widget-escalate-btn"]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-testid="widget-csat-btn-5"]')).not.toBeNull());
    document.querySelector<HTMLButtonElement>('[data-testid="widget-csat-btn-5"]')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Thank you for your feedback!'));

    for (const endpoint of ['guest-session', 'chat', 'conversations/prefixed-conversation', 'escalate', 'csat']) {
      expect(mockFetch.mock.calls.some(([url]) => url === `${apiBase}/${endpoint}`)).toBe(true);
    }
    const [, chatInit] = mockFetch.mock.calls.find(([url]) => url === `${apiBase}/chat`)!;
    expect(chatInit.headers['X-Support-Context-Token']).toBe('prefixed-guest');
    instance.destroy();
  });

  it('renders verified citations from runtime.evidence with numbered cards and prevents XSS in title and excerpt', async () => {
    loadWidgetScript();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Here is the authorized refund policy [1]',
        runtime: {
          conversationId: 'conv-cite-xss-1',
          replySource: 'model',
          evidence: {
            requestId: 'req_xss_test',
            status: 'cited',
            policyVersion: 1,
            snapshotId: 'snap_xss_1',
            citations: [
              {
                id: 'cit_refund_policy',
                ordinal: 1,
                sourceId: 'src_refund',
                revisionId: 'rev_1',
                chunkId: 'chk_1',
                title: '<img src=x onerror=alert(1)>Refund Policy',
                startLine: 1,
                endLine: 15,
                excerpt: '<script>alert("xss")</script>Eligible for 30-day refund.'
              }
            ]
          }
        }
      })
    });

    const instance = window.FreeLLMAPISupport.init({ tenantKey: 'tenant_citations_xss', contextToken: 'tok_cite' });
    instance.sendMessage('How do refunds work?');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Here is the authorized refund policy [1]'));

    const card = document.querySelector('[data-testid="widget-citation-card"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute('data-citation-id')).toBe('cit_refund_policy');
    expect(card?.getAttribute('data-ordinal')).toBe('1');
    expect(card?.textContent).toContain('[1]');
    expect(card?.textContent).toContain('<img src=x onerror=alert(1)>Refund Policy');
    // Verify no HTML elements were injected
    expect(card?.querySelector('img')).toBeNull();
    const excerptEl = card?.querySelector('[data-testid="widget-citation-excerpt"]');
    expect(excerptEl).toBeTruthy();
    expect(excerptEl?.textContent).toContain('<script>alert("xss")</script>Eligible for 30-day refund.');
    expect(card?.querySelector('script')).toBeNull();
  });

  it('renders knowledge_abstention as localized non-AI status and allows human escalation', async () => {
    loadWidgetScript();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'I do not have sufficient information.',
        runtime: {
          conversationId: 'conv-abstain-1',
          replySource: 'knowledge_abstention',
          evidence: {
            requestId: 'req_abstain_test',
            status: 'abstained',
            reason: 'no_matches',
            policyVersion: 1,
            snapshotId: 'snap_empty',
            citations: []
          }
        }
      })
    });

    const instance = window.FreeLLMAPISupport.init({ tenantKey: 'tenant_abstain', contextToken: 'tok_abstain' });
    instance.sendMessage('Tell me about secret project');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="widget-response-notice"]')).toBeTruthy());

    const notice = document.querySelector('[data-testid="widget-response-notice"]');
    expect(notice?.getAttribute('data-role')).toBe('system-notice');
    expect(notice?.querySelector('[data-testid="widget-non-ai-status"]')?.textContent).toBe('System Notice');
    expect(notice?.textContent).toContain('No relevant knowledge sources were found to answer this question.');
    // It must NOT be labeled as an assistant message
    expect(document.querySelector('.freellmapi-message-assistant')).toBeNull();

    // Verify escalation with the real conversationId
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, conversationId: 'conv-abstain-1' })
    });
    const escalateBtn = document.querySelector('[data-testid="widget-escalate-btn"]') as HTMLButtonElement;
    expect(escalateBtn).toBeTruthy();
    escalateBtn.click();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const [escUrl, escInit] = mockFetch.mock.calls[1];
    expect(escUrl).toContain('/thruline/v1/support/escalate');
    expect(JSON.parse(escInit.body)).toMatchObject({ conversationId: 'conv-abstain-1', reason: 'user_requested' });
  });

  it('rehydrates cited messages and notices from history and deduplicates by requestId across reload and poll', async () => {
    loadWidgetScript();

    // First interaction sets up stored conversation ID
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Initial message',
        runtime: { conversationId: 'conv-dedup-history' }
      })
    });

    const first = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_dedup',
      contextToken: 'tok_dedup',
      serverBase: 'https://api.test'
    });
    first.sendMessage('Initial query');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    first.destroy();

    // Reload with stored conversation containing cited message and notice
    const historyPayload = {
      ok: true,
      conversation: {
        id: 'conv-dedup-history',
        status: 'open',
        messages: [
          {
            id: 'msg_user_1',
            role: 'user',
            content: 'Do you offer warranty?',
            requestId: 'req_warr_1',
            responseNotice: { requestId: 'req_warr_1', reason: 'no_matches' }
          },
          {
            id: 'msg_ai_1',
            role: 'assistant',
            senderType: 'ai_assistant',
            content: 'Yes, 1-year limited warranty [1].',
            requestId: 'req_warr_2',
            evidence: {
              requestId: 'req_warr_2',
              status: 'cited',
              policyVersion: 1,
              snapshotId: 'snap_warr',
              citations: [
                { id: 'cit_warr', ordinal: 1, sourceId: 'src_w', revisionId: 'rev_w', chunkId: 'chk_w', title: 'Warranty Terms', excerpt: '1-year coverage.' }
              ]
            }
          }
        ]
      }
    };

    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => historyPayload
    });

    const reloaded = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_dedup',
      contextToken: 'tok_dedup',
      serverBase: 'https://api.test',
      pollInterval: 50
    });

    await vi.waitFor(() => expect(document.body.textContent).toContain('Warranty Terms'));
    expect(document.querySelectorAll('[data-testid="widget-response-notice"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="widget-citation-card"]').length).toBe(1);

    // Mock poll returning same messages
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => historyPayload
    });

    reloaded.open();
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // Deduplication should ensure no duplicate notices or citation cards
    expect(document.querySelectorAll('[data-testid="widget-response-notice"]').length).toBe(1);
    expect(document.querySelectorAll('[data-testid="widget-citation-card"]').length).toBe(1);
  });

  it('replaces redacted historical messages with localized notice and strips original citation metadata', async () => {
    loadWidgetScript();

    // First interaction sets up stored conversation ID
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Initial message',
        runtime: { conversationId: 'conv-redacted-history' }
      })
    });

    const first = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_redacted',
      contextToken: 'tok_redacted',
      serverBase: 'https://api.test'
    });
    first.sendMessage('Initial query');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    first.destroy();

    // Reload with stored conversation containing redacted message
    mockFetch.mockClear();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        conversation: {
          id: 'conv-redacted-history',
          status: 'open',
          messages: [
            {
              id: 'msg_ai_revoked',
              role: 'assistant',
              senderType: 'ai_assistant',
              content: 'Revoked secret content',
              evidence: {
                requestId: 'req_revoked_1',
                status: 'redacted',
                reason: 'source_revoked',
                policyVersion: 1,
                snapshotId: '',
                citations: []
              }
            }
          ]
        }
      })
    });

    window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_redacted',
      contextToken: 'tok_redacted',
      serverBase: 'https://api.test'
    });

    await vi.waitFor(() => expect(document.querySelector('[data-testid="widget-response-notice"]')).toBeTruthy());
    const notice = document.querySelector('[data-testid="widget-response-notice"]');
    expect(notice?.textContent).toContain('This response referenced sources that have been revoked or are no longer available.');
    // Ensure no citations or raw assistant text leaked
    expect(document.querySelectorAll('[data-testid="widget-citation-card"]').length).toBe(0);
    expect(document.body.textContent).not.toContain('Revoked secret content');
  });

  it('handles 409 knowledge_context_changed with explicit fresh requestId retry versus stable requestId on network retry', async () => {
    loadWidgetScript();

    // 1. First send returns 409 knowledge_context_changed
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: { code: 'knowledge_context_changed', message: 'Sources were updated in flight' },
        requestId: 'req_stale_1'
      })
    });

    const instance = window.FreeLLMAPISupport.init({ tenantKey: 'tenant_retry_test', contextToken: 'tok_retry' });
    instance.sendMessage('Check product specs');

    await vi.waitFor(() => expect(document.querySelector('[data-testid="widget-context-changed-box"]')).toBeTruthy());
    expect(document.querySelector('[data-testid="widget-context-changed-box"]')?.textContent).toContain('Knowledge context changed. Click to retry with a fresh request.');

    const firstReqBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const firstReqId = firstReqBody.requestId;
    expect(firstReqId).toBeDefined();

    // 2. Click fresh retry: should generate a FRESH requestId
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ reply: 'Fresh product specs answer', runtime: { conversationId: 'conv-fresh-1' } })
    });

    const freshRetryBtn = document.querySelector('[data-testid="widget-fresh-retry-btn"]') as HTMLButtonElement;
    expect(freshRetryBtn).toBeTruthy();
    freshRetryBtn.click();

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
    const secondReqBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    const secondReqId = secondReqBody.requestId;
    expect(secondReqId).toBeDefined();
    expect(secondReqId).not.toBe(firstReqId); // MUST be a fresh request ID!

    // 3. In contrast, ordinary network error retry keeps same requestId
    mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    instance.sendMessage('Ordinary network failure test');

    await vi.waitFor(() => expect(document.querySelector('[data-testid="widget-error-box"]')).toBeTruthy());
    const thirdReqBody = JSON.parse(mockFetch.mock.calls[2][1].body);
    const thirdReqId = thirdReqBody.requestId;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ reply: 'Recovered from network error' })
    });

    const ordinaryRetryBtn = document.querySelector('[data-testid="widget-retry-btn"]') as HTMLButtonElement;
    expect(ordinaryRetryBtn).toBeTruthy();
    ordinaryRetryBtn.click();

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(4));
    const fourthReqBody = JSON.parse(mockFetch.mock.calls[3][1].body);
    const fourthReqId = fourthReqBody.requestId;
    expect(fourthReqId).toBe(thirdReqId); // Network retry preserves the exact same requestId
  });

  it('clears citation and notice state and isolates identity on updateContextToken and destroy', async () => {
    loadWidgetScript();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Verified answer [1]',
        runtime: {
          conversationId: 'conv-ident-1',
          evidence: {
            requestId: 'req_ident_1',
            status: 'cited',
            policyVersion: 1,
            snapshotId: 'snap_ident',
            citations: [{ id: 'c_ident', ordinal: 1, sourceId: 's', revisionId: 'r', chunkId: 'k', title: 'Ident Source', excerpt: 'Excerpt' }]
          }
        }
      })
    });

    const instance = window.FreeLLMAPISupport.init({ tenantKey: 'tenant_ident', contextToken: 'tok_user_A' });
    instance.sendMessage('Hello user A');
    await vi.waitFor(() => expect(document.querySelector('[data-testid="widget-citation-card"]')).toBeTruthy());

    // Switch to User B identity
    instance.updateContextToken('tok_user_B');

    // All citations and messages must be wiped
    expect(document.querySelector('[data-testid="widget-citation-card"]')).toBeNull();
    expect(document.querySelectorAll('.freellmapi-message').length).toBe(0);

    // Destroy cleans up DOM completely
    instance.destroy();
    expect(document.getElementById('freellmapi-support-widget-root')).toBeNull();
  });

  it('localizes notices and UI strings in Vietnamese when locale is vi', async () => {
    loadWidgetScript();
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Không đủ thông tin.',
        runtime: {
          conversationId: 'conv-vi-1',
          replySource: 'knowledge_abstention',
          evidence: {
            requestId: 'req_vi_1',
            status: 'abstained',
            reason: 'no_matches',
            policyVersion: 1,
            snapshotId: 'snap_vi',
            citations: []
          }
        }
      })
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_vi',
      contextToken: 'tok_vi',
      locale: 'vi'
    });
    instance.sendMessage('Hỏi chính sách');

    await vi.waitFor(() => expect(document.querySelector('[data-testid="widget-response-notice"]')).toBeTruthy());
    const notice = document.querySelector('[data-testid="widget-response-notice"]');
    expect(notice?.textContent).toContain('Không tìm thấy tài liệu phù hợp để trả lời câu hỏi này');
    expect(notice?.querySelector('[data-testid="widget-non-ai-status"]')?.textContent).toBe('Thông báo hệ thống');
  });

  it('updates rendered cited response to revocation notice when subsequent polls return redacted on the same instance', async () => {
    loadWidgetScript();

    let pollCount = 0;
    let shouldRedact = false;
    const testConvId = 'conv-redact-regression-1';
    let userRequestId = '';

    mockFetch.mockImplementation(async (url: string, init?: any) => {
      // 1. Initial chat send
      if (typeof url === 'string' && url.includes('/thruline/v1/support/chat')) {
        const parsedBody = JSON.parse(init.body);
        userRequestId = parsedBody.requestId;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            reply: 'Confidential knowledge answer that will be revoked',
            runtime: {
              conversationId: testConvId,
              evidence: {
                requestId: userRequestId,
                status: 'cited',
                policyVersion: 1,
                snapshotId: 'snap_v1',
                citations: [
                  {
                    id: 'cite_secret_doc',
                    ordinal: 1,
                    sourceId: 'src_sec_1',
                    revisionId: 'rev_sec_1',
                    chunkId: 'chk_1',
                    title: 'Secret Internal Handbook',
                    excerpt: 'Confidential policy details.'
                  }
                ]
              }
            }
          })
        };
      }

      // 2. Poll requests for conversation
      if (typeof url === 'string' && url.includes(`/thruline/v1/support/conversations/${testConvId}`)) {
        pollCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            conversation: {
              id: testConvId,
              status: 'active',
              messages: [
                {
                  id: 'msg_user_1',
                  role: 'user',
                  senderType: 'user',
                  content: 'What is the secret policy?',
                  requestId: userRequestId
                },
                {
                  id: 'msg_asst_1',
                  role: 'assistant',
                  senderType: 'ai_assistant',
                  content: 'Confidential knowledge answer that will be revoked',
                  requestId: userRequestId,
                  evidence: shouldRedact ? {
                    requestId: userRequestId,
                    status: 'redacted',
                    reason: 'source_revoked',
                    policyVersion: 2,
                    snapshotId: 'snap_v2',
                    citations: []
                  } : {
                    requestId: userRequestId,
                    status: 'cited',
                    policyVersion: 1,
                    snapshotId: 'snap_v1',
                    citations: [
                      {
                        id: 'cite_secret_doc',
                        ordinal: 1,
                        sourceId: 'src_sec_1',
                        revisionId: 'rev_sec_1',
                        chunkId: 'chk_1',
                        title: 'Secret Internal Handbook',
                        excerpt: 'Confidential policy details.'
                      }
                    ]
                  }
                }
              ]
            }
          })
        };
      }

      return { ok: false, status: 404, json: async () => ({}) };
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_redact_test',
      contextToken: 'tok_redact_test',
      pollInterval: 25
    });
    instance.open();

    // Send question
    instance.sendMessage('What is the secret policy?');

    // Wait until cited reply and citation card are rendered
    await vi.waitFor(() => {
      const citeCard = document.querySelector('[data-testid="widget-citation-card"]');
      expect(citeCard).toBeTruthy();
      expect(citeCard?.textContent).toContain('Secret Internal Handbook');
      expect(citeCard?.textContent).toContain('Confidential policy details.');
      expect(document.body.textContent).toContain('Confidential knowledge answer that will be revoked');
    });

    // Now trigger redaction in subsequent polls
    shouldRedact = true;
    pollCount = 0;

    // Wait for at least 7 polls to execute with redacted status on the SAME instance
    await vi.waitFor(() => {
      expect(pollCount).toBeGreaterThanOrEqual(7);
    }, { timeout: 4000 });

    // Assert that:
    // 1. The original answer text is completely removed from the DOM
    expect(document.body.textContent).not.toContain('Confidential knowledge answer that will be revoked');

    // 2. All citation cards, source titles, and excerpts are completely removed from the DOM
    expect(document.querySelectorAll('[data-testid="widget-citation-card"]').length).toBe(0);
    expect(document.body.textContent).not.toContain('Secret Internal Handbook');
    expect(document.body.textContent).not.toContain('Confidential policy details.');

    // 3. Exactly 1 localized revocation notice is displayed (no duplicates from 7 polls)
    const notices = document.querySelectorAll('[data-testid="widget-response-notice"]');
    expect(notices.length).toBe(1);
    expect(notices[0].textContent).toContain('referenced sources that have been revoked');
    expect(notices[0].querySelector('[data-testid="widget-non-ai-status"]')?.textContent).toBe('System Notice');
  });

  it('default init has no added config fetch and preserves 017/018 behavior', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_default_off',
      contextToken: 'signed_tok_1'
    });

    expect(instance).toBeDefined();
    // Verify no fetch was called for /thruline/v1/support/widget/config
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('opt-in loadTenantProfile: true fetches /thruline/v1/support/widget/config and applies branding', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: {
          version: 2,
          enabled: true,
          appearance: {
            primaryColor: '#10b981',
            title: 'Acme Branded Support',
            welcomeMessage: 'Welcome to Acme Support! How can we help?',
            position: 'bottom-left',
            quickPrompts: ['Check refund status', 'Shipping fees']
          },
          intake: {
            required: false,
            fields: []
          }
        }
      })
    });

    window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_branded_1',
      contextToken: 'signed_tok_2',
      loadTenantProfile: true
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="widget-title"]')?.textContent).toBe('Acme Branded Support');
    });

    const [callUrl, callInit] = mockFetch.mock.calls[0];
    expect(callUrl).toBe('https://remote-gateway.example.com/thruline/v1/support/widget/config');
    expect(callInit.headers['X-Support-Tenant-Key']).toBe('tenant_branded_1');
    expect(callInit.headers['X-Support-Context-Token']).toBe('signed_tok_2');

    // Verify title and styling
    expect(document.querySelector('[data-testid="widget-toggle-btn"]')?.getAttribute('style')).toContain('rgb(16, 185, 129)');
    expect(document.getElementById('freellmapi-support-widget-root')?.style.left).toBe('24px');
    expect(document.querySelector('[data-testid="widget-welcome-message"]')?.textContent).toBe('Welcome to Acme Support! How can we help?');

    const quickPromptBtns = document.querySelectorAll('[data-testid="widget-quick-prompt"]');
    expect(quickPromptBtns.length).toBe(2);
    expect(quickPromptBtns[0].textContent).toBe('Check refund status');
  });

  it('renders pre-chat intake form when required fields exist and client-validates required and email fields', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: {
          version: 1,
          enabled: true,
          appearance: {
            primaryColor: '#2563eb',
            title: 'Support Desk',
            welcomeMessage: '',
            position: 'bottom-right',
            quickPrompts: []
          },
          intake: {
            required: true,
            fields: [
              { key: 'customer_name', label: 'Full Name', type: 'text', required: true },
              { key: 'email', label: 'Email Address', type: 'email', required: true },
              { key: 'category', label: 'Category', type: 'select', required: true, options: ['billing', 'tech'] }
            ],
            schemaHash: 'hash_abc123'
          }
        }
      })
    });

    window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_intake_1',
      loadTenantProfile: true
    });

    await vi.waitFor(() => {
      const intakeForm = document.querySelector('[data-testid="widget-intake-form"]');
      expect(intakeForm).not.toBeNull();
      expect((intakeForm as HTMLElement).style.display).toBe('flex');
    });

    expect((document.getElementById('freellmapi-support-messages') as HTMLElement).style.display).toBe('none');

    // Click submit with empty fields -> client validation triggers
    const submitBtn = document.querySelector('[data-testid="widget-intake-submit-btn"]') as HTMLButtonElement;
    submitBtn.click();

    expect(document.querySelector('[data-testid="widget-intake-error-customer_name"]')?.textContent).toBe('This field is required');
    expect(document.querySelector('[data-testid="widget-intake-error-email"]')?.textContent).toBe('This field is required');
    // Ensure no intake POST was made due to validation error
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Enter invalid email
    const nameInput = document.querySelector('[data-testid="widget-intake-input-customer_name"]') as HTMLInputElement;
    const emailInput = document.querySelector('[data-testid="widget-intake-input-email"]') as HTMLInputElement;
    nameInput.value = 'John Doe';
    emailInput.value = 'invalid-email-no-at';
    submitBtn.click();

    expect(document.querySelector('[data-testid="widget-intake-error-email"]')?.textContent).toBe('Please enter a valid email address');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('renews signed guest session before submitting intake and sends intake POST without identity in body', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    // 1. Config fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: {
          version: 1,
          enabled: true,
          appearance: { primaryColor: '#2563eb', title: 'Support', welcomeMessage: '', position: 'bottom-right', quickPrompts: [] },
          intake: {
            required: true,
            fields: [
              { key: 'user_email', label: 'Email', type: 'email', required: true }
            ],
            schemaHash: 'hash_email_only'
          }
        }
      })
    });

    window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_guest_intake',
      loadTenantProfile: true
    });

    await vi.waitFor(() => {
      const emailInput = document.querySelector('[data-testid="widget-intake-input-user_email"]');
      expect(emailInput).not.toBeNull();
    });

    // 2. Next: guest session renewal mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        contextToken: 'signed_guest_token_xyz',
        expiresIn: 900
      })
    });

    // 3. Intake submission response mock
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => ({
        ok: true,
        receipt: {
          intakeReceiptId: 'receipt_opaque_999',
          expiresAt: '2026-11-13T21:00:00Z',
          schemaHash: 'hash_email_only',
          replayed: false
        }
      })
    });

    const emailInput = document.querySelector('[data-testid="widget-intake-input-user_email"]') as HTMLInputElement;
    emailInput.value = 'guest@example.com';

    const submitBtn = document.querySelector('[data-testid="widget-intake-submit-btn"]') as HTMLButtonElement;
    submitBtn.click();

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));

    // Verify call 2: guest session renewal
    const [renewUrl, renewInit] = mockFetch.mock.calls[1];
    expect(renewUrl).toBe('https://remote-gateway.example.com/thruline/v1/support/guest-session');
    expect(JSON.parse(renewInit.body)).toEqual({ tenantKey: 'tenant_guest_intake' });

    // Verify call 3: intake submission
    const [intakeUrl, intakeInit] = mockFetch.mock.calls[2];
    expect(intakeUrl).toBe('https://remote-gateway.example.com/thruline/v1/support/widget/intake');
    expect(intakeInit.headers['X-Support-Context-Token']).toBe('signed_guest_token_xyz');

    const submittedBody = JSON.parse(intakeInit.body);
    expect(submittedBody.values).toEqual({ user_email: 'guest@example.com' });
    expect(submittedBody.configVersion).toBe(1);
    // Public intake body must NEVER set identity/role/internal metadata
    expect(submittedBody.role).toBeUndefined();
    expect(submittedBody.userId).toBeUndefined();
    expect(submittedBody.internalMetadata).toBeUndefined();

    // Verify intake form is dismissed and messages are shown
    expect((document.querySelector('[data-testid="widget-intake-form"]') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('freellmapi-support-messages') as HTMLElement).style.display).toBe('flex');

    // Verify raw intake values are NOT persisted in sessionStorage
    const storageKeys = Object.keys(window.sessionStorage);
    for (const k of storageKeys) {
      expect(window.sessionStorage.getItem(k)).not.toContain('guest@example.com');
    }
  });

  it('attaches intakeReceiptId to chat message and sends to server', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    // 1. Config fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: {
          version: 1,
          enabled: true,
          appearance: { primaryColor: '#2563eb', title: 'Support', welcomeMessage: '', position: 'bottom-right', quickPrompts: [] },
          intake: {
            required: true,
            fields: [{ key: 'topic', label: 'Topic', type: 'text', required: true }],
            schemaHash: 'hash_topic_1'
          }
        }
      })
    });

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_chat_receipt',
      contextToken: 'signed_cust_tok',
      loadTenantProfile: true
    });

    await vi.waitFor(() => {
      const topicInput = document.querySelector('[data-testid="widget-intake-input-topic"]');
      expect(topicInput).not.toBeNull();
    });

    // 2. Intake submission
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        receipt: {
          intakeReceiptId: 'receipt_bound_777',
          expiresAt: '2026-11-13T21:00:00Z',
          schemaHash: 'hash_topic_1',
          replayed: false
        }
      })
    });

    const topicInput = document.querySelector('[data-testid="widget-intake-input-topic"]') as HTMLInputElement;
    topicInput.value = 'Billing issue';
    const submitBtn = document.querySelector('[data-testid="widget-intake-submit-btn"]') as HTMLButtonElement;
    submitBtn.click();

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // 3. Send chat message
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'We have received your billing question.',
        runtime: { conversationId: 'conv-rec-1' }
      })
    });

    instance?.sendMessage('Help with billing');

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(3));
    const [chatUrl, chatInit] = mockFetch.mock.calls[2];
    expect(chatUrl).toBe('https://remote-gateway.example.com/thruline/v1/support/chat');
    const chatBody = JSON.parse(chatInit.body);
    expect(chatBody.intakeReceiptId).toBe('receipt_bound_777');
  });

  it('handles 428 intake_required and 409 intake_schema_changed without silent AI resubmission', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_428_test',
      contextToken: 'cust_token_428'
    });

    // First chat send returns 428 intake_required
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 428,
      json: async () => ({
        error: { code: 'intake_required', message: 'Survey intake required before chatting' }
      })
    });

    // Server config fetch triggered by 428
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: {
          version: 2,
          enabled: true,
          appearance: { primaryColor: '#2563eb', title: 'Support', welcomeMessage: '', position: 'bottom-right', quickPrompts: [] },
          intake: {
            required: true,
            fields: [{ key: 'notes', label: 'Notes', type: 'text', required: true }],
            schemaHash: 'hash_notes_2'
          }
        }
      })
    });

    instance?.sendMessage('Starting without intake');

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));

    // Verify intake form is shown on 428
    await vi.waitFor(() => {
      const intakeForm = document.querySelector('[data-testid="widget-intake-form"]');
      expect(intakeForm).not.toBeNull();
      expect((intakeForm as HTMLElement).style.display).toBe('flex');
    });

    expect(document.querySelector('[data-testid="widget-banner"]')?.textContent).toContain('survey');

    // Verify it did NOT auto-retry chat (mockFetch still at 2 calls)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('optional intake renders explicit skip button which dismisses intake form and allows direct chat', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: {
          version: 1,
          enabled: true,
          appearance: { primaryColor: '#2563eb', title: 'Support', welcomeMessage: '', position: 'bottom-right', quickPrompts: [] },
          intake: {
            required: false,
            fields: [{ key: 'feedback', label: 'Optional Feedback', type: 'text', required: false }],
            schemaHash: 'hash_opt_1'
          }
        }
      })
    });

    window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_optional_intake',
      contextToken: 'signed_token_opt',
      loadTenantProfile: true
    });

    await vi.waitFor(() => {
      const skipBtn = document.querySelector('[data-testid="widget-intake-skip-btn"]');
      expect(skipBtn).not.toBeNull();
    });

    const skipBtn = document.querySelector('[data-testid="widget-intake-skip-btn"]') as HTMLButtonElement;
    skipBtn.click();

    expect((document.querySelector('[data-testid="widget-intake-form"]') as HTMLElement).style.display).toBe('none');
    expect((document.getElementById('freellmapi-support-messages') as HTMLElement).style.display).toBe('flex');
  });

  it('FreeLLMAPISupport.preview renders in container with transport disabled and zero effect on global _instance', async () => {
    loadWidgetScript();

    expect(window.FreeLLMAPISupport.preview).toBeDefined();

    const container = document.createElement('div');
    document.body.appendChild(container);

    const preview = window.FreeLLMAPISupport.preview(container, {
      version: 1,
      enabled: true,
      appearance: {
        primaryColor: '#7c3aed',
        title: 'Studio Preview Title',
        welcomeMessage: 'Welcome to preview mode!',
        position: 'bottom-right',
        quickPrompts: ['Preview Prompt 1']
      },
      intake: {
        required: true,
        fields: [{ key: 'test_field', label: 'Test Field', type: 'text', required: true }],
        schemaHash: 'preview_hash'
      }
    });

    expect(preview).toBeDefined();
    expect(typeof preview.destroy).toBe('function');

    // Assert preview elements inside container
    expect(container.querySelector('[data-testid="widget-preview-box"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="widget-preview-title"]')?.textContent).toBe('Studio Preview Title');
    expect(container.querySelector('[data-testid="widget-preview-welcome"]')?.textContent).toBe('Welcome to preview mode!');
    expect(container.querySelector('[data-testid="widget-preview-intake"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="widget-preview-quick-prompt-0"]')?.textContent).toBe('Preview Prompt 1');

    // Assert zero transport
    expect(mockFetch).not.toHaveBeenCalled();

    // Assert zero effect on window.FreeLLMAPISupport._instance
    expect(window.FreeLLMAPISupport._instance).toBeNull();

    // Destroy preview
    preview.destroy();
    expect(container.children.length).toBe(0);
    container.remove();
  });

  it('switching context token cancels in-flight callbacks and isolates receipts across identities', async () => {
    loadWidgetScript('https://remote-gateway.example.com/thruline/v1/support/widget.js');

    const instance = window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_epoch_test',
      contextToken: 'user_A_token'
    });

    instance?.sendMessage('User A message');
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));

    // Switch contextToken to User B before User A response arrives
    instance?.updateContextToken('user_B_token');

    // Resolve User A response late
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        reply: 'Late reply for User A',
        runtime: { conversationId: 'conv-user-A' }
      })
    });

    // Verify late reply is not rendered into message list for User B
    const messages = document.getElementById('freellmapi-support-messages');
    expect(messages?.textContent).not.toContain('Late reply for User A');
  });

  it('preserves deployment prefix in widget config and intake requests', async () => {
    loadWidgetScript('https://remote-gateway.example.com/my-prefix/thruline/v1/support/widget.js');

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        config: {
          version: 1,
          enabled: true,
          appearance: { primaryColor: '#2563eb', title: 'Prefixed', welcomeMessage: '', position: 'bottom-right', quickPrompts: [] },
          intake: { required: false, fields: [] }
        }
      })
    });

    window.FreeLLMAPISupport.init({
      tenantKey: 'tenant_prefix_1',
      contextToken: 'signed_prefix_tok',
      loadTenantProfile: true
    });

    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1));
    const [callUrl] = mockFetch.mock.calls[0];
    expect(callUrl).toBe('https://remote-gateway.example.com/my-prefix/thruline/v1/support/widget/config');
  });

  it.each(['chat', 'intake'])('reloads current profile after a %s schema conflict without auto-sending', async (conflictAt) => {
    loadWidgetScript('https://gateway.example/prefix/thruline/v1/support/widget.js');
    let profileReads = 0;
    let intakePosts = 0;
    let chats = 0;
    mockFetch.mockImplementation(async (url: string, options: RequestInit = {}) => {
      if (url.endsWith('/widget/config')) {
        profileReads++;
        const version = profileReads === 1 ? 1 : 2;
        return {ok:true,status:200,json:async()=>({config:{enabled:true,version,
          appearance:{primaryColor:'#123456',title:'Support',welcomeMessage:'Hello',position:'bottom-left',quickPrompts:[]},
          intake:{required:true,schemaHash:'schema_'+version,fields:[{key:version===1?'issue':'order',label:'Question',type:'text',required:true}]}}})};
      }
      if (url.endsWith('/widget/intake')) {
        intakePosts++;
        if (conflictAt === 'intake' && intakePosts === 1) return {ok:false,status:409,json:async()=>({error:{code:'widget_config_changed'}})};
        return {ok:true,status:201,json:async()=>({receipt:{intakeReceiptId:'receipt_'+intakePosts,schemaHash:'schema_'+(profileReads===1?1:2)}})};
      }
      if (url.endsWith('/chat')) {
        chats++;
        return {ok:false,status:409,json:async()=>({error:{code:'intake_schema_changed'}})};
      }
      throw new Error('Unexpected transport '+url+' '+options.method);
    });
    const instance = window.FreeLLMAPISupport.init({tenantKey:'public_key',contextToken:'signed_customer',loadTenantProfile:true});
    await vi.waitFor(()=>expect(document.querySelector('[data-testid="widget-intake-input-issue"]')).not.toBeNull());
    const issue = document.querySelector('[data-testid="widget-intake-input-issue"]') as HTMLInputElement;
    issue.value = 'help';
    (document.querySelector('[data-testid="widget-intake-submit-btn"]') as HTMLButtonElement).click();
    await vi.waitFor(()=>expect(intakePosts).toBe(1));
    if (conflictAt === 'chat') {
      await vi.waitFor(()=>expect((document.querySelector('[data-testid="widget-intake-form"]') as HTMLElement).style.display).toBe('none'));
      instance.sendMessage('help');
    }
    await vi.waitFor(()=>expect(document.querySelector('[data-testid="widget-intake-input-order"]')).not.toBeNull());
    expect(profileReads).toBe(2);
    (document.querySelector('[data-testid="widget-intake-input-order"]') as HTMLInputElement).value = 'order1';
    (document.querySelector('[data-testid="widget-intake-submit-btn"]') as HTMLButtonElement).click();
    await vi.waitFor(()=>expect(intakePosts).toBe(2));
    const calls = mockFetch.mock.calls.filter(([url])=>String(url).endsWith('/widget/intake'));
    expect(JSON.parse(calls[1][1].body)).toMatchObject({configVersion:2,values:{order:'order1'}});
    expect(chats).toBe(conflictAt === 'chat' ? 1 : 0);
    expect(mockFetch.mock.calls.every(([url])=>String(url).startsWith('https://gateway.example/prefix/'))).toBe(true);
    instance.destroy();
  });

  it('retries failed profile loading explicitly and preserves intake identity on network retry', async () => {
    loadWidgetScript('https://gateway.example/thruline/v1/support/widget.js');
    let profiles = 0;
    let submissions = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/widget/config')) {
        profiles++;
        if (profiles === 1) return {ok:false,status:503,json:async()=>({})};
        return {ok:true,status:200,json:async()=>({config:{version:1,enabled:true,appearance:{title:'Help',primaryColor:'#123456',quickPrompts:[]},intake:{required:true,schemaHash:'schema',fields:[{key:'issue',label:'Issue',type:'text',required:true}]}}})};
      }
      if (url.endsWith('/widget/intake')) {
        submissions++;
        if (submissions === 1) throw new Error('response lost');
        return {ok:true,status:201,json:async()=>({receipt:{intakeReceiptId:'receipt',schemaHash:'schema'}})};
      }
      throw new Error('Unexpected transport '+url);
    });
    const instance = window.FreeLLMAPISupport.init({tenantKey:'public',contextToken:'signed',loadTenantProfile:true});
    const banner = document.querySelector('[data-testid="widget-banner"]') as HTMLElement;
    await vi.waitFor(()=>expect(banner.getAttribute('role')).toBe('button'));
    banner.click();
    await vi.waitFor(()=>expect(document.querySelector('[data-testid="widget-intake-input-issue"]')).not.toBeNull());
    const input = document.querySelector('[data-testid="widget-intake-input-issue"]') as HTMLInputElement;
    input.value='private customer issue';
    const submit = document.querySelector('[data-testid="widget-intake-submit-btn"]') as HTMLButtonElement;
    submit.click();
    await vi.waitFor(()=>{expect(submissions).toBe(1);expect(submit.disabled).toBe(false);});
    submit.click();
    await vi.waitFor(()=>expect(submissions).toBe(2));
    const calls = mockFetch.mock.calls.filter(([url])=>String(url).endsWith('/widget/intake'));
    expect(JSON.parse(calls[0][1].body).requestId).toBe(JSON.parse(calls[1][1].body).requestId);
    expect(JSON.stringify(window.sessionStorage)).not.toContain('private customer issue');
    instance.destroy();
  });

  it('preserves an existing live instance when the served factory loads again for preview', () => {
    loadWidgetScript();
    const live=window.FreeLLMAPISupport.init({tenantKey:'public',contextToken:'signed'});
    loadWidgetScript();
    expect(window.FreeLLMAPISupport._instance).toBe(live);
    const container=document.createElement('div');
    document.body.appendChild(container);
    const preview=window.FreeLLMAPISupport.preview(container,{enabled:true,version:1,appearance:{title:'Preview',primaryColor:'#123456',quickPrompts:[]},intake:{required:false,fields:[]}});
    expect(window.FreeLLMAPISupport._instance).toBe(live);
    expect(mockFetch).not.toHaveBeenCalled();
    preview.destroy();
    expect(window.FreeLLMAPISupport._instance).toBe(live);
    live.destroy();
  });
});
