# Terminal Copilot - 远程终端操作技能

## 何时使用

当用户需要在远程机器（预发环境、线上机器等）上执行命令、查看日志、排查问题时，使用此技能通过 Terminal Copilot API 操作远程终端。

**典型场景**：
- 用户说"帮我到预发机器上查看..."
- 用户说"去机器上执行..."
- 用户说"看一下线上/预发的日志"
- 用户说"帮我排查预发环境的问题"
- 需要在远程机器上验证代码部署结果

## 前置条件

1. 本地中继服务已启动：`cd terminal-copilot/relay && npm start`
2. Chrome 已安装 Terminal Copilot 扩展
3. 浏览器中已打开 Aone Shell 终端页面（`shell.alibaba-inc.com`）
4. 扩展图标显示绿色 ON 角标

## API 接口

基础地址：`http://localhost:9876`

### 检查连接状态

```bash
curl -s http://localhost:9876/status
```

返回示例：
```json
{"connected": true, "message": "Chrome 扩展已连接"}
```

**必须在执行任何操作前先检查连接状态。** 如果返回 `connected: false`，提示用户检查中继服务、扩展和终端页面。

### 读取终端内容

```bash
curl -s http://localhost:9876/read
```

返回示例：
```json
{
  "success": true,
  "content": "[admin@pre-na620 /home/admin]$ ",
  "lines": 3,
  "method": "xterm-dom"
}
```

用途：查看当前终端状态、确认当前目录、查看之前命令的输出。

### 执行命令

```bash
curl -s -X POST http://localhost:9876/exec \
  -H 'Content-Type: application/json' \
  -d '{"command":"你要执行的命令"}'
```

返回示例：
```json
{
  "success": true,
  "command": "whoami",
  "output": "admin\n[admin@pre-na620 /home/admin]$",
  "method": "exec-and-read"
}
```

## 使用规范

### 安全原则

1. **禁止执行危险命令**：不要执行 `rm -rf`、`kill -9`、`reboot`、`shutdown`、`dd`、`mkfs` 等破坏性命令，除非用户明确要求
2. **先读后写**：修改文件前先 `cat` 查看内容，确认无误后再操作
3. **先确认再执行**：对于影响服务的操作（重启应用、修改配置等），先告知用户将要执行什么，得到确认后再执行
4. **避免长时间阻塞命令**：不要执行 `tail -f`、`top`、`vim` 等需要交互或持续运行的命令，命令超时时间为 15 秒

### 操作流程

1. **首先检查连接**：调用 `/status` 确认已连接
2. **了解环境**：调用 `/read` 查看当前终端状态，了解当前目录和机器信息
3. **逐步执行**：一次执行一条命令，查看结果后再决定下一步
4. **报告结果**：将关键输出整理后告诉用户

### 常用命令模板

```bash
# 查看机器基本信息
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"hostname && uname -a"}'

# 查看 Java 版本
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"java -version 2>&1"}'

# 查看应用进程
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"ps aux | grep java | grep -v grep"}'

# 查看最近日志
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"tail -50 /home/admin/logs/app.log"}'

# 查看磁盘使用
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"df -h"}'

# 查看内存使用
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"free -m"}'

# 查看端口占用
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"netstat -tlnp 2>/dev/null | head -20"}'

# 查看文件内容
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"cat /home/admin/xxx/conf/application.properties"}'

# 查看目录结构
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"ls -la /home/admin/"}'

# 检查应用健康
curl -s -X POST http://localhost:9876/exec -H 'Content-Type: application/json' -d '{"command":"curl -s http://localhost:8080/health"}'
```

### 错误处理

| 错误 | 原因 | 解决 |
|------|------|------|
| `connected: false` | 扩展未连接 | 提示用户检查中继服务、扩展、终端页面 |
| `未找到终端页面` | 浏览器没有打开 Aone Shell | 提示用户打开终端页面 |
| `请求超时` | 命令执行超过 15 秒 | 命令可能需要交互或运行时间过长 |
| `命令发送失败` | xterm 输入方式不可用 | 提示用户刷新终端页面 |

## 示例对话

**用户**：帮我看一下预发机器上的 Java 版本和应用是否在运行

**AI 应该做的**：
1. 先 `curl /status` 检查连接
2. 执行 `java -version 2>&1` 获取 Java 版本
3. 执行 `ps aux | grep java | grep -v grep` 检查进程
4. 整理结果告知用户
