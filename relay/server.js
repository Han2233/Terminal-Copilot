const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '9876', 10);
const EXEC_TIMEOUT = parseInt(process.env.EXEC_TIMEOUT || '15000', 10);
const HEARTBEAT_INTERVAL = 10000; // 心跳间隔 10 秒

// 危险命令模式
const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+(-[rRf]+\s+)*(\/|~|\*\.\.)/, desc: '删除文件/目录 (rm)', level: 'high' },
  { pattern: /\brm\s+-rf\b/,                     desc: '强制递归删除 (rm -rf)', level: 'critical' },
  { pattern: /\b(kill|killall|pkill)\b/,           desc: '终止进程', level: 'high' },
  { pattern: /\bkill\s+-9\b/,                     desc: '强制终止进程 (kill -9)', level: 'critical' },
  { pattern: /\b(reboot|shutdown|halt|poweroff|init\s+[06])\b/, desc: '系统重启/关机', level: 'critical' },
  { pattern: /\bdd\s+if=/,                        desc: '磁盘操作 (dd)', level: 'critical' },
  { pattern: /\b(mkfs|fdisk|mkswap)\b/,           desc: '磁盘格式化/分区', level: 'critical' },
  { pattern: /\bchmod\s+(-R\s+)?777\b/,          desc: '修改为危险权限 (chmod 777)', level: 'high' },
  { pattern: /\bchown\s+(-R\s+)?[^ ]*\s+\//,     desc: '修改系统文件所有者', level: 'high' },
  { pattern: />\s*\/dev\/sd[a-z]/,              desc: '写入磁盘设备', level: 'critical' },
  { pattern: /\b(curl|wget)\b.*\|\s*(sh|bash)\b/, desc: '下载并执行脚本', level: 'critical' },
  { pattern: /\biptables\b/,                     desc: '修改防火墙规则', level: 'high' },
  { pattern: /\bmv\b.*\/(etc|boot|sys|proc|dev)\//, desc: '移动系统文件', level: 'high' },
  { pattern: /\bchattr\b/,                       desc: '修改文件不可变属性', level: 'high' },
  { pattern: /\bcrontab\s+-r\b/,                desc: '删除 crontab', level: 'high' },
];

function checkDangerous(command) {
  const matches = [];
  for (const rule of DANGEROUS_PATTERNS) {
    if (rule.pattern.test(command)) {
      matches.push(rule);
    }
  }
  return matches.length > 0 ? matches : null;
}

let extensionSocket = null;
let pendingRequests = new Map();
let requestIdCounter = 0;

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws) => {
  console.log('[relay] Chrome 扩展已连接');
  extensionSocket = ws;
  ws.isAlive = true;

  // 响应客户端的 pong 消息（JSON 级别）
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      // 处理 pong 响应
      if (msg.type === 'pong') {
        ws.isAlive = true;
        return;
      }

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

  // 协议级 pong（浏览器自动响应）
  ws.on('pong', () => {
    ws.isAlive = true;
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

// 心跳定时器：检测死连接
const heartbeatTimer = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[relay] 心跳超时，终止连接');
      return ws.terminate();
    }
    ws.isAlive = false;
    // 协议级 ping（浏览器会自动回 pong）
    ws.ping();
    // 同时也发 JSON 级 ping 作为双重保险
    ws.send(JSON.stringify({ type: 'ping' }));
  });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => {
  clearInterval(heartbeatTimer);
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

      const { command, force } = parsed;
      if (!command || typeof command !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '缺少 command 字段' }));
        return;
      }

      // 检查危险命令
      const dangers = checkDangerous(command);
      if (dangers && !force) {
        const hasCritical = dangers.some(d => d.level === 'critical');
        console.log(`[relay] ⚠️  危险命令拦截: "${command.substring(0, 80)}"`);

        // 发送确认请求到扩展
        const confirmResult = await sendToExtension('confirm', {
          command,
          dangers: dangers.map(d => ({ desc: d.desc, level: d.level })),
        });

        if (confirmResult.error) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: confirmResult.error }));
          return;
        }

        if (confirmResult.approved !== true) {
          res.writeHead(403);
          res.end(JSON.stringify({
            success: false,
            command,
            error: '用户在扩展中拒绝了该命令的执行',
            dangers: dangers.map(d => d.desc),
          }));
          return;
        }

        console.log(`[relay] ✅ 危险命令已获用户批准: "${command.substring(0, 80)}"`);
      }

      // 执行命令
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
