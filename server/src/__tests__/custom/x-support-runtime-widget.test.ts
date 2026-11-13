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

});
