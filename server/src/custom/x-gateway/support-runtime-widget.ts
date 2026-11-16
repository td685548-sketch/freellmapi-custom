/**
 * Standalone embeddable support runtime widget script factory.
 * Served via GET /thruline/v1/support/widget.js.
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
      var basePath = '';
      // '/x/v1/...' is the pre-rename address still used by older embed snippets.
      ['/thruline/v1/support/widget.js', '/x/v1/support/widget.js'].some(function (widgetSuffix) {
        if (parsed.pathname.slice(-widgetSuffix.length) !== widgetSuffix) return false;
        basePath = parsed.pathname.slice(0, -widgetSuffix.length);
        return true;
      });
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
      retryFailed: 'Request failed. Click to retry.',
      knowledgeNoticeNoMatches: 'No relevant knowledge sources were found to answer this question. You can try rephrasing or talk to a human agent.',
      knowledgeNoticeInvalidCitations: 'The generated answer could not be verified against authorized sources.',
      knowledgeNoticeSourcesChanged: 'Knowledge sources were updated during the request. Please ask your question again.',
      knowledgeNoticeSourceRevoked: 'This response referenced sources that have been revoked or are no longer available.',
      contextChanged: 'Knowledge context changed. Click to retry with a fresh request.',
      freshRetry: 'Retry with fresh request',
      sourcesLabel: 'Sources:',
      nonAiNotice: 'System Notice',
      intakeSelectPlaceholder: 'Select',
      intakeHeading: 'Before we begin...',
      intakeSubmit: 'Start Chat',
      intakeSubmitting: 'Starting...',
      intakeSkip: 'Skip',
      intakeRequiredField: 'This field is required',
      intakeInvalidEmail: 'Please enter a valid email address',
      intakeInvalidNumber: 'Please enter a valid number',
      intakeInvalidSelect: 'Please select a valid option',
      intakeLoadError: 'Failed to load configuration. Click to retry.',
      intakeContinue: 'Continue',
      intakeRequiredNotice: 'Please complete the survey to continue chat.'
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
      retryFailed: 'Yêu cầu thất bại. Bấm để thử lại.',
      knowledgeNoticeNoMatches: 'Không tìm thấy tài liệu phù hợp để trả lời câu hỏi này. Bạn có thể diễn đạt lại hoặc gặp nhân viên hỗ trợ.',
      knowledgeNoticeInvalidCitations: 'Câu trả lời không thể xác minh với tài liệu được cấp phép.',
      knowledgeNoticeSourcesChanged: 'Nguồn tri thức đã thay đổi trong khi xử lý. Vui lòng hỏi lại câu hỏi của bạn.',
      knowledgeNoticeSourceRevoked: 'Phản hồi này tham chiếu đến tài liệu đã bị thu hồi hoặc không còn khả dụng.',
      contextChanged: 'Ngữ cảnh tri thức đã thay đổi. Bấm để thử lại với yêu cầu mới.',
      freshRetry: 'Thử lại với yêu cầu mới',
      sourcesLabel: 'Nguồn tham khảo:',
      nonAiNotice: 'Thông báo hệ thống',
      intakeSelectPlaceholder: 'Chọn',
      intakeHeading: 'Trước khi bắt đầu...',
      intakeSubmit: 'Bắt đầu chat',
      intakeSubmitting: 'Đang bắt đầu...',
      intakeSkip: 'Bỏ qua',
      intakeRequiredField: 'Trường này là bắt buộc',
      intakeInvalidEmail: 'Vui lòng nhập địa chỉ email hợp lệ',
      intakeInvalidNumber: 'Vui lòng nhập số hợp lệ',
      intakeInvalidSelect: 'Vui lòng chọn một mục hợp lệ',
      intakeLoadError: 'Không thể tải cấu hình. Bấm để thử lại.',
      intakeContinue: 'Tiếp tục',
      intakeRequiredNotice: 'Vui lòng hoàn thành khảo sát để tiếp tục chat.'
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

  function sanitizeHexColor(color, fallback) {
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
      return color;
    }
    return fallback || '#2563eb';
  }

  function applyPosition(rootEl, boxEl, pos, offsetPx) {
    var offset = (typeof offsetPx === 'number' && offsetPx >= 8 && offsetPx <= 64) ? offsetPx : 24;
    rootEl.style.bottom = offset + 'px';
    if (pos === 'bottom-left') {
      rootEl.style.left = offset + 'px';
      rootEl.style.right = 'auto';
      boxEl.style.left = '0';
      boxEl.style.right = 'auto';
    } else {
      rootEl.style.right = offset + 'px';
      rootEl.style.left = 'auto';
      boxEl.style.right = '0';
      boxEl.style.left = 'auto';
    }
  }

  var AVATAR_SVGS = {
    bot: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg>',
    headset: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/></svg>',
    sparkles: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/></svg>',
    message: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>'
  };

  var FONT_STACKS = {
    system: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
    inter: '"Inter",system-ui,-apple-system,sans-serif',
    serif: 'Georgia,"Times New Roman",serif',
    mono: 'ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace'
  };

  function renderLauncherButton(toggleEl, app, bgCss) {
    if (!toggleEl) return;
    var styleMode = app.launcherStyle === 'pill' ? 'pill' : 'icon';
    var preset = (app.avatarPreset && AVATAR_SVGS[app.avatarPreset]) ? app.avatarPreset : 'message';
    var labelText = (typeof app.launcherLabel === 'string' && app.launcherLabel.trim()) ? app.launcherLabel.trim() : 'Chat with us';
    toggleEl.innerHTML = '';
    var iconWrap = document.createElement('span');
    iconWrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;';
    iconWrap.innerHTML = AVATAR_SVGS[preset] || AVATAR_SVGS.message;
    toggleEl.appendChild(iconWrap);
    if (styleMode === 'pill') {
      toggleEl.style.width = 'auto';
      toggleEl.style.height = '46px';
      toggleEl.style.padding = '0 18px';
      toggleEl.style.borderRadius = '9999px';
      toggleEl.style.gap = '8px';
      var lblSpan = document.createElement('span');
      lblSpan.setAttribute('data-testid', 'widget-launcher-label');
      lblSpan.style.cssText = 'font-size:13px;font-weight:600;white-space:nowrap;';
      lblSpan.textContent = labelText;
      toggleEl.appendChild(lblSpan);
    } else {
      toggleEl.style.width = '56px';
      toggleEl.style.height = '56px';
      toggleEl.style.padding = '0';
      toggleEl.style.borderRadius = '28px';
      toggleEl.style.gap = '0';
    }
    toggleEl.style.background = bgCss;
  }

  // Shared safe appearance renderer for both the live widget and transport-free Studio preview.
  function renderWidgetAppearance(view, appearance, onPrompt, strings) {
    var app = appearance || {};
    var prefix = view.preview ? 'widget-preview-' : 'widget-';
    var color = sanitizeHexColor(app.primaryColor, '#2563eb');
    var secondaryColor = sanitizeHexColor(app.secondaryColor, '#1d4ed8');
    var headerBg = app.headerStyle === 'gradient'
      ? 'linear-gradient(135deg,' + color + ',' + secondaryColor + ')'
      : color;
    var isDark = app.theme === 'dark';
    var radiusMap = { sharp: '6px', rounded: '16px', pill: '24px' };
    var boxRadius = radiusMap[app.borderRadius] || '16px';
    var chipRadius = app.borderRadius === 'sharp' ? '4px' : (app.borderRadius === 'pill' ? '9999px' : '12px');
    var fontStack = FONT_STACKS[app.fontFamily] || FONT_STACKS.system;

    view.box.style.borderRadius = boxRadius;
    view.box.style.fontFamily = fontStack;
    if (view.root) view.root.style.fontFamily = fontStack;

    // Widget size
    var sizeMap = view.preview
      ? { compact: ['340px', '440px'], standard: ['380px', '500px'], large: ['420px', '540px'] }
      : { compact: ['340px', '460px'], standard: ['380px', '540px'], large: ['420px', '600px'] };
    var dims = sizeMap[app.widgetSize] || sizeMap.standard;
    if (view.preview) {
      view.box.style.maxWidth = dims[0];
      view.box.style.height = dims[1];
    } else {
      view.box.style.width = dims[0];
      view.box.style.height = dims[1];
    }

    // Theme surface colors
    view.box.style.background = isDark ? '#111827' : '#ffffff';
    view.box.style.borderColor = isDark ? '#1f2937' : '#e5e7eb';
    view.body.style.background = isDark ? '#0f172a' : '#f9fafb';
    if (view.footer) {
      view.footer.style.background = isDark ? '#111827' : '#ffffff';
      view.footer.style.borderTopColor = isDark ? '#1f2937' : '#e5e7eb';
    }
    if (view.input) {
      view.input.style.background = isDark ? '#1e293b' : (view.preview ? '#f9fafb' : '#ffffff');
      view.input.style.borderColor = isDark ? '#334155' : '#d1d5db';
      view.input.style.color = isDark ? '#f8fafc' : '#111827';
      view.input.placeholder = (typeof app.inputPlaceholder === 'string' && app.inputPlaceholder.trim())
        ? app.inputPlaceholder.trim()
        : ((strings && strings.placeholder) || 'Type your message...');
    }

    view.header.style.background = headerBg;
    view.send.style.background = headerBg;
    view.send.textContent = (typeof app.sendButtonLabel === 'string' && app.sendButtonLabel.trim())
      ? app.sendButtonLabel.trim()
      : ((strings && strings.send) || 'Send');
    renderLauncherButton(view.toggle, app, headerBg);

    if (typeof app.title === 'string') view.title.textContent = app.title;

    // Header avatar + status dot + subtitle
    if (view.avatarEl) {
      var preset = app.avatarPreset || 'bot';
      if (preset !== 'none' && AVATAR_SVGS[preset]) {
        view.avatarEl.style.display = 'inline-flex';
        if (view.avatarIcon) {
          view.avatarIcon.innerHTML = AVATAR_SVGS[preset];
        }
      } else {
        view.avatarEl.style.display = 'none';
        if (view.avatarIcon) {
          view.avatarIcon.innerHTML = '';
        }
      }
    }
    if (view.statusDot) {
      view.statusDot.style.display = app.showStatusDot === false ? 'none' : 'inline-block';
    }
    if (view.subtitleEl) {
      var subText = typeof app.subtitle === 'string' ? app.subtitle.trim() : '';
      if (subText) {
        view.subtitleEl.textContent = subText;
        view.subtitleEl.style.display = 'block';
      } else {
        view.subtitleEl.textContent = '';
        view.subtitleEl.style.display = 'none';
      }
    }

    if (view.root && app.position) applyPosition(view.root, view.box, app.position, app.edgeOffsetPx);

    var oldWelcome = view.body.querySelector('[data-appearance-welcome]');
    if (oldWelcome) oldWelcome.remove();
    if (app.welcomeMessage && (view.preview || view.body.children.length === 0)) {
      var welcome = document.createElement('div');
      welcome.setAttribute('data-appearance-welcome', 'true');
      welcome.setAttribute('data-testid', view.preview ? prefix + 'welcome' : 'widget-welcome-message');
      welcome.style.cssText = 'align-self:flex-start;max-width:85%;padding:10px 14px;background:' +
        (isDark ? '#1e293b' : '#e5e7eb') + ';color:' + (isDark ? '#f1f5f9' : '#1f2937') +
        ';border-radius:16px 16px 16px 2px;word-break:break-word;font-size:13px;';
      welcome.textContent = app.welcomeMessage;
      view.body.prepend(welcome);
    }

    var oldPrompts = view.box.querySelector('[data-appearance-prompts]');
    if (oldPrompts) oldPrompts.remove();
    if (Array.isArray(app.quickPrompts) && app.quickPrompts.length > 0) {
      var prompts = document.createElement('div');
      prompts.setAttribute('data-appearance-prompts', 'true');
      prompts.setAttribute('data-testid', prefix + 'quick-prompts');
      prompts.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;padding:6px 12px;background:' +
        (isDark ? '#111827' : '#ffffff') + ';border-top:1px solid ' + (isDark ? '#1f2937' : '#f3f4f6') + ';';
      app.quickPrompts.forEach(function(text, index) {
        var button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-testid', view.preview ? prefix + 'quick-prompt-' + index : 'widget-quick-prompt');
        button.textContent = text;
        button.style.cssText = 'padding:4px 10px;background:' + (isDark ? '#1e293b' : '#f3f4f6') +
          ';border:1px solid ' + (isDark ? '#334155' : '#d1d5db') + ';border-radius:' + chipRadius +
          ';font-size:11px;color:' + (isDark ? '#e2e8f0' : '#374151') + ';cursor:pointer;';
        button.disabled = !onPrompt;
        if (onPrompt) button.addEventListener('click', function() { onPrompt(text); });
        prompts.appendChild(button);
      });
      view.box.insertBefore(prompts, view.footer);
    }

    if (view.poweredByEl) {
      view.poweredByEl.style.display = app.showPoweredBy === false ? 'none' : 'block';
      view.poweredByEl.style.background = isDark ? '#111827' : '#ffffff';
      view.poweredByEl.style.color = isDark ? '#64748b' : '#9ca3af';
    }
  }

  function createHeaderIdentity(isPreview, titleText) {
    var left = document.createElement('div');
    left.style.cssText = 'display:flex;align-items:center;gap:10px;min-width:0;flex:1;';

    var avatarWrap = document.createElement('div');
    avatarWrap.style.cssText = 'position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:50%;background:rgba(255,255,255,0.18);flex-shrink:0;';

    var avatarIcon = document.createElement('span');
    avatarIcon.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;';
    avatarWrap.appendChild(avatarIcon);

    var statusDot = document.createElement('span');
    statusDot.setAttribute('data-testid', isPreview ? 'widget-preview-status-dot' : 'widget-status-dot');
    statusDot.style.cssText = 'position:absolute;bottom:0;right:0;width:9px;height:9px;border-radius:50%;background:#22c55e;border:2px solid rgba(0,0,0,0.2);';
    avatarWrap.appendChild(statusDot);

    var textCol = document.createElement('div');
    textCol.style.cssText = 'display:flex;flex-direction:column;min-width:0;';

    var titleEl = document.createElement('span');
    titleEl.setAttribute('data-testid', isPreview ? 'widget-preview-title' : 'widget-title');
    titleEl.style.cssText = 'font-weight:600;font-size:15px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    titleEl.textContent = titleText;

    var subtitleEl = document.createElement('span');
    subtitleEl.setAttribute('data-testid', isPreview ? 'widget-preview-subtitle' : 'widget-subtitle');
    subtitleEl.style.cssText = 'display:none;font-size:11px;font-weight:400;opacity:0.88;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;';

    textCol.appendChild(titleEl);
    textCol.appendChild(subtitleEl);
    left.appendChild(avatarWrap);
    left.appendChild(textCol);

    return {
      container: left,
      avatarEl: avatarWrap,
      avatarIcon: avatarIcon,
      statusDot: statusDot,
      titleEl: titleEl,
      subtitleEl: subtitleEl,
    };
  }

  function createPoweredByFooter(isPreview) {
    var el = document.createElement('div');
    el.setAttribute('data-testid', isPreview ? 'widget-preview-powered-by' : 'widget-powered-by');
    el.style.cssText = 'text-align:center;font-size:10px;padding:4px 12px 6px;color:#9ca3af;background:#ffffff;';
    el.textContent = 'Powered by FreeLLMAPI';
    return el;
  }

  window.FreeLLMAPISupport = {
    _instance: (window.FreeLLMAPISupport && window.FreeLLMAPISupport._instance) || null,
    preview: function(container, publicConfig) {
      if (!container) return { destroy: function() {} };
      var locale = (publicConfig && publicConfig.locale === 'vi') ? 'vi' : 'en';
      var strings = i18n[locale] || i18n.en;
      var appearance = (publicConfig && publicConfig.appearance) || {};
      var primaryColor = sanitizeHexColor(appearance.primaryColor, '#2563eb');
      var titleText = appearance.title || strings.title;
      var intake = (publicConfig && publicConfig.intake) || { required: false, fields: [] };
      var fields = Array.isArray(intake.fields) ? intake.fields : [];

      var previewRoot = document.createElement('div');
      previewRoot.className = 'freellmapi-support-preview-root';
      previewRoot.setAttribute('data-testid', 'widget-preview-box');
      previewRoot.style.cssText = 'width:100%;max-width:380px;height:500px;background:#fff;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.15);display:flex;flex-direction:column;overflow:hidden;border:1px solid #e5e7eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:14px;';

      // Header
      var header = document.createElement('div');
      header.style.cssText = 'background:' + primaryColor + ';color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:15px;gap:8px;';
      var identity = createHeaderIdentity(true, titleText);
      header.appendChild(identity.container);

      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.setAttribute('data-testid', 'widget-preview-close-btn');
      closeBtn.textContent = '×';
      closeBtn.style.cssText = 'background:none;border:none;color:#fff;font-size:22px;cursor:pointer;line-height:1;flex-shrink:0;';
      header.appendChild(closeBtn);
      previewRoot.appendChild(header);

      // Body Area
      var bodyArea = document.createElement('div');
      bodyArea.style.cssText = 'flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;background:#f9fafb;';

      if (fields.length > 0) {
        var intakeBox = document.createElement('div');
        intakeBox.setAttribute('data-testid', 'widget-preview-intake');
        intakeBox.style.cssText = 'background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;';

        var intakeTitle = document.createElement('div');
        intakeTitle.style.cssText = 'font-weight:600;font-size:13px;color:#374151;';
        intakeTitle.textContent = strings.intakeHeading;
        intakeBox.appendChild(intakeTitle);

        for (var fi = 0; fi < fields.length; fi++) {
          var fld = fields[fi];
          var fg = document.createElement('div');
          fg.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
          var lbl = document.createElement('label');
          lbl.style.cssText = 'font-size:11px;font-weight:600;color:#4b5563;';
          lbl.textContent = fld.label + (fld.required ? ' *' : '');
          fg.appendChild(lbl);

          if (fld.type === 'select') {
            var sel = document.createElement('select');
            sel.style.cssText = 'padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#fff;';
            var dOpt = document.createElement('option');
            dOpt.textContent = '-- Select --';
            sel.appendChild(dOpt);
            var fOpts = fld.options || [];
            for (var fo = 0; fo < fOpts.length; fo++) {
              var optE = document.createElement('option');
              optE.textContent = fOpts[fo];
              sel.appendChild(optE);
            }
            fg.appendChild(sel);
          } else {
            var inp = document.createElement('input');
            inp.type = fld.type === 'number' ? 'number' : (fld.type === 'email' ? 'email' : 'text');
            inp.disabled = true;
            inp.style.cssText = 'padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;background:#f9fafb;';
            fg.appendChild(inp);
          }
          intakeBox.appendChild(fg);
        }

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
        var sBtn = document.createElement('button');
        sBtn.type = 'button';
        sBtn.textContent = strings.intakeSubmit;
        sBtn.style.cssText = 'flex:1;padding:6px 12px;background:' + primaryColor + ';color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:default;';
        btnRow.appendChild(sBtn);
        if (!intake.required) {
          var skipBtn = document.createElement('button');
          skipBtn.type = 'button';
          skipBtn.textContent = strings.intakeSkip;
          skipBtn.style.cssText = 'padding:6px 12px;background:#e5e7eb;color:#374151;border:none;border-radius:6px;font-size:12px;cursor:default;';
          btnRow.appendChild(skipBtn);
        }
        intakeBox.appendChild(btnRow);
        bodyArea.appendChild(intakeBox);
      }

      previewRoot.appendChild(bodyArea);

      // Footer
      var footer = document.createElement('div');
      footer.style.cssText = 'display:flex;padding:12px;background:#fff;border-top:1px solid #e5e7eb;gap:8px;';
      var mockInput = document.createElement('input');
      mockInput.type = 'text';
      mockInput.disabled = true;
      mockInput.placeholder = strings.placeholder;
      mockInput.style.cssText = 'flex:1;padding:8px 12px;border:1px solid #d1d5db;border-radius:20px;font-size:13px;background:#f9fafb;';
      var mockSend = document.createElement('button');
      mockSend.type = 'button';
      mockSend.disabled = true;
      mockSend.textContent = strings.send;
      mockSend.style.cssText = 'padding:8px 14px;background:' + primaryColor + ';color:#fff;border:none;border-radius:20px;font-size:13px;opacity:0.7;';
      footer.appendChild(mockInput);
      footer.appendChild(mockSend);
      previewRoot.appendChild(footer);

      var previewPoweredBy = createPoweredByFooter(true);
      previewRoot.appendChild(previewPoweredBy);

      var previewWrapper = document.createElement('div');
      previewWrapper.style.cssText = 'display:flex;flex-direction:column;gap:12px;width:100%;';
      previewWrapper.appendChild(previewRoot);

      var launcherRow = document.createElement('div');
      launcherRow.style.cssText = 'display:flex;width:100%;max-width:380px;justify-content:' +
        (appearance.position === 'bottom-left' ? 'flex-start' : 'flex-end') + ';';
      var previewToggle = document.createElement('button');
      previewToggle.type = 'button';
      previewToggle.setAttribute('data-testid', 'widget-preview-launcher');
      previewToggle.style.cssText = 'color:#fff;border:none;box-shadow:0 4px 14px rgba(0,0,0,0.22);cursor:default;display:inline-flex;align-items:center;justify-content:center;';
      launcherRow.appendChild(previewToggle);
      previewWrapper.appendChild(launcherRow);

      renderWidgetAppearance({
        header: header,
        title: identity.titleEl,
        subtitleEl: identity.subtitleEl,
        avatarEl: identity.avatarEl,
        avatarIcon: identity.avatarIcon,
        statusDot: identity.statusDot,
        send: mockSend,
        input: mockInput,
        body: bodyArea,
        box: previewRoot,
        footer: footer,
        poweredByEl: previewPoweredBy,
        toggle: previewToggle,
        preview: true
      }, appearance, null, strings);
      container.appendChild(previewWrapper);

      return {
        destroy: function() {
          if (previewWrapper && previewWrapper.parentNode) {
            previewWrapper.parentNode.removeChild(previewWrapper);
          }
        }
      };
    },
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

      var endpoint = config.endpoint ? resolveUrl(config.endpoint) : resolveUrl('/thruline/v1/support/chat');
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
      var activeReceiptId = null;
      var currentIntakeConfig = null;
      var currentConfigVersion = 1;
      var profileLoadFailed = false;
      var conversationId = null;
      var isOpen = false;
      var autoOpenScheduled = false;
      var autoOpenTimer = null;
      var isEscalated = false;
      var renderedMessageIds = {};
      var renderedRequestIds = {};
      var renderedAssistantNodes = {};
      var renderedNotices = {};
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
      activeReceiptId = readStored('intake_receipt') || null;

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
      header.style.cssText = 'background:' + primaryColor + ';color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:15px;gap:8px;';

      var liveIdentity = createHeaderIdentity(false, titleText);
      var headerTitle = liveIdentity.titleEl;

      var headerActions = document.createElement('div');
      headerActions.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';

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
      header.appendChild(liveIdentity.container);
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

      var intakeContainer = document.createElement('div');
      intakeContainer.id = 'freellmapi-support-intake';
      intakeContainer.setAttribute('data-testid', 'widget-intake-form');
      intakeContainer.style.cssText = 'display:none;flex:1;overflow-y:auto;padding:16px;background:#f9fafb;flex-direction:column;gap:12px;';

      var livePoweredBy = createPoweredByFooter(false);

      box.appendChild(header);
      box.appendChild(bannerBox);
      box.appendChild(intakeContainer);
      box.appendChild(msgList);
      box.appendChild(form);
      box.appendChild(livePoweredBy);
      root.appendChild(box);
      root.appendChild(toggleBtn);
      document.body.appendChild(root);

      function showLiveIntakeForm(intakeCfg, cfgVer) {
        renderLiveIntakeForm(intakeCfg, cfgVer);
        msgList.style.display = 'none';
        form.style.display = 'none';
        intakeContainer.style.display = 'flex';
      }

      function hideLiveIntakeForm() {
        intakeContainer.style.display = 'none';
        msgList.style.display = 'flex';
        form.style.display = 'flex';
        msgList.scrollTop = msgList.scrollHeight;
      }

      function renderLiveIntakeForm(intakeCfg, cfgVersion) {
        intakeContainer.innerHTML = '';
        var fields = (intakeCfg && intakeCfg.fields) || [];

        var heading = document.createElement('div');
        heading.style.cssText = 'font-weight:600;font-size:14px;color:#1f2937;margin-bottom:4px;';
        heading.textContent = strings.intakeHeading;
        intakeContainer.appendChild(heading);

        var inputsMap = {};
        var pendingIntake = null;
        var errorsMap = {};

        for (var i = 0; i < fields.length; i++) {
          (function(fld) {
            var fg = document.createElement('div');
            fg.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

            var lbl = document.createElement('label');
            lbl.style.cssText = 'font-size:12px;font-weight:600;color:#374151;';
            lbl.textContent = fld.label + (fld.required ? ' *' : '');
            fg.appendChild(lbl);

            var inp;
            if (fld.type === 'select') {
              inp = document.createElement('select');
              inp.setAttribute('data-testid', 'widget-intake-select-' + fld.key);
              inp.name = fld.key;
              inp.style.cssText = 'padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;background:#fff;';
              var dOpt = document.createElement('option');
              dOpt.value = '';
              dOpt.textContent = '-- ' + (strings.intakeSelectPlaceholder || 'Select') + ' --';
              inp.appendChild(dOpt);
              var fOpts = fld.options || [];
              for (var fo = 0; fo < fOpts.length; fo++) {
                var opt = document.createElement('option');
                opt.value = fOpts[fo];
                opt.textContent = fOpts[fo]; // SAFE TEXT
                inp.appendChild(opt);
              }
            } else {
              inp = document.createElement('input');
              inp.type = fld.type === 'number' ? 'number' : (fld.type === 'email' ? 'email' : 'text');
              inp.setAttribute('data-testid', 'widget-intake-input-' + fld.key);
              inp.name = fld.key;
              inp.style.cssText = 'padding:8px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;';
            }
            inp.id = 'freellmapi-intake-' + fld.key;
            lbl.htmlFor = inp.id;
            inp.required = !!fld.required;
            inputsMap[fld.key] = inp;
            fg.appendChild(inp);

            var errEl = document.createElement('div');
            errEl.setAttribute('data-testid', 'widget-intake-error-' + fld.key);
            errEl.style.cssText = 'color:#dc2626;font-size:11px;min-height:14px;';
            errorsMap[fld.key] = errEl;
            fg.appendChild(errEl);

            intakeContainer.appendChild(fg);
          })(fields[i]);
        }

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

        var submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.setAttribute('data-testid', 'widget-intake-submit-btn');
        submitBtn.textContent = strings.intakeSubmit;
        submitBtn.style.cssText = 'flex:1;padding:8px 16px;background:' + primaryColor + ';color:#fff;border:none;border-radius:8px;font-weight:600;cursor:pointer;';
        btnRow.appendChild(submitBtn);

        if (!intakeCfg.required) {
          var skipBtn = document.createElement('button');
          skipBtn.type = 'button';
          skipBtn.setAttribute('data-testid', 'widget-intake-skip-btn');
          skipBtn.textContent = strings.intakeSkip;
          skipBtn.style.cssText = 'padding:8px 16px;background:#e5e7eb;color:#374151;border:none;border-radius:8px;font-weight:500;cursor:pointer;';
          skipBtn.addEventListener('click', function() {
            hideLiveIntakeForm();
          });
          btnRow.appendChild(skipBtn);
        }

        intakeContainer.appendChild(btnRow);

        submitBtn.addEventListener('click', function() {
          var hasError = false;
          var values = {};

          for (var k = 0; k < fields.length; k++) {
            var f = fields[k];
            var inputEl = inputsMap[f.key];
            var errEl = errorsMap[f.key];
            errEl.textContent = '';
            var val = inputEl ? inputEl.value.trim() : '';

            if (f.required && !val) {
              errEl.textContent = strings.intakeRequiredField;
              hasError = true;
              continue;
            }

            if (val) {
              if (f.type === 'email') {
                if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(val)) {
                  errEl.textContent = strings.intakeInvalidEmail;
                  hasError = true;
                  continue;
                }
                values[f.key] = val;
              } else if (f.type === 'number') {
                var num = Number(val);
                if (isNaN(num) || !isFinite(num)) {
                  errEl.textContent = strings.intakeInvalidNumber;
                  hasError = true;
                  continue;
                }
                values[f.key] = num;
              } else if (f.type === 'select') {
                if (!f.options || f.options.indexOf(val) === -1) {
                  errEl.textContent = strings.intakeInvalidSelect;
                  hasError = true;
                  continue;
                }
                values[f.key] = val;
              } else {
                values[f.key] = val;
              }
            }
          }

          if (hasError) return;

          submitBtn.disabled = true;
          submitBtn.textContent = strings.intakeSubmitting;

          var epoch = identityEpoch;
          var tokenPromise = (!activeToken && allowGuestSession) ? renewGuestSession() : Promise.resolve(activeToken);

          tokenPromise
          .then(function(tok) {
            if (destroyed || epoch !== identityEpoch) return null;
            var ctrl = trackAbortController();
            var headers = {
              'Content-Type': 'application/json',
              'X-Support-Tenant-Key': tenantKey
            };
            if (tok) headers['X-Support-Context-Token'] = tok;

            var serializedValues = JSON.stringify(values);
            if (!pendingIntake || pendingIntake.values !== serializedValues) {
              pendingIntake = {values: serializedValues, requestId: 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9)};
            }
            var intakeReqId = pendingIntake.requestId;
            return fetch(resolveUrl('/thruline/v1/support/widget/intake'), {
              method: 'POST',
              headers: headers,
              body: JSON.stringify({
                requestId: intakeReqId,
                configVersion: cfgVersion || 1,
                values: values,
                conversationId: conversationId || undefined
              }),
              signal: ctrl.signal
            })
            .then(function(res) {
              untrackAbortController(ctrl);
              if (destroyed || epoch !== identityEpoch) return null;
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
            if (!data || destroyed || epoch !== identityEpoch) return;
            var receipt = data.receipt;
            if (receipt && receipt.intakeReceiptId) {
              activeReceiptId = receipt.intakeReceiptId;
              writeStored('intake_receipt', activeReceiptId);
              writeStored('intake_schema_hash', receipt.schemaHash || intakeCfg.schemaHash);
              hideLiveIntakeForm();
              setBanner('', '');
            }
          })
          .catch(function(err) {
            if (destroyed || epoch !== identityEpoch) return;
            submitBtn.disabled = false;
            submitBtn.textContent = strings.intakeSubmit;
            if (err && err.status === 409 && err.data && err.data.error &&
                (err.data.error.code === 'widget_config_changed' || err.data.error.code === 'intake_schema_changed')) {
              activeReceiptId = null;
              writeStored('intake_receipt', '');
              writeStored('intake_schema_hash', '');
              ensureAndShowIntakeForm(true);
              return;
            }
            if (err && err.data && err.data.error && err.data.error.fields) {
              var fErrors = err.data.error.fields;
              for (var fk in fErrors) {
                if (errorsMap[fk]) errorsMap[fk].textContent = fErrors[fk];
              }
            } else {
              setBanner(strings.networkError, 'error');
            }
          });
        });
      }

      function ensureAndShowIntakeForm(refresh) {
        if (!refresh && currentIntakeConfig && currentIntakeConfig.fields && currentIntakeConfig.fields.length > 0) {
          showLiveIntakeForm(currentIntakeConfig, currentConfigVersion);
        } else {
          fetchTenantProfile().then(function(res) {
            if (res && res.config && res.config.intake && res.config.intake.fields && res.config.intake.fields.length > 0) {
              showLiveIntakeForm(res.config.intake, res.config.version);
            }
          });
        }
      }

      bannerBox.addEventListener('click', function() {
        if (profileLoadFailed && !destroyed) fetchTenantProfile();
      });
      bannerBox.addEventListener('keydown', function(event) {
        if (profileLoadFailed && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          fetchTenantProfile();
        }
      });

      function fetchTenantProfile() {
        var epoch = identityEpoch;
        var ctrl = trackAbortController();
        var pHeaders = {
          'X-Support-Tenant-Key': tenantKey
        };
        if (activeToken) pHeaders['X-Support-Context-Token'] = activeToken;

        return fetch(resolveUrl('/thruline/v1/support/widget/config'), {
          method: 'GET',
          headers: pHeaders,
          signal: ctrl.signal
        })
        .then(function(res) {
          untrackAbortController(ctrl);
          if (!res.ok) throw new Error('config_load_error_' + res.status);
          return res.json();
        })
        .then(function(data) {
          if (destroyed || epoch !== identityEpoch) return null;
          if (data && data.config) {
            applyPublicConfig(data.config);
          }
          return data;
        })
        .catch(function(err) {
          untrackAbortController(ctrl);
          if (destroyed || epoch !== identityEpoch || (err && err.name === 'AbortError')) return null;
          profileLoadFailed = true;
          bannerBox.setAttribute('role', 'button');
          bannerBox.tabIndex = 0;
          setBanner(strings.intakeLoadError, 'error');
          return null;
        });
      }

      function applyPublicConfig(pubConfig) {
        if (!pubConfig) return;
        profileLoadFailed = false;
        bannerBox.setAttribute('role', 'status');
        bannerBox.removeAttribute('tabindex');
        if (pubConfig.enabled === false || !pubConfig.intake || !pubConfig.intake.fields.length) {
          activeReceiptId = null;
          currentIntakeConfig = null;
          writeStored('intake_receipt', '');
          writeStored('intake_schema_hash', '');
          hideLiveIntakeForm();
          if (pubConfig.enabled === false) return;
        }
        if (pubConfig.appearance) {
          primaryColor = sanitizeHexColor(pubConfig.appearance.primaryColor, primaryColor);
          renderWidgetAppearance({
            root: root,
            box: box,
            header: header,
            title: headerTitle,
            subtitleEl: liveIdentity.subtitleEl,
            avatarEl: liveIdentity.avatarEl,
            avatarIcon: liveIdentity.avatarIcon,
            statusDot: liveIdentity.statusDot,
            send: sendBtn,
            input: input,
            toggle: toggleBtn,
            body: msgList,
            footer: form,
            poweredByEl: livePoweredBy,
            preview: false
          },
          pubConfig.appearance, function(text) {
            input.value = text;
            form.dispatchEvent(new Event('submit'));
          }, strings);
          if (
            typeof pubConfig.appearance.autoOpenDelaySeconds === 'number' &&
            pubConfig.appearance.autoOpenDelaySeconds > 0 &&
            !isOpen &&
            !autoOpenScheduled
          ) {
            autoOpenScheduled = true;
            autoOpenTimer = window.setTimeout(function() {
              if (!destroyed && !isOpen) {
                isOpen = true;
                box.style.display = 'flex';
              }
            }, pubConfig.appearance.autoOpenDelaySeconds * 1000);
          }
        }

        if (pubConfig.intake && Array.isArray(pubConfig.intake.fields) && pubConfig.intake.fields.length > 0) {
          currentIntakeConfig = pubConfig.intake;
          currentConfigVersion = pubConfig.version || 1;
          var storedReceipt = readStored('intake_receipt');
          var storedSchema = readStored('intake_schema_hash');
          if (storedReceipt && storedSchema === pubConfig.intake.schemaHash) {
            activeReceiptId = storedReceipt;
          } else {
            activeReceiptId = null;
            showLiveIntakeForm(pubConfig.intake, pubConfig.version);
          }
        }
      }

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

      function safeRenderNotice(reason, reqId) {
        var noticeBox = document.createElement('div');
        noticeBox.className = 'freellmapi-notice';
        noticeBox.setAttribute('data-testid', 'widget-response-notice');
        noticeBox.setAttribute('data-role', 'system-notice');
        noticeBox.style.cssText = 'align-self:flex-start;max-width:85%;padding:10px 14px;background:#f3f4f6;color:#374151;border:1px solid #d1d5db;border-radius:12px;font-size:13px;line-height:1.4;';
        if (reqId) noticeBox.setAttribute('data-request-id', reqId);

        var label = document.createElement('div');
        label.setAttribute('data-testid', 'widget-non-ai-status');
        label.style.cssText = 'font-weight:600;font-size:11px;color:#6b7280;margin-bottom:4px;text-transform:uppercase;letter-spacing:0.05em;';
        label.textContent = strings.nonAiNotice;
        noticeBox.appendChild(label);

        var text = document.createElement('div');
        var msg = strings.knowledgeNoticeNoMatches;
        if (reason === 'invalid_citations') msg = strings.knowledgeNoticeInvalidCitations;
        else if (reason === 'sources_changed') msg = strings.knowledgeNoticeSourcesChanged;
        else if (reason === 'source_revoked') msg = strings.knowledgeNoticeSourceRevoked;
        text.textContent = msg; // SAFE TEXT - NO innerHTML
        noticeBox.appendChild(text);

        msgList.appendChild(noticeBox);
        msgList.scrollTop = msgList.scrollHeight;
        return noticeBox;
      }

      function safeRenderCitations(containerEl, citations) {
        if (!citations || !citations.length) return;
        var citeWrap = document.createElement('div');
        citeWrap.setAttribute('data-testid', 'widget-citations-container');
        citeWrap.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,0.1);display:flex;flex-direction:column;gap:6px;';

        var headerSpan = document.createElement('span');
        headerSpan.style.cssText = 'font-size:11px;font-weight:600;opacity:0.8;';
        headerSpan.textContent = strings.sourcesLabel;
        citeWrap.appendChild(headerSpan);

        for (var i = 0; i < citations.length; i++) {
          var c = citations[i];
          var card = document.createElement('div');
          card.setAttribute('data-testid', 'widget-citation-card');
          card.setAttribute('data-citation-id', c.id || '');
          card.setAttribute('data-ordinal', String(c.ordinal || (i + 1)));
          card.style.cssText = 'background:rgba(255,255,255,0.7);border:1px solid #d1d5db;border-radius:6px;padding:6px 8px;font-size:12px;color:#1f2937;';

          var titleEl = document.createElement('div');
          titleEl.style.cssText = 'font-weight:600;display:flex;gap:4px;align-items:center;';
          var numSpan = document.createElement('span');
          numSpan.style.cssText = 'color:' + primaryColor + ';';
          numSpan.textContent = '[' + (c.ordinal || (i + 1)) + ']';
          titleEl.appendChild(numSpan);
          var titleText = document.createElement('span');
          titleText.textContent = c.title || 'Source'; // SAFE TEXT
          titleEl.appendChild(titleText);
          card.appendChild(titleEl);

          if (c.excerpt) {
            var excerptEl = document.createElement('div');
            excerptEl.setAttribute('data-testid', 'widget-citation-excerpt');
            excerptEl.style.cssText = 'font-size:11px;color:#4b5563;margin-top:2px;font-style:italic;word-break:break-word;';
            excerptEl.textContent = c.excerpt; // SAFE TEXT
            card.appendChild(excerptEl);
          }

          citeWrap.appendChild(card);
        }

        containerEl.appendChild(citeWrap);
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

        fetch(resolveUrl('/thruline/v1/support/csat'), {
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
        return fetch(resolveUrl('/thruline/v1/support/guest-session'), {
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

      function processMessageItem(m) {
        if (!m) return;
        var mid = m.id || (m.createdAt + '_' + m.content);
        var reqId = m.requestId || (m.evidence && m.evidence.requestId) || (m.responseNotice && m.responseNotice.requestId);

        var isRedacted = m.evidence && (m.evidence.status === 'redacted' || m.evidence.reason === 'source_revoked');
        if (isRedacted) {
          var prevAssistant = (reqId && renderedAssistantNodes[reqId]) ||
                              renderedAssistantNodes[mid] ||
                              (reqId ? msgList.querySelector('.freellmapi-message-assistant[data-request-id="' + reqId + '"]') : null) ||
                              msgList.querySelector('.freellmapi-message-assistant[data-message-id="' + mid + '"]');
          if (prevAssistant && prevAssistant.parentNode) {
            prevAssistant.parentNode.removeChild(prevAssistant);
          }
          if (reqId) delete renderedAssistantNodes[reqId];
          delete renderedAssistantNodes[mid];

          var existingNotice = (reqId && renderedNotices[reqId]) || renderedNotices[mid];
          if (!existingNotice || !existingNotice.parentNode) {
            var noticeBox = safeRenderNotice('source_revoked', reqId);
            if (reqId) renderedNotices[reqId] = noticeBox;
            renderedNotices[mid] = noticeBox;
          }
          if (reqId) renderedRequestIds[reqId] = true;
          renderedMessageIds[mid] = true;
          return;
        }

        var isAbstained = (m.evidence && m.evidence.status === 'abstained') || !!m.responseNotice;
        if (isAbstained) {
          var reason = (m.evidence && m.evidence.reason) || (m.responseNotice && m.responseNotice.reason) || 'no_matches';
          var prevAssistant2 = (reqId && renderedAssistantNodes[reqId]) ||
                               renderedAssistantNodes[mid] ||
                               (reqId ? msgList.querySelector('.freellmapi-message-assistant[data-request-id="' + reqId + '"]') : null) ||
                               msgList.querySelector('.freellmapi-message-assistant[data-message-id="' + mid + '"]');
          if (prevAssistant2 && prevAssistant2.parentNode) {
            prevAssistant2.parentNode.removeChild(prevAssistant2);
          }
          if (reqId) delete renderedAssistantNodes[reqId];
          delete renderedAssistantNodes[mid];

          var existingNotice2 = (reqId && renderedNotices[reqId]) || renderedNotices[mid];
          if (!existingNotice2 || !existingNotice2.parentNode) {
            var noticeBox2 = safeRenderNotice(reason, reqId);
            if (reqId) renderedNotices[reqId] = noticeBox2;
            renderedNotices[mid] = noticeBox2;
          }
          if (reqId) renderedRequestIds[reqId] = true;
          renderedMessageIds[mid] = true;
          return;
        }

        if (reqId && renderedRequestIds[reqId]) {
          renderedMessageIds[mid] = true;
          if (renderedAssistantNodes[reqId]) {
            renderedAssistantNodes[mid] = renderedAssistantNodes[reqId];
          }
          return;
        }

        if (!renderedMessageIds[mid]) {
          renderedMessageIds[mid] = true;
          if (reqId) renderedRequestIds[reqId] = true;

          var role = m.senderType || m.role || 'user';
          if (role === 'human_agent' || role === 'staff' || role === 'agent') {
            safeRenderMessage('staff', m.content, m.senderName || 'Support Agent');
          } else if (role === 'ai_assistant' || role === 'assistant') {
            var assistantEl = safeRenderMessage('assistant', m.content);
            if (reqId) assistantEl.setAttribute('data-request-id', reqId);
            assistantEl.setAttribute('data-message-id', mid);
            if (reqId) renderedAssistantNodes[reqId] = assistantEl;
            renderedAssistantNodes[mid] = assistantEl;
            if (m.evidence && m.evidence.status === 'cited' && m.evidence.citations && m.evidence.citations.length > 0) {
              safeRenderCitations(assistantEl, m.evidence.citations);
            }
          } else if (role === 'user') {
            safeRenderMessage('user', m.content);
          }
        }
      }

      function resumeConversation(convId) {
        var epoch = identityEpoch;
        if (!convId) return;
        var ctrl = trackAbortController();
        var headers = {
          'X-Support-Tenant-Key': tenantKey
        };
        if (activeToken) headers['X-Support-Context-Token'] = activeToken;

        var p = fetch(resolveUrl('/thruline/v1/support/conversations/' + encodeURIComponent(convId)), {
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
            processMessageItem(msgs[i]);
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

        var fetchPromise = fetch(resolveUrl('/thruline/v1/support/conversations/' + encodeURIComponent(conversationId)), {
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
            processMessageItem(msgs[i]);
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

          var chatBody = {
            tenantKey: tenantKey,
            contextToken: tok || undefined,
            conversationId: convId || undefined,
            requestId: reqId,
            messages: [{ role: 'user', content: text }]
          };
          if (activeReceiptId) {
            chatBody.intakeReceiptId = activeReceiptId;
          }

          return fetch(endpoint, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(chatBody),
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
              activeReceiptId = null;
              renderedMessageIds = {};
              renderedRequestIds = {};
              renderedAssistantNodes = {};
              renderedNotices = {};
              msgList.textContent = '';
              return renewGuestSession().then(function() {
                identityEpoch++;
                safeRenderMessage('user', text);
                performSend(text, reqId, null, true);
                return null;
              });
            }
            if (res.status === 428) {
              return res.json().catch(function() { return {}; }).then(function() {
                activeReceiptId = null;
                writeStored('intake_receipt', '');
                writeStored('intake_schema_hash', '');
                sendBtn.disabled = false;
                input.disabled = false;
                setBanner(strings.intakeRequiredNotice, 'error');
                ensureAndShowIntakeForm(true);
                return null;
              });
            }
            if (res.status === 409) {
              return res.json().catch(function() { return {}; }).then(function(errData) {
                var code = (errData && errData.error && errData.error.code) || 'http_409';
                if (code === 'intake_schema_changed') {
                  activeReceiptId = null;
                  writeStored('intake_receipt', '');
                  writeStored('intake_schema_hash', '');
                  sendBtn.disabled = false;
                  input.disabled = false;
                  setBanner(strings.intakeRequiredNotice, 'error');
                  ensureAndShowIntakeForm(true);
                  return null;
                }
                var err = new Error(code);
                if (code === 'knowledge_context_changed') {
                  err.isContextChanged = true;
                }
                err.status = 409;
                err.data = errData;
                throw err;
              });
            }
            if (res.status === 410) {
              return res.json().catch(function() { return {}; }).then(function(errData) {
                var code = (errData && errData.error && errData.error.code) || 'http_410';
                if (code === 'intake_expired') {
                  activeReceiptId = null;
                  writeStored('intake_receipt', '');
                  writeStored('intake_schema_hash', '');
                  sendBtn.disabled = false;
                  input.disabled = false;
                  setBanner(strings.intakeRequiredNotice, 'error');
                  ensureAndShowIntakeForm(true);
                  return null;
                }
                var err = new Error(code);
                err.status = 410;
                err.data = errData;
                throw err;
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

          var isAbstained = data.runtime && (
            data.runtime.replySource === 'knowledge_abstention' ||
            (data.runtime.evidence && data.runtime.evidence.status === 'abstained')
          );

          if (isAbstained) {
            var reason = (data.runtime.evidence && data.runtime.evidence.reason) ||
                         (data.runtime.responseNotice && data.runtime.responseNotice.reason) ||
                         'no_matches';
            renderedRequestIds[reqId] = true;
            var noticeBox = safeRenderNotice(reason, reqId);
            renderedNotices[reqId] = noticeBox;
          } else {
            var reply = data.reply || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
            if (reply && !isEscalated) {
              renderedRequestIds[reqId] = true;
              var assistantEl = safeRenderMessage('assistant', reply);
              assistantEl.setAttribute('data-request-id', reqId);
              renderedAssistantNodes[reqId] = assistantEl;
              if (data.runtime && data.runtime.evidence && data.runtime.evidence.status === 'cited' && data.runtime.evidence.citations) {
                safeRenderCitations(assistantEl, data.runtime.evidence.citations);
              }
            }
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

          if (err && err.isContextChanged) {
            var ctxBox = document.createElement('div');
            ctxBox.setAttribute('data-testid', 'widget-context-changed-box');
            ctxBox.style.cssText = 'align-self:flex-start;padding:8px 12px;background:#fef3c7;color:#92400e;border:1px solid #fde68a;border-radius:8px;font-size:12px;display:flex;align-items:center;gap:8px;';

            var ctxText = document.createElement('span');
            ctxText.textContent = strings.contextChanged;
            ctxBox.appendChild(ctxText);

            var freshRetryBtn = document.createElement('button');
            freshRetryBtn.type = 'button';
            freshRetryBtn.setAttribute('data-testid', 'widget-fresh-retry-btn');
            freshRetryBtn.textContent = strings.freshRetry;
            freshRetryBtn.style.cssText = 'padding:2px 8px;background:#d97706;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:500;';
            freshRetryBtn.addEventListener('click', function() {
              ctxBox.remove();
              var freshRequestId = 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
              performSend(turn.text, freshRequestId, turn.conversationId);
            });
            ctxBox.appendChild(freshRetryBtn);

            msgList.appendChild(ctxBox);
            msgList.scrollTop = msgList.scrollHeight;
            return;
          }

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

        fetch(resolveUrl('/thruline/v1/support/escalate'), {
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

      if (config.loadTenantProfile === true) {
        fetchTenantProfile();
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
          if (autoOpenTimer) {
            window.clearTimeout(autoOpenTimer);
            autoOpenTimer = null;
          }

          // Clear prior messages and UI state
          msgList.innerHTML = '';
          bannerBox.style.display = 'none';
          bannerBox.textContent = '';
          renderedMessageIds = {};
          renderedRequestIds = {};
          renderedAssistantNodes = {};
          renderedNotices = {};
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
          activeReceiptId = null;

          if (intakeContainer) {
            intakeContainer.style.display = 'none';
            intakeContainer.innerHTML = '';
          }
          msgList.style.display = 'flex';
          form.style.display = 'flex';

          if (currentIntakeConfig && currentIntakeConfig.fields && currentIntakeConfig.fields.length > 0) {
            if (currentIntakeConfig.required) {
              showLiveIntakeForm(currentIntakeConfig, currentConfigVersion);
            }
          }

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
          renderedMessageIds = {};
          renderedRequestIds = {};
          renderedAssistantNodes = {};
          renderedNotices = {};
          abortAllRequests();
          stopPolling();
          if (autoOpenTimer) {
            window.clearTimeout(autoOpenTimer);
            autoOpenTimer = null;
          }
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
