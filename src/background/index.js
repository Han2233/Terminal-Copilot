const RELAY_URL = 'ws://localhost:9876/ws';
const RECONNECT_INTERVAL = 3000;
const DATA_TIMEOUT = 30000; // 30 秒无数据 = 视为死连接，强制重连

let ws = null;
let lastDataTime = 0; // 最后一次收到数据的时间戳
let reconnectTimer = null; // 防抖：同一时刻最多一个重连定时器
let pendingConfirms = new Map(); // 待确认的危险命令

function scheduleReconnect(delay) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectRelay, delay);
}

function connectRelay() {
  // 已经在连接中则跳过
  if (ws && ws.readyState <= 1) return;

  try {
    ws = new WebSocket(RELAY_URL);
  } catch (e) {
    console.log('[bg] WebSocket 创建失败:', e.message);
    scheduleReconnect(RECONNECT_INTERVAL);
    return;
  }

  ws.onopen = () => {
    console.log('[bg] 已连接到中继服务');
    lastDataTime = Date.now();
    chrome.action.setBadgeText({ text: 'ON' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  };

  ws.onclose = () => {
    console.log('[bg] 与中继服务断开，将重连...');
    chrome.action.setBadgeText({ text: '' });
    ws = null;
    scheduleReconnect(RECONNECT_INTERVAL);
  };

  // onerror 时也调度重连；如果 onclose 随之而来，scheduleReconnect 会防抖合并
  // 如果连接从未建立（ERR_CONNECTION_REFUSED），onclose 不会触发，靠这里兜底
  ws.onerror = () => {
    console.log('[bg] WebSocket 错误');
    ws = null;
    scheduleReconnect(RECONNECT_INTERVAL);
  };

  ws.onmessage = async (event) => {
    lastDataTime = Date.now();

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    const { requestId, type, command } = msg;

    // 响应服务端心跳
    if (type === 'ping') {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
      return;
    }

    if (type === 'read') {
      const result = await readTerminal();
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ requestId, ...result }));
      }
    }

    if (type === 'exec') {
      const result = await execCommand(command);
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ requestId, ...result }));
      }
    }

    // 危险命令确认请求：打开侧边栏等待用户批准
    if (type === 'confirm') {
      const { dangers } = msg;
      pendingConfirms.set(requestId, { command, dangers });

      // 打开侧边栏
      try {
        await chrome.sidePanel.open({ windowId: -1 }); // 当前窗口
        console.log('[bg] 已打开侧边栏，等待用户确认危险命令:', command);
      } catch (e) {
        console.log('[bg] 打开侧边栏失败:', e.message);
      }
    }
  };
}

// ========== 终端操作：复用 POC 中验证过的方法 ==========

async function getTerminalTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://shell.alibaba-inc.com/*' });
  return tabs.length > 0 ? tabs[0].id : null;
}

async function readTerminal() {
  const tabId = await getTerminalTabId();
  if (!tabId) return { error: '未找到终端页面' };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        // 读取 xterm.js DOM
        const xtermRows = document.querySelector('.xterm-rows');
        if (!xtermRows) return null;

        const lines = [];
        for (let i = 0; i < xtermRows.children.length; i++) {
          lines.push(xtermRows.children[i].textContent || '');
        }
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

        return {
          content: lines.join('\n'),
          lines: lines.length,
          method: 'xterm-dom'
        };
      }
    });

    for (const r of results) {
      if (r?.result?.content) return r.result;
    }
    return { error: '无法读取终端内容' };
  } catch (e) {
    return { error: e.message };
  }
}

async function execCommand(command) {
  const tabId = await getTerminalTabId();
  if (!tabId) return { error: '未找到终端页面' };

  // 1. 读取执行前的内容（用于对比提取新输出）
  const beforeRead = await readTerminal();
  const beforeLines = beforeRead.content ? beforeRead.content.split('\n').length : 0;

  // 2. 发送命令
  try {
    const sendResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (cmd) => {
        const textarea = document.querySelector('.xterm-helper-textarea');
        if (!textarea) return { success: false, error: 'no textarea' };

        textarea.focus();

        const dataTransfer = new DataTransfer();
        dataTransfer.setData('text/plain', cmd);
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dataTransfer,
        });
        textarea.dispatchEvent(pasteEvent);

        // 发送 Enter
        textarea.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
        }));

        return { success: true, method: 'paste+enter' };
      },
      args: [command],
      world: 'MAIN'
    });

    let sent = false;
    for (const r of sendResults) {
      if (r?.result?.success) { sent = true; break; }
    }

    if (!sent) {
      // 回退方案：用 keyboard event 逐字符输入
      const fallbackResults = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (cmd) => {
          const textarea = document.querySelector('.xterm-helper-textarea');
          if (!textarea) return { success: false };

          textarea.focus();
          for (const char of cmd) {
            textarea.dispatchEvent(new KeyboardEvent('keydown', {
              key: char, code: `Key${char.toUpperCase()}`,
              keyCode: char.charCodeAt(0), which: char.charCodeAt(0),
              bubbles: true
            }));
            textarea.dispatchEvent(new KeyboardEvent('keypress', {
              key: char, charCode: char.charCodeAt(0),
              keyCode: char.charCodeAt(0), bubbles: true
            }));
            textarea.dispatchEvent(new KeyboardEvent('keyup', {
              key: char, keyCode: char.charCodeAt(0), bubbles: true
            }));
          }
          textarea.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
          }));
          return { success: true, method: 'keyboard-events' };
        },
        args: [command],
        world: 'MAIN'
      });

      for (const r of fallbackResults) {
        if (r?.result?.success) { sent = true; break; }
      }
    }

    if (!sent) return { error: '命令发送失败' };

    // 3. 等待命令执行完成并读取输出
    // 轮询等待：终端内容变化后再读取
    await sleep(500);

    let output = '';
    let attempts = 0;
    const maxAttempts = 20; // 最多等 10 秒

    while (attempts < maxAttempts) {
      const afterRead = await readTerminal();
      if (afterRead.content) {
        const afterLines = afterRead.content.split('\n');
        // 提取新增的行（命令执行后的输出）
        if (afterLines.length > beforeLines) {
          output = afterLines.slice(beforeLines).join('\n');
        } else {
          output = afterRead.content;
        }

        // 检查是否出现新的命令提示符（说明命令执行完了）
        const lastLine = afterLines[afterLines.length - 1] || '';
        if (lastLine.match(/\$\s*$|#\s*$|\]\s*$/)) {
          break;
        }
      }
      attempts++;
      await sleep(500);
    }

    return {
      output: output || '(命令已执行，未捕获到输出)',
      method: 'exec-and-read'
    };

  } catch (e) {
    return { error: e.message };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ========== 启动 ==========

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// 监听侧边栏的确认结果
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONFIRM_RESPONSE') {
    const { requestId, approved } = message;
    const pending = pendingConfirms.get(requestId);
    if (pending && ws && ws.readyState === 1) {
      console.log(`[bg] 用户${approved ? '批准' : '拒绝'}危险命令: ${pending.command}`);
      ws.send(JSON.stringify({ requestId, approved }));
    }
    pendingConfirms.delete(requestId);
  }
  if (message.type === 'GET_PENDING_CONFIRMS') {
    const confirms = [];
    for (const [id, info] of pendingConfirms) {
      confirms.push({ requestId: id, command: info.command, dangers: info.dangers });
    }
    sendResponse({ confirms });
    return true; // 异步响应
  }
});

connectRelay();

// 定时重连检查 + 健康监控
setInterval(() => {
  const now = Date.now();

  // 检查 1: 连接是否断开
  if (!ws || ws.readyState > 1) {
    connectRelay();
    return;
  }

  // 检查 2: 连接是否"假活"——长时间无数据说明链路已死但 onclose 未触发
  if (ws.readyState === 1 && lastDataTime > 0 && (now - lastDataTime) > DATA_TIMEOUT) {
    console.log('[bg] 超过 ' + DATA_TIMEOUT/1000 + ' 秒未收到数据，连接可能已死，强制重连...');
    try { ws.close(); } catch(e) {}
    ws = null;
    scheduleReconnect(500);
  }
}, RECONNECT_INTERVAL);
