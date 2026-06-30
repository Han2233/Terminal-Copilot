// Side Panel 控制脚本 v2
// 改用 chrome.scripting.executeScript 直接注入，不依赖 content_scripts 声明

function log(text, type = 'info') {
  const logEl = document.getElementById('log');
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logEl.prepend(entry);
}

async function getTerminalTabId() {
  const tabs = await chrome.tabs.query({ url: 'https://shell.alibaba-inc.com/*' });
  if (tabs.length === 0) {
    log('未找到 shell.alibaba-inc.com 页面，请先打开终端页面', 'error');
    return null;
  }
  log(`找到终端页面: ${tabs[0].url.substring(0, 80)}...`);
  return tabs[0].id;
}

function updateStatus(connected) {
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = `status-dot ${connected ? 'connected' : 'disconnected'}`;
  text.textContent = connected ? '已连接到终端页面' : '未连接到终端页面';
}

function showTerminalContent(text, method, rowCount) {
  document.getElementById('termInfo').style.display = 'grid';
  document.getElementById('terminalContent').style.display = 'block';
  document.getElementById('readMethod').textContent = method;
  document.getElementById('rowCount').textContent = rowCount;

  const contentEl = document.getElementById('terminalContent');
  const lines = text.split('\n');
  const lastLines = lines.slice(-80);
  contentEl.textContent = lastLines.join('\n');
  contentEl.scrollTop = contentEl.scrollHeight;
}

// ========== 核心：深度扫描函数（注入到页面执行）==========

function deepScanFunction() {
  const result = {
    url: window.location.href,
    frameType: (window === window.top) ? 'top' : 'iframe',
    terminal: null,
    elements: {},
    globalVars: [],
    text: null
  };

  // 1. 扫描所有可能的终端 DOM 元素
  const selectors = {
    '.xterm': 'xterm.js',
    '.xterm-rows': 'xterm.js rows',
    '.xterm-screen': 'xterm.js screen',
    '.terminal': 'terminal',
    '[class*="terminal"]': 'terminal-like',
    '[class*="xterm"]': 'xterm-like',
    '[class*="console"]': 'console-like',
    '[class*="shell"]': 'shell-like',
    '[class*="hterm"]': 'hterm',
    '.hterm-screen': 'hterm screen',
    'canvas': 'canvas',
    'pre': 'pre',
    'code': 'code',
    '[role="textbox"]': 'textbox',
    '[contenteditable]': 'contenteditable',
    'textarea': 'textarea',
    'iframe': 'iframe',
    // 通用容器
    '[class*="term-"]': 'term-prefix',
    '[id*="terminal"]': 'terminal-id',
    '[id*="term"]': 'term-id',
    '[id*="shell"]': 'shell-id',
    '[id*="console"]': 'console-id',
  };

  for (const [sel, label] of Object.entries(selectors)) {
    try {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        result.elements[`${sel} (${label})`] = Array.from(els).map(el => ({
          tag: el.tagName,
          class: (el.className?.toString?.() || '').substring(0, 200),
          id: el.id || '',
          size: `${el.offsetWidth}x${el.offsetHeight}`,
          visible: el.offsetWidth > 0 && el.offsetHeight > 0,
          children: el.children.length,
          textLen: (el.textContent || '').length,
          src: el.src || '',
        }));
      }
    } catch(e) {}
  }

  // 2. 检查全局变量中是否有终端实例
  const termNames = [
    'term', 'terminal', '_terminal', 'xterm', 'xtermInstance',
    'hterm', 'Terminal', 'shell', 'console_',
    'terminalInstance', 'shellInstance', 'htermInstance'
  ];
  for (const name of termNames) {
    try {
      if (window[name] && typeof window[name] === 'object') {
        const obj = window[name];
        result.globalVars.push({
          name,
          type: obj.constructor?.name || typeof obj,
          hasBuffer: !!obj.buffer,
          hasWrite: typeof obj.write === 'function',
          hasInput: typeof obj.input === 'function',
          hasFocus: typeof obj.focus === 'function',
          keys: Object.keys(obj).slice(0, 30)
        });
      }
    } catch(e) {}
  }

  // 3. 尝试多种方式读取文本内容
  // 方式 A: xterm.js DOM
  const xtermRows = document.querySelector('.xterm-rows');
  if (xtermRows) {
    const lines = [];
    for (let i = 0; i < xtermRows.children.length; i++) {
      lines.push(xtermRows.children[i].textContent || '');
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length > 0) {
      result.text = lines.join('\n');
      result.terminal = 'xterm-dom';
    }
  }

  // 方式 B: hterm - 查找 x-screen 或 hterm 元素
  if (!result.text) {
    const hscreen = document.querySelector('x-screen') || document.querySelector('.hterm-screen');
    if (hscreen) {
      const lines = [];
      const rows = hscreen.querySelectorAll('x-row');
      if (rows.length > 0) {
        rows.forEach(row => lines.push(row.textContent || ''));
      } else {
        // hterm 有时直接在 x-screen 下放文本节点
        lines.push(hscreen.textContent || '');
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      if (lines.length > 0) {
        result.text = lines.join('\n');
        result.terminal = 'hterm';
      }
    }
  }

  // 方式 C: 查找任何包含终端样式文本的 pre/code 元素
  if (!result.text) {
    const preElements = document.querySelectorAll('pre, code, [class*="output"]');
    for (const el of preElements) {
      const text = el.textContent || '';
      // 终端内容通常包含 $ 或 # 提示符，或路径
      if (text.length > 50 && (text.includes('$') || text.includes('#') || text.includes('/home/'))) {
        result.text = text;
        result.terminal = 'pre-code';
        break;
      }
    }
  }

  // 方式 D: 查找大面积的 div/span，可能包含终端文本
  if (!result.text) {
    const allDivs = document.querySelectorAll('div, span');
    for (const el of allDivs) {
      if (el.offsetWidth > 400 && el.offsetHeight > 200) {
        const text = el.innerText || '';
        if (text.length > 100 && (text.includes('$') || text.includes('#') || text.includes('/home/') || text.includes('[admin@'))) {
          result.text = text.substring(0, 10000);
          result.terminal = 'large-div';
          break;
        }
      }
    }
  }

  // 方式 E: 全页面文本扫描（最后兜底）
  if (!result.text) {
    const bodyText = document.body?.innerText || '';
    if (bodyText.length > 50) {
      // 看看有没有终端特征
      const hasPrompt = /\$\s|#\s|\[.*@.*\]/.test(bodyText);
      if (hasPrompt) {
        result.text = bodyText.substring(0, 10000);
        result.terminal = 'body-text';
      }
    }
  }

  return result;
}

// ========== 按钮事件 ==========

// 检测终端 - 注入到所有 frames
document.getElementById('btnDetect').addEventListener('click', async () => {
  const tabId = await getTerminalTabId();
  if (!tabId) return;

  // 清空旧结果
  document.getElementById('detectionResult').innerHTML = '';
  document.getElementById('terminalContent').textContent = '';
  document.getElementById('terminalContent').style.display = 'none';
  document.getElementById('termInfo').style.display = 'none';

  log('开始深度扫描（主页面 + 所有 iframe）...');

  // 先扫描主页面
  try {
    const mainResult = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: deepScanFunction,
      world: 'MAIN'
    });
    const data = mainResult[0]?.result;
    if (data) {
      log(`主页面扫描: ${Object.keys(data.elements).length} 种元素, 全局变量: ${data.globalVars.length}个, 文本: ${data.text ? 'YES' : 'NO'}`, data.text ? 'success' : 'info');
      showScanResult('主页面', data);
      if (data.text) {
        showTerminalContent(data.text, data.terminal, data.text.split('\n').length);
        updateStatus(true);
      }
    }
  } catch (e) {
    log(`主页面扫描失败: ${e.message}`, 'error');
  }

  // 再扫描所有 iframe
  try {
    const iframeResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: deepScanFunction,
      world: 'MAIN'
    });

    for (let i = 0; i < iframeResults.length; i++) {
      const data = iframeResults[i]?.result;
      if (!data || data.frameType === 'top') continue;

      const hasContent = Object.keys(data.elements).length > 0 || data.text;
      if (hasContent) {
        log(`iframe[${i}] (${data.url.substring(0, 60)}): ${Object.keys(data.elements).length} 种元素, 文本: ${data.text ? 'YES' : 'NO'}`, data.text ? 'success' : 'info');
        showScanResult(`iframe[${i}]`, data);
        if (data.text) {
          showTerminalContent(data.text, `${data.terminal} (iframe)`, data.text.split('\n').length);
          updateStatus(true);
        }
      }
    }
  } catch (e) {
    log(`iframe 扫描失败: ${e.message}`, 'error');
  }

  // 也扫描 ISOLATED world（有些 DOM 在 MAIN world 也能看到，但保险起见）
  try {
    const isolatedResults = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: deepScanFunction
    });

    for (let i = 0; i < isolatedResults.length; i++) {
      const data = isolatedResults[i]?.result;
      if (!data) continue;
      if (data.text) {
        log(`ISOLATED[${i}] 找到文本!`, 'success');
        showTerminalContent(data.text, `${data.terminal} (isolated)`, data.text.split('\n').length);
        updateStatus(true);
      }
    }
  } catch (e) {
    // 忽略，ISOLATED 扫描只是补充
  }
});

function showScanResult(label, data) {
  const el = document.getElementById('detectionResult');
  let html = el.innerHTML || '';

  html += `<div class="detection-result" style="margin-top:8px">`;
  html += `<strong>${label}</strong> (${data.url.substring(0, 60)})<br>`;

  // 显示找到的元素
  const elements = Object.entries(data.elements);
  if (elements.length > 0) {
    html += '<br><u>DOM 元素:</u><br>';
    elements.forEach(([sel, items]) => {
      items.forEach(item => {
        if (item.visible) {
          html += `&nbsp;&nbsp;${sel}: ${item.tag}#${item.id || '-'} (${item.size}) text=${item.textLen}<br>`;
        }
      });
    });
  }

  // 显示全局变量
  if (data.globalVars.length > 0) {
    html += '<br><u>全局终端变量:</u><br>';
    data.globalVars.forEach(v => {
      html += `&nbsp;&nbsp;<code>window.${v.name}</code> [${v.type}] buffer=${v.hasBuffer} write=${v.hasWrite} input=${v.hasInput}<br>`;
      html += `&nbsp;&nbsp;&nbsp;&nbsp;keys: ${v.keys.join(', ')}<br>`;
    });
  }

  if (data.text) {
    html += `<br><strong style="color:green">找到终端文本! 方式: ${data.terminal}, ${data.text.split('\\n').length} 行</strong>`;
  }

  html += '</div>';
  el.innerHTML = html;
}

// 读取 DOM（简化版，直接 executeScript）
document.getElementById('btnReadDOM').addEventListener('click', async () => {
  const tabId = await getTerminalTabId();
  if (!tabId) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: deepScanFunction
    });

    for (const r of results) {
      if (r?.result?.text) {
        showTerminalContent(r.result.text, r.result.terminal, r.result.text.split('\n').length);
        log(`读取成功 (${r.result.terminal}): ${r.result.text.split('\\n').length} 行`, 'success');
        updateStatus(true);
        return;
      }
    }
    log('所有 frame 均未找到终端文本', 'error');
  } catch (e) {
    log(`读取失败: ${e.message}`, 'error');
  }
});

// 读取 Buffer（MAIN world）
document.getElementById('btnReadBuffer').addEventListener('click', async () => {
  const tabId = await getTerminalTabId();
  if (!tabId) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: deepScanFunction,
      world: 'MAIN'
    });

    for (const r of results) {
      if (r?.result?.text) {
        showTerminalContent(r.result.text, `${r.result.terminal} (MAIN)`, r.result.text.split('\n').length);
        log(`MAIN world 读取成功 (${r.result.terminal}): ${r.result.text.split('\\n').length} 行`, 'success');
        updateStatus(true);
        return;
      }
      if (r?.result?.globalVars?.length > 0) {
        log(`发现全局变量: ${r.result.globalVars.map(v => v.name).join(', ')}`, 'success');
      }
    }
    log('MAIN world 未找到终端文本', 'error');
  } catch (e) {
    log(`MAIN world 读取失败: ${e.message}`, 'error');
  }
});

// 发送命令
document.getElementById('btnSend').addEventListener('click', async () => {
  const input = document.getElementById('commandInput');
  const command = input.value.trim();
  if (!command) return;

  const tabId = await getTerminalTabId();
  if (!tabId) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (cmd) => {
        // 尝试多种输入方式

        // 1. xterm.js
        const termCandidates = [window.term, window.terminal, window._terminal];
        for (const t of termCandidates) {
          if (t && typeof t.input === 'function') {
            t.input(cmd + '\r');
            return { success: true, method: 'xterm-input' };
          }
          if (t && t._core) {
            try {
              t._core.coreService.triggerDataEvent(cmd + '\r', true);
              return { success: true, method: 'xterm-core' };
            } catch(e) {}
          }
        }

        // 2. hterm
        if (window.hterm && window.hterm.Terminal) {
          const instances = window.hterm.Terminal.instances || [];
          for (const inst of instances) {
            if (inst.io && inst.io.sendString) {
              inst.io.sendString(cmd + '\r');
              return { success: true, method: 'hterm-io' };
            }
          }
        }

        // 3. 查找 WebSocket 直接发送
        // (WebSocket 对象不好从外部获取，跳过)

        // 4. 模拟键盘输入到焦点元素
        const focusable = document.querySelector('.xterm-helper-textarea, textarea, [contenteditable], [role="textbox"]');
        if (focusable) {
          focusable.focus();
          // 用 InputEvent
          for (const char of cmd) {
            focusable.dispatchEvent(new InputEvent('input', {
              data: char,
              inputType: 'insertText',
              bubbles: true,
              composed: true
            }));
          }
          focusable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          focusable.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          focusable.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
          return { success: true, method: 'keyboard-sim' };
        }

        return { success: false, error: 'no input method found' };
      },
      args: [command],
      world: 'MAIN'
    });

    for (const r of results) {
      if (r?.result?.success) {
        log(`命令已发送 (${r.result.method}): ${command}`, 'success');
        input.value = '';
        return;
      }
    }
    log(`命令发送失败: 所有方法均不可用`, 'error');
  } catch (e) {
    log(`命令发送失败: ${e.message}`, 'error');
  }
});

document.getElementById('commandInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btnSend').click();
});

// 初始化
(async () => {
  const tabs = await chrome.tabs.query({ url: 'https://shell.alibaba-inc.com/*' });
  if (tabs.length > 0) {
    updateStatus(true);
    log('检测到终端页面已打开，点击"检测终端"开始扫描');
  } else {
    log('请先打开 shell.alibaba-inc.com 终端页面');
  }
})();
