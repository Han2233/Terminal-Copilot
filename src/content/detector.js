// Terminal Copilot - Content Script
// 检测 Web 终端类型并读取终端内容

(function () {
  console.log('[TerminalCopilot] Content script loaded on:', window.location.href);

  // ========== 方法 1: 读取 xterm.js DOM ==========
  function readXtermDOM() {
    // xterm.js 渲染到 .xterm-rows 下的 span 元素
    const xtermRows = document.querySelector('.xterm-rows');
    if (!xtermRows) return null;

    const lines = [];
    const rowElements = xtermRows.children;
    for (let i = 0; i < rowElements.length; i++) {
      const row = rowElements[i];
      lines.push(row.textContent || '');
    }

    // 去掉尾部空行
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    return {
      method: 'xterm-dom',
      lines: lines,
      text: lines.join('\n'),
      rowCount: lines.length
    };
  }

  // ========== 方法 2: 通过 xterm.js 实例的 buffer API ==========
  function readXtermBuffer() {
    // 尝试从全局变量或 DOM 元素上找到 xterm Terminal 实例
    // 常见的挂载位置
    const candidates = [
      window.term,
      window.terminal,
      window._terminal,
      window.xtermInstance,
    ];

    // 尝试从 xterm 容器 DOM 元素上查找
    const xtermContainer = document.querySelector('.xterm');
    if (xtermContainer) {
      // xterm.js v4/v5 会在容器元素上挂载实例
      const keys = Object.keys(xtermContainer).filter(k => k.startsWith('_'));
      keys.forEach(k => {
        const val = xtermContainer[k];
        if (val && typeof val === 'object' && val.buffer) {
          candidates.push(val);
        }
      });
    }

    for (const term of candidates) {
      if (!term || !term.buffer) continue;

      try {
        const buffer = term.buffer.active || term.buffer.normal;
        const lines = [];
        for (let i = 0; i <= buffer.length - 1; i++) {
          const line = buffer.getLine(i);
          if (line) {
            lines.push(line.translateToString(true));
          }
        }

        while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
          lines.pop();
        }

        return {
          method: 'xterm-buffer',
          lines: lines,
          text: lines.join('\n'),
          rowCount: lines.length,
          cursorY: buffer.cursorY,
          cursorX: buffer.cursorX
        };
      } catch (e) {
        console.log('[TerminalCopilot] xterm buffer read failed:', e);
      }
    }

    return null;
  }

  // ========== 方法 3: 检测页面上所有可能的终端元素 ==========
  function detectTerminalElements() {
    const selectors = [
      '.xterm',
      '.xterm-screen',
      '.xterm-rows',
      '.terminal',
      '.terminal-container',
      '[class*="terminal"]',
      '[class*="xterm"]',
      '[class*="console"]',
      'canvas',                    // 有些终端用 canvas 渲染
      'iframe',                    // 终端可能在 iframe 里
    ];

    const found = {};
    selectors.forEach(sel => {
      const elements = document.querySelectorAll(sel);
      if (elements.length > 0) {
        found[sel] = {
          count: elements.length,
          details: Array.from(elements).map(el => ({
            tagName: el.tagName,
            className: el.className?.toString?.()?.substring(0, 200) || '',
            id: el.id || '',
            size: `${el.offsetWidth}x${el.offsetHeight}`,
            childCount: el.children.length,
            hasCanvas: el.querySelector('canvas') !== null,
            textLength: (el.textContent || '').length
          }))
        };
      }
    });

    return found;
  }

  // ========== 方法 4: 监听 WebSocket 通信 ==========
  let wsMessages = [];
  const MAX_WS_MESSAGES = 100;

  function hookWebSocket() {
    const OrigWebSocket = window.WebSocket;
    window.WebSocket = function (...args) {
      const ws = new OrigWebSocket(...args);
      console.log('[TerminalCopilot] WebSocket created:', args[0]);

      const origOnMessage = ws.onmessage;

      // 拦截通过 addEventListener 添加的消息处理
      const origAddEventListener = ws.addEventListener.bind(ws);
      ws.addEventListener = function (type, listener, options) {
        if (type === 'message') {
          const wrappedListener = function (event) {
            recordWSMessage('recv', event.data);
            return listener.call(this, event);
          };
          return origAddEventListener(type, wrappedListener, options);
        }
        return origAddEventListener(type, listener, options);
      };

      // 拦截 onmessage 属性
      Object.defineProperty(ws, 'onmessage', {
        set(handler) {
          origOnMessage;
          origAddEventListener('message', function (event) {
            recordWSMessage('recv', event.data);
            if (handler) handler.call(ws, event);
          });
        },
        get() { return origOnMessage; }
      });

      // 拦截 send
      const origSend = ws.send.bind(ws);
      ws.send = function (data) {
        recordWSMessage('send', data);
        return origSend(data);
      };

      return ws;
    };
    window.WebSocket.prototype = OrigWebSocket.prototype;

    console.log('[TerminalCopilot] WebSocket hook installed');
  }

  function recordWSMessage(direction, data) {
    let text = '';
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(data);
    } else if (data instanceof Blob) {
      // 异步处理 blob
      data.text().then(t => {
        wsMessages.push({ direction, text: t, time: Date.now() });
        if (wsMessages.length > MAX_WS_MESSAGES) wsMessages.shift();
      });
      return;
    }

    wsMessages.push({ direction, text, time: Date.now() });
    if (wsMessages.length > MAX_WS_MESSAGES) wsMessages.shift();
  }

  // ========== 向终端输入命令 ==========
  function typeToTerminal(command) {
    // 方法 1: 通过 xterm.js 实例的 input/write
    const termCandidates = [window.term, window.terminal, window._terminal];
    for (const term of termCandidates) {
      if (term && typeof term.input === 'function') {
        term.input(command + '\r');
        return { success: true, method: 'xterm-input' };
      }
      if (term && term._core && typeof term._core.handler === 'function') {
        term._core.handler(command + '\r');
        return { success: true, method: 'xterm-core-handler' };
      }
    }

    // 方法 2: 模拟键盘事件到 xterm textarea
    const xtermTextarea = document.querySelector('.xterm-helper-textarea');
    if (xtermTextarea) {
      xtermTextarea.focus();
      // 逐字符发送 keydown/keypress/keyup 事件
      for (const char of command) {
        const events = ['keydown', 'keypress', 'keyup'];
        events.forEach(type => {
          xtermTextarea.dispatchEvent(new KeyboardEvent(type, {
            key: char,
            code: `Key${char.toUpperCase()}`,
            charCode: char.charCodeAt(0),
            keyCode: char.charCodeAt(0),
            bubbles: true
          }));
        });
      }
      // 发送 Enter
      ['keydown', 'keypress', 'keyup'].forEach(type => {
        xtermTextarea.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          charCode: 13,
          keyCode: 13,
          bubbles: true
        }));
      });
      return { success: true, method: 'keyboard-events' };
    }

    return { success: false, method: 'none' };
  }

  // ========== 主逻辑：定期采集 + 响应消息 ==========

  // 页面加载时先 hook WebSocket（需要在 WS 连接建立之前）
  // 注意：content_scripts 运行在隔离的 world，可能无法 hook 页面的 WebSocket
  // 这里先尝试，如果不行后续改用 MAIN world 注入
  try {
    hookWebSocket();
  } catch (e) {
    console.log('[TerminalCopilot] WebSocket hook failed (expected in isolated world):', e);
  }

  // 监听来自 side panel / background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[TerminalCopilot] Received message:', message.type);

    if (message.type === 'READ_TERMINAL') {
      // 尝试所有方法读取终端
      const domResult = readXtermDOM();
      const bufferResult = readXtermBuffer();
      const elements = detectTerminalElements();

      sendResponse({
        success: true,
        url: window.location.href,
        timestamp: Date.now(),
        dom: domResult,
        buffer: bufferResult,
        elements: elements,
        wsMessageCount: wsMessages.length,
        recentWS: wsMessages.slice(-10)
      });
    }

    if (message.type === 'TYPE_COMMAND') {
      const result = typeToTerminal(message.command);
      sendResponse(result);
    }

    if (message.type === 'PING') {
      sendResponse({ alive: true, url: window.location.href });
    }

    return true; // 保持消息通道打开
  });

  // 通知 background 脚本已加载
  chrome.runtime.sendMessage({
    type: 'CONTENT_SCRIPT_LOADED',
    url: window.location.href
  }).catch(() => {});

  console.log('[TerminalCopilot] Detector initialized. Waiting for commands.');
})();
