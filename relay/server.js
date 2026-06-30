const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '9876', 10);
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT || '15000', 10);

// ========== WebSocket: 与 Chrome 扩展通信 ==========

let extensionSocket = null;
let pendingRequests = new Map();
let requestIdCounter = 0;

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  console.log('[relay] Chrome 扩展已连接');
  extensionSocket = ws;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const pending = pendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(msg);
        pendingRequests.delete(msg.requestId);
      }
    } catch (e) {
      console.error('[relay] 消息解析失败:', e.message);
    }
  });

  ws.on('close', () => {
    console.log('[relay] Chrome 扩展断开连接');
    extensionSocket = null;
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.resolve({ error: 'extension disconnected' });
      pendingRequests.delete(id);
    }
  });

  ws.on('error', (err) => {
    console.error('[relay] WebSocket 错误:', err.message);
  });
});

function sendToExtension(type, payload = {}) {
  return new Promise((resolve) => {
    if (!extensionSocket || extensionSocket.readyState !== 1) {
      resolve({ error: 'Chrome 扩展未连接' });
      return;
    }

    const requestId = `req_${++requestIdCounter}`;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      resolve({ error: `请求超时 (${EXEC_TIMEOUT}ms)` });
    }, EXEC_TIMEOUT);

    pendingRequests.set(requestId, { resolve, timer });

    extensionSocket.send(JSON.stringify({ requestId, type, ...payload }));
  });
}

// ========== HTTP: 供 AI Agent 调用 ==========

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  try {
    // GET /status - 检查连接状态
    if (path === '/status' && req.method === 'GET') {
      const connected = extensionSocket && extensionSocket.readyState === 1;
      res.writeHead(200);
      res.end(JSON.stringify({
        connected,
        message: connected ? 'Chrome 扩展已连接' : 'Chrome 扩展未连接，请打开终端页面并确保扩展已加载',
      }));
      return;
    }

    // GET /read - 读取终端内容
    if (path === '/read' && req.method === 'GET') {
      const result = await sendToExtension('read');
      if (result.error) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        content: result.content,
        lines: result.lines,
        method: result.method,
      }));
      return;
    }

    // POST /exec - 执行命令并返回结果
    if (path === '/exec' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请求体必须是 JSON，格式: {"command": "your command"}' }));
        return;
      }

      const { command } = parsed;
      if (!command || typeof command !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '缺少 command 字段' }));
        return;
      }

      const result = await sendToExtension('exec', { command });
      if (result.error) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: result.error }));
        return;
      }
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        command: command,
        output: result.output,
        method: result.method,
      }));
      return;
    }

    // 404
    res.writeHead(404);
    res.end(JSON.stringify({
      error: 'Not found',
      usage: {
        'GET /status': '检查 Chrome 扩展连接状态',
        'GET /read': '读取当前终端内容',
        'POST /exec': '执行命令，body: {"command": "your command"}',
      }
    }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
  });
}

// HTTP + WebSocket 共用同一端口
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║       Terminal Copilot Relay Server           ║
╠══════════════════════════════════════════════╣
║                                              ║
║  HTTP API:  http://localhost:${PORT}             ║
║  WebSocket: ws://localhost:${PORT}/ws             ║
║                                              ║
║  等待 Chrome 扩展连接...                       ║
║                                              ║
║  用法:                                        ║
║  curl http://localhost:${PORT}/status            ║
║  curl http://localhost:${PORT}/read              ║
║  curl -X POST http://localhost:${PORT}/exec \\    ║
║       -H 'Content-Type: application/json' \\ ║
║       -d '{"command":"whoami"}'              ║
║                                              ║
╚══════════════════════════════════════════════╝
`);
});
