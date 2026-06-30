// MAIN world 注入脚本
// Content Scripts 默认在 ISOLATED world，无法访问页面的 JS 变量和 WebSocket
// 这个脚本通过 <script> 标签注入到页面的 MAIN world 中

(function() {
  console.log('[TerminalCopilot:MAIN] Injected into page MAIN world');

  // ========== Hook WebSocket ==========
  const OrigWebSocket = window.WebSocket;
  const wsData = { messages: [], connections: [] };

  window.WebSocket = function(...args) {
    const ws = new OrigWebSocket(...args);
    console.log('[TerminalCopilot:MAIN] WebSocket created:', args[0]);
    wsData.connections.push(args[0]);

    const origSend = ws.send.bind(ws);
    ws.send = function(data) {
      let text = typeof data === 'string' ? data : '';
      if (text.length > 0 && text.length < 500) {
        wsData.messages.push({ dir: 'send', text, time: Date.now() });
        if (wsData.messages.length > 200) wsData.messages.shift();
      }
      return origSend(data);
    };

    ws.addEventListener('message', function(event) {
      let text = typeof event.data === 'string' ? event.data : '';
      if (text.length > 0 && text.length < 2000) {
        wsData.messages.push({ dir: 'recv', text, time: Date.now() });
        if (wsData.messages.length > 200) wsData.messages.shift();
      }
    });

    return ws;
  };
  window.WebSocket.prototype = OrigWebSocket.prototype;
  window.WebSocket.CONNECTING = OrigWebSocket.CONNECTING;
  window.WebSocket.OPEN = OrigWebSocket.OPEN;
  window.WebSocket.CLOSING = OrigWebSocket.CLOSING;
  window.WebSocket.CLOSED = OrigWebSocket.CLOSED;

  // ========== 查找 xterm 实例 ==========
  function findXtermInstance() {
    // 常见全局变量
    const globals = ['term', 'terminal', '_terminal', 'xtermInstance', 'xterm'];
    for (const name of globals) {
      if (window[name] && window[name].buffer) return { instance: window[name], source: `window.${name}` };
    }

    // 从 DOM 元素的 React/Vue 内部属性中查找
    const xtermEl = document.querySelector('.xterm');
    if (xtermEl) {
      // React fiber
      const reactKey = Object.keys(xtermEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
      if (reactKey) {
        let fiber = xtermEl[reactKey];
        let depth = 0;
        while (fiber && depth < 20) {
          const props = fiber.memoizedProps || fiber.pendingProps;
          if (props) {
            for (const [key, val] of Object.entries(props)) {
              if (val && typeof val === 'object' && val.buffer && typeof val.buffer === 'object') {
                return { instance: val, source: `react-fiber.${key}` };
              }
            }
          }
          if (fiber.stateNode && fiber.stateNode.buffer) {
            return { instance: fiber.stateNode, source: 'react-stateNode' };
          }
          fiber = fiber.return;
          depth++;
        }
      }
    }

    return null;
  }

  // ========== 暴露接口给 Content Script ==========
  // 通过 CustomEvent 在 MAIN world 和 ISOLATED world 之间通信

  window.addEventListener('termcopilot-request', function(event) {
    const { requestId, type, payload } = event.detail;

    let response = {};

    if (type === 'READ_BUFFER') {
      const found = findXtermInstance();
      if (found) {
        try {
          const buffer = found.instance.buffer.active || found.instance.buffer.normal;
          const lines = [];
          for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

          response = {
            success: true,
            source: found.source,
            lines,
            text: lines.join('\n'),
            rows: found.instance.rows,
            cols: found.instance.cols,
            cursorY: buffer.cursorY,
            cursorX: buffer.cursorX
          };
        } catch(e) {
          response = { success: false, error: e.message };
        }
      } else {
        response = { success: false, error: 'xterm instance not found' };
      }
    }

    if (type === 'INPUT_COMMAND') {
      const found = findXtermInstance();
      if (found && found.instance._core) {
        // 通过 xterm 内部 API 直接输入
        found.instance._core.coreService.triggerDataEvent(payload.command + '\r', true);
        response = { success: true, method: 'triggerDataEvent' };
      } else if (found && typeof found.instance.input === 'function') {
        found.instance.input(payload.command + '\r');
        response = { success: true, method: 'input' };
      } else {
        response = { success: false, error: 'no input method found' };
      }
    }

    if (type === 'GET_WS_DATA') {
      response = {
        connections: wsData.connections,
        recentMessages: wsData.messages.slice(-20),
        totalMessages: wsData.messages.length
      };
    }

    window.dispatchEvent(new CustomEvent('termcopilot-response', {
      detail: { requestId, response }
    }));
  });

  console.log('[TerminalCopilot:MAIN] Ready. Event bridge active.');
})();
