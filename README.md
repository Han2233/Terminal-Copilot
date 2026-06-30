# Terminal Copilot

让本地 AI Agent 通过 Chrome 扩展操作远程 Web 终端（如 Aone Shell），免去手动复制粘贴。

## 架构

```
AI Agent (Claude Code / Cursor / 自建脚本)
  │
  │  HTTP REST API
  │
  ▼
本地中继服务 (localhost:9876)
  │
  │  WebSocket
  │
  ▼
Chrome 扩展 (Terminal Copilot)
  │
  │  chrome.scripting → iframe → xterm.js
  │
  ▼
浏览器 → Aone Shell → 预发机器
```

## 快速开始

### 1. 安装 Chrome 扩展

```bash
# Chrome → chrome://extensions → 开启开发者模式
# 点击"加载已解压的扩展程序" → 选择项目根目录（包含 manifest.json 的目录）
```

### 2. 启动中继服务

```bash
cd relay
npm install
npm start
```

看到以下输出说明中继服务已启动：

```
Terminal Copilot Relay Server
HTTP API:  http://localhost:9876
WebSocket: ws://localhost:9876/ws
等待 Chrome 扩展连接...
```

### 3. 打开终端页面

在 Chrome 中打开 Aone Shell 终端页面 (`shell.alibaba-inc.com`)。

扩展图标出现绿色 **ON** 角标 = 连接成功。

### 4. 使用 API

```bash
# 检查连接状态
curl http://localhost:9876/status

# 读取终端当前内容
curl http://localhost:9876/read

# 执行命令并获取输出
curl -X POST http://localhost:9876/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"whoami"}'

# 查看 Java 版本
curl -X POST http://localhost:9876/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"java -version"}'

# 查看磁盘使用
curl -X POST http://localhost:9876/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"df -h"}'
```

## API 文档

### GET /status

检查 Chrome 扩展是否已连接。

**响应**：
```json
{
  "connected": true,
  "message": "Chrome 扩展已连接"
}
```

### GET /read

读取当前终端屏幕内容。

**响应**：
```json
{
  "success": true,
  "content": "[admin@pre-na620 /home/admin]$ \n...",
  "lines": 25,
  "method": "xterm-dom"
}
```

### POST /exec

执行命令并等待返回结果。

**请求体**：
```json
{
  "command": "whoami"
}
```

**危险命令自动拦截**：检测到 `rm -rf`、`kill -9`、`reboot`、`dd` 等危险操作时，会弹出侧边栏要求人工确认（15s 超时）。确认通过后继续执行，拒绝返回 403。

加 `"force": true` 可跳过确认（仅供紧急情况）：
```json
{
  "command": "重启命令",
  "force": true
}
```

**响应**：
```json
{
  "success": true,
  "command": "whoami",
  "output": "admin\n[admin@pre-na620 /home/admin]$",
  "method": "exec-and-read"
}
```

**被拦截时响应**：
```json
{
  "success": false,
  "error": "用户在扩展中拒绝了该命令的执行",
  "dangers": ["强制递归删除 (rm -rf)"]
}
```

## 安全机制

| 等级 | 拦截规则 | 示例 |
|------|----------|------|
| 🔴 critical | 强制删除、强制杀进程、关机重启、磁盘操作、下载执行 | `rm -rf /`, `kill -9`, `reboot`, `dd`, `curl \| bash` |
| 🟡 high | 终止进程、chmod 777、iptables、移动系统文件 | `kill`, `chmod`, `chown /`, `crontab -r` |

危险命令执行时，扩展侧边栏会弹出确认弹窗，显示命令内容和触发规则。Aone Shell 服务端也有独立的命令审查，形成双重防护。

## 在 AI Agent 中使用

### Claude Code

在 Claude Code 中，你可以直接用 Bash 工具调用：

```bash
# AI 可以自主调用这些命令来操作远程机器
curl -s http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"ls -la"}'
```

或者配置为 MCP 工具（在 `.claude/settings.json` 中添加）：

```json
{
  "mcpServers": {
    "terminal-copilot": {
      "command": "node",
      "args": ["/path/to/terminal-copilot/relay/mcp-server.js"]
    }
  }
}
```

### 其他 Agent

任何能发 HTTP 请求的 Agent 都可以使用，Python 示例：

```python
import requests

# 读取终端
resp = requests.get('http://localhost:9876/read')
print(resp.json()['content'])

# 执行命令
resp = requests.post('http://localhost:9876/exec',
    json={'command': 'cat /etc/os-release'})
print(resp.json()['output'])
```

## 项目结构

```
terminal-copilot/
├── manifest.json               # Chrome 扩展配置 (Manifest V3)
├── src/
│   ├── background/index.js     # Service Worker: WebSocket 客户端 + 终端操作
│   ├── sidepanel/              # 侧边栏面板（调试用）
│   │   ├── index.html
│   │   └── panel.js
│   └── content/                # Content Script（检测用，可选）
│       ├── detector.js
│       └── main-world.js
├── relay/
│   ├── server.js               # 中继服务：HTTP API + WebSocket 桥
│   └── package.json
└── README.md
```

## 注意事项

- 中继服务只监听 `localhost`，不暴露到外网
- 命令在你已登录的终端会话中执行，使用你自己的权限
- `POST /exec` 会等待命令执行完成（最多 15 秒超时）
- 危险命令需在侧边栏手动批准（15 秒超时），加 `"force": true` 可跳过
- 中继服务与扩展间有 **WebSocket 心跳**（10s）和 **健康监控**（30s 无数据自动重连），避免连接假死
- 如果扩展图标没有绿色 ON 角标，请确认中继服务已启动并刷新终端页面
- Aone Shell 自身也有命令审查机制，部分命令即使通过扩展确认也可能被服务端拦截
