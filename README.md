# deepseek web bridge

用网页版 DeepSeek 当 agent 的脑子，本地工具当手脚。不要 API key

## 架构

```
Edge 插件 ──在 chat.deepseek.com 里打字、抓回复──> bridge.mjs ──跑工具──> 你的文件
   (ext/)              HTTP + 长轮询 :8791         (单文件服务端)      (工作区目录)
```

- **脑子**：网页版 DeepSeek 那个标签页
- **手**：`bridge.mjs` 的工具。只有它能碰文件
- **协议**：一条回复里放一个 JSON 工具调用，插件从 DOM 里抓出来，所以一次只有一件事在跑

## 安装

1. 装 Node 20+
2. `node bridge.mjs`（或 `npm start`）——服务起在 `http://127.0.0.1:8791`，控制台就在这个地址
3. Edge 打开 `edge://extensions` → 开"开发人员模式" → "加载解压缩的扩展" → 选 `ext/` 目录
4. 开着 `chat.deepseek.com` 标签页，点一次工具栏上的插件图标 → 面板里点启动

之后插件会一直轮询，不用再点。插件代码改了才需要重载插件；`ui.html` 改了刷新页面即可；`bridge.mjs` 改了要重启服务

## 控制台

打开 `http://127.0.0.1:8791`。三栏：左=设置，中=对话，右=工具卡片

| 位置 | 作用 |
|---|---|
| **工作区**（左上输入框） | 工具唯一能碰的目录。改完写进 `workspace.txt`，下次启动还用这个 |
| **模式** | `工作区`（能改文件）/ `只读`（写类工具一律不发）。要改东西就得是前者 |
| **过滤框** | 按关键字筛对话和工具卡片 |
| **新对话** | 下一个任务开一段新的 DeepSeek 对话；不点就接着上一段跑 |
| **提问框** | 发任务。默认接着上一段对话，所以它记得前面所有任务的工具输出 |
| **停止** | 中断当前任务：插旗 + 通知页面停止生成 + 杀掉正在跑的脚本 |
| **重置** | 卡住时的救生舱：清空等待中的任务、释放提问、杀脚本 |
| **跳到最新** | 回到底部 |
| **复制按钮** | 每条回复、每张工具卡片都有自己的复制按钮 |

## 工具

模型这样调用（写在一段回复里）：`{"tool":"read","arg":"src/a.ts"}`

| 工具 | 用法 | 说明 |
|---|---|---|
| `ls` | `{"tool":"ls","arg":"src"}` | 列一个目录 |
| `glob` | `{"tool":"glob","arg":"**/*.mjs"}` | 按模式找路径 |
| `grep` | `{"tool":"grep","arg":"正则"}` | 搜内容，命中格式 `路径:行号:文本` |
| `grep` 的旋钮 | `"context":2` `"glob":"src/**/*.ts"` `"max":200` `"i":false` | 上下各 N 行 / 只搜匹配的文件 / 命中上限 / 区分大小写（默认不区分） |
| `read` | `{"tool":"read","arg":"a.ts"}` | 读文件；截断了会告诉你怎么接着读 |
| `read` 窗口 | `"offset":600,"limit":80` | 读第 600-679 行，带行号 |
| `write` | 回复里放一个围栏，首行 `# path: a.py` | 建/覆盖文件。会自动建缺的目录 |
| `edit` | JSON 行 +两个围栏（原文 / 新文） | 精确替换。`old` 必须和 `read` 看到的逐字一致 |
| `fs` | `{"tool":"fs","verb":"mkdir","arg":"d"}` | 建目录（`"args":[...]` 一次建多个） |
| `fs` | `{"tool":"fs","verb":"move","arg":"a","to":"b"}` | 移动/改名 |
| `fs` | `{"tool":"fs","verb":"delete","arg":"a"}` | 删除。进 `.trash/`，可恢复**；删目录要 `"recursive":true` |
| `run` | `{"tool":"run","arg":"python","args":["t.py","check"]}` | 跑脚本验证自己写的东西。只允许 `python`/`node`/`py`/`python3`，无 shell |
| `run` 的时钟 | `"timeout":300000` | 毫秒，默认 30 秒，上限 600 秒 |
| `run` 的 stdin | `{"tool":"run","arg":"node","args":["-"],"stdin":"..."}` | 一次性小脚本走 stdin（`-c`/`-e` 在 Windows 上引号会碎） |
| `skill` | `{"tool":"skill"}` / `{"tool":"skill","arg":"verify"}` | 列出 / 读取 `skills/` 下的规则文件 |
| `mcp` | `{"tool":"mcp"}` / `{"tool":"mcp","arg":"server/tool","args":{}}` | 列出 / 调用 `mcp.json` 里配置的 MCP 服务器 |
| `ask` | `{"tool":"ask","arg":"选哪个？","options":["a","b"]}` | 问用户并阻塞等待，`options` 会变成按钮 |

## 两个安全闸

1. **工作区围栏**：路径解析后必须在工作区内，否则拒绝
   真的要出去，同一次调用加 `"outside":true` 和 `"why":"干什么用"` —— 控制台会弹一次批准，**只放行这一次**
2. **看过才能改**：`write`/`edit`/`delete`/`move` 之前必须先 `read` 过那个文件，且读过之后文件没被改过
   改一个没看过、也不是自己建的文件，等于在猜里面是什么

工作区外的两条路：人工批准的单次调用，和 `run` 脚本体内（本来就是任意代码）

## 目录里有什么

| 路径 | 是什么 |
|---|---|
| `bridge.mjs` | 服务端全部逻辑（单文件） |
| `ui.html` / `md.js` | 控制台页面 + markdown 渲染（服务端每次请求读盘，所以改完刷新即可） |
| `ext/` | Edge MV3 插件（4 个文件 + manifest） |
| `skills/*.md` | 规则文件，模型按需读，不占常驻提示词 |
| `mcp.json` | MCP 服务器配置。**启动时读一次**，改了要重启 |
| `mcp settings / workspace.txt` | 上次选的工作区，本机设置，不要提交 |
| `.sessions/*.jsonl` | 每次运行的完整记录（任务、请求、工具调用、回复）。**含你的工作内容，别外传** |
| `.spill/` | 超长输出的全文，返回的是开头+结尾+这个路径 |
| `.trash/` | `fs delete` 扔进来的东西，可恢复 |
| `check-*.mjs` + `--selftest` | 检查，见下 |

## 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `BRIDGE_PORT` | `8791` | 服务端口 |
| `BRIDGE_WORKSPACE` | 桥自己的目录 | 工作区（**`workspace.txt` 里存过的设置优先于它**） |
| `BRIDGE_TURN_TIMEOUT` | `600000` | 单轮模型回复最多等多久（ms） |
| `BRIDGE_MAX_STEPS` | `24` | 一次任务最多多少轮 |
| `BRIDGE_MAX_REPAIRS` | `3` | 允许几次 JSON 解析失败后的重发 |
| `BRIDGE_RUN_TIMEOUT` | `30000` | `run` 的默认时钟（ms） |
| `BRIDGE_RUN_TIMEOUT_MAX` | `600000` | `run` 的时钟上限（ms） |
| `BRIDGE_MCP_TIMEOUT` | `20000` | 单次 MCP 调用超时 |
| `BRIDGE_MCP_CONFIG` | `mcp.json` | MCP 配置文件 |

## 命令行

```sh
node bridge.mjs                 # 常驻 + 控制台（推荐）
node bridge.mjs "帮我改个 bug"   # 跑一次然后退出
node bridge.mjs --selftest      # 逻辑自检，不需要浏览器
node bridge.mjs --probe         # 检查插件和它的 DOM 选择器
```

## 检查

```sh
node bridge.mjs --selftest
foreach ($c in 'check-codetext','check-edit','check-run','check-sessions','check-events','check-protocol','check-markdown','check-mcp') { node "$c.mjs" }
```

`check-mcp` 在不允许管道子进程的环境里会打 `SKIP`，那是环境不是失败
`check-events.mjs` 会用 DOM 桩真的执行 `ui.html` 里的脚本——浏览器侧剩下的行为
（点击、SSE 重绘、滚动）没有可跑的检查，只能真实运行
`ext/` 里的代码（`content.js` 的抓取与打字、`background.js` 的 job 路径）完全没有可跑的检查
