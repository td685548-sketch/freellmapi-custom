/**
 * Standalone embeddable support runtime widget script factory.
 * Served via GET /x/v1/support/widget.js.
 */
export function getSupportRuntimeWidgetScript(): string {
  return `/** FreeLLMAPI AI Support Embeddable Widget */
(function(window, document) {
  'use strict';

  // 1. Capture currentScript.src at script evaluation to determine server origin
  var evaluatedScriptBase = '';
  try {
    var cur = document.currentScript;
    if (cur && cur.src) {
      var parsed = new URL(cur.src, (window.location && window.location.href) ? window.location.href : 'http://localhost');
      var widgetSuffix = '/x/v1/support/widget.js';
      var basePath = parsed.pathname.slice(-widgetSuffix.length) === widgetSuffix ? parsed.pathname.slice(0, -widgetSuffix.length) : '';
      evaluatedScriptBase = parsed.origin + basePath;
    }
  } catch (e) {}

  var i18n = {
    en: {
      title: 'Support Assistant',
      placeholder: 'Type your message...',
      send: 'Send',
      retry: 'Retry',
      escalate: 'Talk to human agent',
      escalatedBanner: 'Transferred to a human agent. A representative will reply shortly.',
      pendingApproval: 'Action awaiting approval:',
      csatPrompt: 'How would you rate our support?',
      csatThanks: 'Thank you for your feedback!',
      authRequired: 'Authentication required. Please sign in to continue.',
      networkError: 'Network error. Please try again.',
      sending: 'Sending...',
      retryFailed: 'Request failed. Click to retry.'
    },
    vi: {
      title: 'Trợ lý Hỗ trợ',
      placeholder: 'Nhập tin nhắn của bạn...',
      send: 'Gửi',
      retry: 'Thử lại',
      escalate: 'Gặp nhân viên hỗ trợ',
      escalatedBanner: 'Đã chuyển cho nhân viên hỗ trợ. Đại diện sẽ phản hồi sớm.',
      pendingApproval: 'Hành động đang chờ phê duyệt:',
      csatPrompt: 'Bạn đánh giá trải nghiệm hỗ trợ thế nào?',
      csatThanks: 'Cảm ơn phản hồi của bạn!',
      authRequired: 'Yêu cầu xác thực. Vui lòng đăng nhập để tiếp tục.',
      networkError: 'Lỗi mạng. Vui lòng thử lại.',
      sending: 'Đang gửi...',
      retryFailed: 'Yêu cầu thất bại. Bấm để thử lại.'
    }
  };

  // Safe in-memory fallback when sessionStorage is blocked
  var memoryStorage = {};
  function getSafeStorage() {
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        var testK = '__flm_test__';
        window.sessionStorage.setItem(testK, '1');
        window.sessionStorage.removeItem(testK);
        return window.sessionStorage;
      }
    } catch (e) {}
    return null;
  }
  var sessionStorageRef = getSafeStorage();

  function hashString(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  window.FreeLLMAPISupport = {
    _instance: null,
    init: function(config) {
      if (!config || !config.tenantKey) {
        console.error('[FreeLLMAPI Support] Missing required tenantKey');
        return null;
      }

      if (document.getElementById('freellmapi-support-widget-root')) {
        return window.FreeLLMAPISupport._instance || null;
      }

      var tenantKey = String(config.tenantKey);
      var locale = config.locale === 'vi' ? 'vi' : 'en';
      var strings = i18n[locale] || i18n.en;

      // Determine serverBase: explicit serverBase > evaluatedScriptBase > endpoint origin
      var serverBase = config.serverBase || evaluatedScriptBase || '';
      if (!serverBase && config.endpoint && /^https?:\\/\\//i.test(config.endpoint)) {
        try {
          serverBase = new URL(config.endpoint).origin;
        } catch (e) {}
      }

      function resolveUrl(pathOrUrl) {
        if (/^https?:\\/\\//i.test(pathOrUrl)) return pathOrUrl;
        var base = serverBase;
        if (!base && typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null') {
          base = window.location.origin;
        }
        if (!base) return pathOrUrl;
        if (base.endsWith('/') && pathOrUrl.startsWith('/')) {
          return base + pathOrUrl.slice(1);
        }
        if (!base.endsWith('/') && !pathOrUrl.startsWith('/')) {
          return base + '/' + pathOrUrl;
        }
        return base + pathOrUrl;
      }

      var endpoint = config.endpoint ? resolveUrl(config.endpoint) : resolveUrl('/x/v1/support/chat');
      var titleText = config.title || strings.title;
      var primaryColor = config.primaryColor || '#2563eb';
      var placeholder = config.placeholder || strings.placeholder;
      var allowGuestSession = config.allowGuestSession !== false;
      var onAuthRequired = typeof config.onAuthRequired === 'function' ? config.onAuthRequired : null;

      // Ephemeral state
      var identityEpoch = 0;
      var destroyed = false;
      var guestCredentialKey = 'flm_guest_' + hashString(serverBase + ':' + tenantKey);
      var storedGuest = null;
      if (!config.contextToken && sessionStorageRef) {
        try { var savedGuest = JSON.parse(sessionStorageRef.getItem(guestCredentialKey) || 'null'); if (savedGuest && savedGuest.expiresAt > Date.now()) storedGuest = savedGuest.token; } catch (e) {}
      }
      var activeToken = config.contextToken || storedGuest || '';
      var isGuest = !config.contextToken;
      var conversationId = null;
      var isOpen = false;
      var isEscalated = false;
      var renderedMessageIds = {};
      var currentTurn = null; // { text, requestId, conversationId }
      var activeAbortControllers = [];
      var pollTimer = null;
      var pollInterval = typeof config.pollInterval === 'number' ? config.pollInterval : 5000;
      var pollBackoff = pollInterval;

      function getStoragePrefix() {
        var idKey = activeToken ? 'tok_' + hashString(activeToken) : 'guest';
        return 'flm_sup_' + hashString(serverBase + ':' + tenantKey + ':' + idKey) + '_';
      }

      function readStored(key) {
        var p = getStoragePrefix() + key;
        if (sessionStorageRef) {
          try { return sessionStorageRef.getItem(p); } catch (e) {}
        }
        return memoryStorage[p] !== undefined ? memoryStorage[p] : null;
      }

      function writeStored(key, val) {
        var p = getStoragePrefix() + key;
        if (sessionStorageRef) {
          try { sessionStorageRef.setItem(p, val); return; } catch (e) {}
        }
        memoryStorage[p] = val;
      }

      function clearCurrentStorage() {
        var prefix = getStoragePrefix();
        if (sessionStorageRef) {
          try {
            var keysToRemove = [];
            for (var i = 0; i < sessionStorageRef.length; i++) {
              var k = sessionStorageRef.key(i);
              if (k && k.indexOf(prefix) === 0) keysToRemove.push(k);
            }
            for (var j = 0; j < keysToRemove.length; j++) {
              sessionStorageRef.removeItem(keysToRemove[j]);
            }
          } catch (e) {}
        }
        for (var mk in memoryStorage) {
          if (mk.indexOf(prefix) === 0) delete memoryStorage[mk];
        }
      }

      function trackAbortController() {
        var c = new AbortController();
        activeAbortControllers.push(c);
        return c;
      }

      function untrackAbortController(c) {
        var idx = activeAbortControllers.indexOf(c);
        if (idx >= 0) activeAbortControllers.splice(idx, 1);
      }

      function abortAllRequests() {
        while (activeAbortControllers.length > 0) {
          var c = activeAbortControllers.pop();
          try { c.abort(); } catch (e) {}
        }
      }

      // DOM Creation
      var root = document.createElement('div');
      root.id = 'freellmapi-support-widget-root';
      root.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;';

      var toggleBtn = document.createElement('button');
      toggleBtn.id = 'freellmapi-support-toggle';
      toggleBtn.setAttribute('data-testid', 'widget-toggle-btn');
      toggleBtn.setAttribute('aria-label', 'Toggle support assistant');
      toggleBtn.style.cssText = 'width:56px;height:56px;border-radius:28px;background:' + primaryColor + ';color:#fff;border:none;box-shadow:0 4px 14px rgba(0,0,0,0.25);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:transform 0.2s ease;';
      toggleBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

      var box = document.createElement('div');
      box.id = 'freellmapi-support-box';
      box.setAttribute('data-testid', 'widget-box');
      box.style.cssText = 'display:none;position:absolute;bottom:70px;right:0;width:380px;height:540px;max-width:calc(100vw - 32px);max-height:calc(100vh - 100px);background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.2);flex-direction:column;overflow:hidden;border:1px solid #e5e7eb;';

      // Header
      var header = document.createElement('div');
      header.style.cssText = 'background:' + primaryColor + ';color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:15px;';

      var headerTitle = document.createElement('span');
      headerTitle.setAttribute('data-testid', 'widget-title');
      headerTitle.textContent = titleText; // SAFE TEXT

      var headerActions = document.createElement('div');
      headerActions.style.cssText = 'display:flex;align-items:center;gap:8px;';

      var escalateBtn = document.createElement('button');
      escalateBtn.setAttribute('data-testid', 'widget-escalate-btn');
      escalateBtn.textContent = strings.escalate;
      escalateBtn.style.cssText = 'background:rgba(255,255,255,0.2);border:none;color:#fff;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;';

      var closeBtn = document.createElement('button');
      closeBtn.id = 'freellmapi-support-close';
      closeBtn.setAttribute('data-testid', 'widget-close-btn');
      closeBtn.setAttribute('aria-label', 'Close');
      closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;padding:0 4px;';
      closeBtn.textContent = '×';

      headerActions.appendChild(escalateBtn);
      headerActions.appendChild(closeBtn);
      header.appendChild(headerTitle);
      header.appendChild(headerActions);

      // Status Banner
      var bannerBox = document.createElement('div');
      bannerBox.setAttribute('data-testid', 'widget-banner');
      bannerBox.style.cssText = 'display:none;padding:8px 12px;font-size:12px;line-height:1.4;';

      // Messages Area
      var msgList = document.createElement('div');
      msgList.id = 'freellmapi-support-messages';
      msgList.setAttribute('data-testid', 'widget-messages');
      msgList.style.cssText = 'flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:#f9fafb;';

      // Input Form
      var form = document.createElement('form');
      form.setAttribute('data-testid', 'widget-form');
      form.style.cssText = 'display:flex;padding:12px;background:#fff;border-top:1px solid #e5e7eb;gap:8px;';

      var input = document.createElement('input');
      input.type = 'text';
      input.setAttribute('data-testid', 'widget-input');
      input.placeholder = placeholder;
      input.style.cssText = 'flex:1;padding:10px 14px;border:1px solid #d1d5db;border-radius:20px;outline:none;font-size:14px;';

      var sendBtn = document.createElement('button');
      sendBtn.type = 'submit';
      sendBtn.setAttribute('data-testid', 'widget-send-btn');
      sendBtn.textContent = strings.send;
      sendBtn.style.cssText = 'padding:8px 16px;background:' + primaryColor + ';color:#fff;border:none;border-radius:20px;cursor:pointer;font-weight:500;';

      form.appendChild(input);
      form.appendChild(sendBtn);

      box.appendChild(header);
      box.appendChild(bannerBox);
      box.appendChild(msgList);
      box.appendChild(form);
      root.appendChild(box);
      root.appendChild(toggleBtn);
      document.body.appendChild(root);

      function setBanner(text, type) {
        if (!text) {
          bannerBox.style.display = 'none';
          bannerBox.textContent = '';
          return;
        }
        bannerBox.style.display = 'block';
        bannerBox.textContent = text; // SAFE TEXT
        if (type === 'error') {
          bannerBox.style.background = '#fee2e2';
          bannerBox.style.color = '#991b1b';
          bannerBox.style.borderBottom = '1px solid #fca5a5';
        } else if (type === 'info') {
          bannerBox.style.background = '#e0f2fe';
          bannerBox.style.color = '#075985';
          bannerBox.style.borderBottom = '1px solid #bae6fd';
        } else {
          bannerBox.style.background = '#fef3c7';
          bannerBox.style.color = '#92400e';
          bannerBox.style.borderBottom = '1px solid #fde68a';
        }
      }

      function safeRenderMessage(role, text, senderName) {
        var el = document.createElement('div');
        el.className = 'freellmapi-message freellmapi-message-' + role;
        el.setAttribute('data-role', role);
        el.style.cssText = role === 'user'
          ? 'align-self:flex-end;max-width:80%;padding:10px 14px;background:' + primaryColor + ';color:#fff;border-radius:16px 16px 2px 16px;word-break:break-word;'
          : role === 'staff'
            ? 'align-self:flex-start;max-width:80%;padding:10px 14px;background:#10b981;color:#fff;border-radius:16px 16px 16px 2px;word-break:break-word;'
            : 'align-self:flex-start;max-width:80%;padding:10px 14px;background:#e5e7eb;color:#1f2937;border-radius:16px 16px 16px 2px;word-break:break-word;';

        if (senderName) {
          var nameEl = document.createElement('div');
          nameEl.style.cssText = 'font-size:11px;opacity:0.8;margin-bottom:4px;font-weight:600;';
          nameEl.textContent = senderName; // SAFE TEXT
          el.appendChild(nameEl);
        }

        var textEl = document.createElement('div');
        textEl.textContent = text; // SAFE TEXT - NO innerHTML
        el.appendChild(textEl);

        msgList.appendChild(el);
        msgList.scrollTop = msgList.scrollHeight;
        return el;
      }

      function safeRenderPendingApproval(toolName) {
        var card = document.createElement('div');
        card.setAttribute('data-testid', 'widget-pending-action');
        card.style.cssText = 'align-self:flex-start;max-width:85%;padding:8px 12px;background:#fffbeb;color:#92400e;border:1px solid #fde68a;border-radius:8px;font-size:12px;margin-top:4px;';

        var strong = document.createElement('strong');
        strong.textContent = strings.pendingApproval + ' ';
        card.appendChild(strong);

        var toolSpan = document.createElement('span');
        toolSpan.textContent = toolName; // SAFE TEXT
        card.appendChild(toolSpan);

        msgList.appendChild(card);
        msgList.scrollTop = msgList.scrollHeight;
      }

      function showCsatPrompt() {
        if (msgList.querySelector('[data-testid="widget-csat-container"]')) return;
        var container = document.createElement('div');
        container.setAttribute('data-testid', 'widget-csat-container');
        container.style.cssText = 'align-self:center;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px;margin:8px 0;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,0.05);width:90%;';

        var promptText = document.createElement('div');
        promptText.style.cssText = 'font-weight:500;margin-bottom:8px;color:#374151;';
        promptText.textContent = strings.csatPrompt;
        container.appendChild(promptText);

        var starBox = document.createElement('div');
        starBox.style.cssText = 'display:flex;justify-content:center;gap:8px;';

        for (var score = 1; score <= 5; score++) {
          (function(s) {
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('data-testid', 'widget-csat-btn-' + s);
            btn.textContent = String(s) + '★';
            btn.style.cssText = 'padding:6px 10px;border:1px solid #d1d5db;background:#f9fafb;border-radius:6px;cursor:pointer;font-weight:600;color:#f59e0b;';
            btn.addEventListener('click', function() {
              submitCsat(s, container);
            });
            starBox.appendChild(btn);
          })(score);
        }
        container.appendChild(starBox);
        msgList.appendChild(container);
        msgList.scrollTop = msgList.scrollHeight;
      }

      function submitCsat(score, container) {
        var epoch = identityEpoch;
        if (!conversationId) return;
        var ctrl = trackAbortController();
        var headers = {
          'Content-Type': 'application/json',
          'X-Support-Tenant-Key': tenantKey
        };
        if (activeToken) headers['X-Support-Context-Token'] = activeToken;

        fetch(resolveUrl('/x/v1/support/csat'), {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ conversationId: conversationId, score: score }),
          signal: ctrl.signal
        })
        .then(function(res) {
          untrackAbortController(ctrl);
          if (res.ok && !destroyed && epoch === identityEpoch) {
            container.innerHTML = '';
            var thanks = document.createElement('div');
            thanks.style.cssText = 'color:#059669;font-weight:500;padding:4px;';
            thanks.textContent = strings.csatThanks;
            container.appendChild(thanks);
          }
        })
        .catch(function() {
          untrackAbortController(ctrl);
        });
      }

      function handleAuthRequired(reason) {
        setBanner(strings.authRequired, 'error');
        input.disabled = true;
        sendBtn.disabled = true;
        escalateBtn.disabled = true;
        stopPolling();
        if (onAuthRequired) {
          try { onAuthRequired(reason); } catch (e) {}
        }
      }

      function renewGuestSession() {
        var epoch = identityEpoch;
        if (!allowGuestSession) return Promise.reject(new Error('guests_not_allowed'));
        var ctrl = trackAbortController();
        return fetch(resolveUrl('/x/v1/support/guest-session'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tenantKey: tenantKey }),
          signal: ctrl.signal
        })
        .then(function(res) {
          untrackAbortController(ctrl);
          if (!res.ok) throw new Error('guest_session_failed_' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (destroyed || epoch !== identityEpoch) throw new DOMException('Identity changed', 'AbortError');
          if (data && data.contextToken) {
            activeToken = data.contextToken;
            isGuest = true;
            if (sessionStorageRef) { try { sessionStorageRef.setItem(guestCredentialKey, JSON.stringify({ token: activeToken, expiresAt: Date.now() + Math.min(Number(data.expiresIn) || 900, 900) * 1000 })); } catch (e) {} }
            return activeToken;
          }
          throw new Error('missing_guest_token');
        })
        .catch(function(err) {
          untrackAbortController(ctrl);
          throw err;
        });
      }

      function resumeConversation(convId) {
        var epoch = identityEpoch;
        if (!convId) return;
        var ctrl = trackAbortController();
        var headers = {
          'X-Support-Tenant-Key': tenantKey
        };
        if (activeToken) headers['X-Support-Context-Token'] = activeToken;

        var p = fetch(resolveUrl('/x/v1/support/conversations/' + encodeURIComponent(convId)), {
          method: 'GET',
          headers: headers,
          signal: ctrl.signal
        });
        if (!p || typeof p.then !== 'function') {
          untrackAbortController(ctrl);
          return;
        }

        p
        .then(function(res) {
          untrackAbortController(ctrl);
          if (destroyed || epoch !== identityEpoch || ctrl.signal.aborted) return null;
          if (res.status === 401) {
            if (!isGuest) {
              handleAuthRequired('token_expired');
            }
            clearCurrentStorage();
            conversationId = null;
            return null;
          }
          if (!res.ok) {
            clearCurrentStorage();
            conversationId = null;
            return null;
          }
          return res.json();
        })
        .then(function(data) {
          if (!data || destroyed || epoch !== identityEpoch || ctrl.signal.aborted) return;
          var conv = data.conversation || data;
          conversationId = conv.id || convId;
          writeStored('conv_id', conversationId);
          if (conv.status === 'escalated') {
            isEscalated = true;
            setBanner(strings.escalatedBanner, 'info');
          }
          isEscalated = conv.status === 'escalated';
          input.disabled = isEscalated;
          sendBtn.disabled = isEscalated;
          var msgs = conv.messages || [];
          for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            var mid = m.id || (m.createdAt + '_' + m.content);
            if (!renderedMessageIds[mid]) {
              renderedMessageIds[mid] = true;
              var role = m.senderType || m.role || 'user';
              if (role === 'human_agent' || role === 'staff' || role === 'agent') {
                safeRenderMessage('staff', m.content, m.senderName || 'Support Agent');
              } else if ((role === 'ai_assistant' || role === 'assistant')) {
                safeRenderMessage('assistant', m.content);
              } else {
                safeRenderMessage('user', m.content);
              }
            }
          }
          if (isOpen) startPolling();
        })
        .catch(function(err) {
          untrackAbortController(ctrl);
          if (destroyed || epoch !== identityEpoch || ctrl.signal.aborted || (err && err.name === 'AbortError')) return;
          clearCurrentStorage();
          conversationId = null;
        });
      }

      // Polling for human replies
      function startPolling() {
        stopPolling();
        if (destroyed || !isOpen || !conversationId) return;
        pollBackoff = pollInterval;
        scheduleNextPoll(pollBackoff);
      }

      function scheduleNextPoll(delay) {
        if (destroyed || !isOpen) return;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = setTimeout(function() {
          doPoll();
        }, delay);
      }

      function stopPolling() {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      }

      function doPoll() {
        var epoch = identityEpoch;
        if (destroyed || !isOpen || !conversationId) return;
        var ctrl = trackAbortController();
        var headers = { 'X-Support-Tenant-Key': tenantKey };
        if (activeToken) headers['X-Support-Context-Token'] = activeToken;

        var fetchPromise = fetch(resolveUrl('/x/v1/support/conversations/' + encodeURIComponent(conversationId)), {
          method: 'GET',
          headers: headers,
          signal: ctrl.signal
        });
        if (!fetchPromise || typeof fetchPromise.then !== 'function') {
          untrackAbortController(ctrl);
          return;
        }

        fetchPromise
        .then(function(res) {
          untrackAbortController(ctrl);
          if (destroyed || epoch !== identityEpoch || ctrl.signal.aborted) return null;
          if (res.status === 401 && !isGuest) {
            handleAuthRequired('token_expired');
            return null;
          }
          if (!res.ok) throw new Error('poll_error_' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (!data || destroyed || epoch !== identityEpoch || ctrl.signal.aborted) return;
          pollBackoff = pollInterval;
          var conv = data.conversation || data;
          if (conv.status === 'escalated' && !isEscalated) {
            isEscalated = true;
            setBanner(strings.escalatedBanner, 'info');
          }
          isEscalated = conv.status === 'escalated';
          input.disabled = isEscalated;
          sendBtn.disabled = isEscalated;
          var msgs = conv.messages || [];
          for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i];
            var mid = m.id || (m.createdAt + '_' + m.content);
            if (!renderedMessageIds[mid]) {
              renderedMessageIds[mid] = true;
              var role = m.senderType || m.role || '';
              if (role === 'human_agent' || role === 'staff' || role === 'agent') {
                safeRenderMessage('staff', m.content, m.senderName || 'Support Agent');
              } else if ((role === 'ai_assistant' || role === 'assistant') && !isEscalated) {
                safeRenderMessage('assistant', m.content);
              }
            }
          }
          if (conv.status === 'resolved' || conv.status === 'closed') {
            showCsatPrompt();
          }
          if (isOpen) scheduleNextPoll(pollBackoff);
        })
        .catch(function(err) {
          untrackAbortController(ctrl);
          if (destroyed || epoch !== identityEpoch || ctrl.signal.aborted || (err && err.name === 'AbortError')) return;
          pollBackoff = Math.min(pollBackoff * 2, 60000);
          if (isOpen) scheduleNextPoll(pollBackoff);
        });
      }

      function performSend(text, reqId, convId, renewed) {
        var epoch = identityEpoch;
        if (destroyed || isEscalated) return;
        sendBtn.disabled = true;
        input.disabled = true;

        var turn = { text: text, requestId: reqId, conversationId: convId };
        currentTurn = turn;
        var turnToken = activeToken;

        var tokenPromise = (!activeToken && allowGuestSession) ? renewGuestSession() : Promise.resolve(activeToken);

        tokenPromise
        .then(function(tok) {
          if (destroyed || epoch !== identityEpoch || (turnToken && turnToken !== activeToken)) return null;
          var ctrl = trackAbortController();
          var headers = {
            'Content-Type': 'application/json',
            'X-Support-Tenant-Key': tenantKey
          };
          if (tok) headers['X-Support-Context-Token'] = tok;

          return fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
              tenantKey: tenantKey,
              contextToken: tok || undefined,
              conversationId: convId || undefined,
              requestId: reqId,
              messages: [{ role: 'user', content: text }]
            }),
            signal: ctrl.signal
          })
          .then(function(res) {
            untrackAbortController(ctrl);
            if (destroyed || epoch !== identityEpoch || ctrl.signal.aborted || (turnToken && turnToken !== activeToken)) return null;
            if (res.status === 401) {
              if (!isGuest) {
                handleAuthRequired('token_expired');
                return null;
              }
              if (renewed) {
                handleAuthRequired('guest_session_rejected');
                return null;
              }
              // A renewed guest token is a new identity: discard the old conversation.
              clearCurrentStorage();
              conversationId = null;
              renderedMessageIds = {};
              msgList.textContent = '';
              return renewGuestSession().then(function() {
                identityEpoch++;
                safeRenderMessage('user', text);
                performSend(text, reqId, null, true);
                return null;
              });
            }
            if (!res.ok) {
              return res.json().catch(function() { return {}; }).then(function(errData) {
                var code = (errData && errData.error && errData.error.code) || ('http_' + res.status);
                var err = new Error(code);
                err.status = res.status;
                err.data = errData;
                throw err;
              });
            }
            return res.json();
          });
        })
        .then(function(data) {
          if (!data) return;
          if (destroyed || epoch !== identityEpoch || (turnToken && turnToken !== activeToken)) return;

          sendBtn.disabled = false;
          input.disabled = false;
          currentTurn = null;

          if (data.runtime && data.runtime.conversationId) {
            conversationId = data.runtime.conversationId;
            writeStored('conv_id', conversationId);
          } else if (data.conversationId) {
            conversationId = data.conversationId;
            writeStored('conv_id', conversationId);
          }

          var reply = data.reply || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
          if (reply && !isEscalated) {
            safeRenderMessage('assistant', reply);
          }

          if (data.runtime && Array.isArray(data.runtime.pendingActions)) {
            for (var p = 0; p < data.runtime.pendingActions.length; p++) {
              safeRenderPendingApproval(data.runtime.pendingActions[p].toolName);
            }
          }

          if (conversationId && isOpen) {
            startPolling();
          }
        })
        .catch(function(err) {
          if (err && err.name === 'AbortError') return;
          if (destroyed || epoch !== identityEpoch || (turnToken && turnToken !== activeToken)) return;

          sendBtn.disabled = false;
          input.disabled = false;

          var errBox = document.createElement('div');
          errBox.setAttribute('data-testid', 'widget-error-box');
          errBox.style.cssText = 'align-self:flex-start;padding:8px 12px;background:#fee2e2;color:#991b1b;border-radius:8px;font-size:12px;display:flex;align-items:center;gap:8px;';

          var errText = document.createElement('span');
          errText.textContent = strings.networkError;
          errBox.appendChild(errText);

          var retryBtn = document.createElement('button');
          retryBtn.type = 'button';
          retryBtn.setAttribute('data-testid', 'widget-retry-btn');
          retryBtn.textContent = strings.retry;
          retryBtn.style.cssText = 'padding:2px 8px;background:#ef4444;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:500;';
          retryBtn.addEventListener('click', function() {
            errBox.remove();
            performSend(turn.text, turn.requestId, turn.conversationId);
          });
          errBox.appendChild(retryBtn);

          msgList.appendChild(errBox);
          msgList.scrollTop = msgList.scrollHeight;
        });
      }

      // Event listeners
      form.addEventListener('submit', function(e) {
        e.preventDefault();
        var text = input.value.trim();
        if (!text || sendBtn.disabled || destroyed || isEscalated) return;
        input.value = '';

        safeRenderMessage('user', text);

        var requestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
        performSend(text, requestId, conversationId);
      });

      toggleBtn.addEventListener('click', function() {
        if (box.style.display === 'flex') {
          instance.close();
        } else {
          instance.open();
        }
      });

      closeBtn.addEventListener('click', function() {
        instance.close();
      });

      escalateBtn.addEventListener('click', function() {
        if (isEscalated || destroyed) return;
        var epoch = identityEpoch;
        var ctrl = trackAbortController();
        var headers = {
          'Content-Type': 'application/json',
          'X-Support-Tenant-Key': tenantKey
        };
        if (activeToken) headers['X-Support-Context-Token'] = activeToken;

        fetch(resolveUrl('/x/v1/support/escalate'), {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({ conversationId: conversationId || undefined, reason: 'user_requested' }),
          signal: ctrl.signal
        })
        .then(function(res) {
          untrackAbortController(ctrl);
          if (res.status === 401 && !isGuest) {
            handleAuthRequired('token_expired');
            return null;
          }
          if (!res.ok) throw new Error('escalate_failed_' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (!data || destroyed || epoch !== identityEpoch) return;
          isEscalated = true;
          input.disabled = true;
          sendBtn.disabled = true;
          setBanner(strings.escalatedBanner, 'info');
          escalateBtn.style.display = 'none';
          if (data.conversationId) {
            conversationId = data.conversationId;
            writeStored('conv_id', conversationId);
          }
          startPolling();
        })
        .catch(function(err) {
          untrackAbortController(ctrl);
          if (err && err.name === 'AbortError') return;
          setBanner(strings.networkError, 'error');
        });
      });

      // Initialize stored conversation if present
      var storedConv = readStored('conv_id');
      if (storedConv) {
        resumeConversation(storedConv);
      }

      var instance = {
        open: function() {
          box.style.display = 'flex';
          isOpen = true;
          if (conversationId) startPolling();
        },
        close: function() {
          box.style.display = 'none';
          isOpen = false;
          stopPolling();
        },
        updateContextToken: function(newToken) {
          identityEpoch++;
          if (isGuest && sessionStorageRef) { try { sessionStorageRef.removeItem(guestCredentialKey); } catch (e) {} }
          // Cancel active requests
          abortAllRequests();
          stopPolling();

          // Clear prior messages and UI state
          msgList.innerHTML = '';
          bannerBox.style.display = 'none';
          bannerBox.textContent = '';
          renderedMessageIds = {};
          currentTurn = null;
          isEscalated = false;
          escalateBtn.style.display = 'inline-block';
          escalateBtn.disabled = false;
          input.disabled = false;
          sendBtn.disabled = false;

          // Clear prior session storage
          clearCurrentStorage();

          // Set new identity
          activeToken = newToken || '';
          isGuest = !activeToken;
          conversationId = null;

          // Re-check stored conversation under new identity scope
          var newStored = readStored('conv_id');
          if (newStored) {
            resumeConversation(newStored);
          }
        },
        setToken: function(tok) {
          this.updateContextToken(tok);
        },
        sendMessage: function(msg) {
          input.value = msg;
          form.dispatchEvent(new Event('submit'));
        },
        destroy: function() {
          destroyed = true;
          isOpen = false;
          identityEpoch++;
          abortAllRequests();
          stopPolling();
          if (root && root.parentNode) {
            root.parentNode.removeChild(root);
          }
          if (window.FreeLLMAPISupport._instance === instance) {
            window.FreeLLMAPISupport._instance = null;
          }
        }
      };

      window.FreeLLMAPISupport._instance = instance;
      return instance;
    }
  };
})(typeof window !== 'undefined' ? window : this, typeof document !== 'undefined' ? document : {});
`;
}
