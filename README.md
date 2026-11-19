# Pi-for-sec

个人维护的 Pi agent 配置包：**日常编码 / 代码安全审计 / 渗透测试**。适配 Pi **1.5.2**

不是可执行程序，是一套 `~/.pi/agent/` 配置：子 agent、技能、workflow 脚本、MCP 和全局规则。

## 内容

| 路径 | 说明 |
|---|---|
| `agents/audit/` | 12 个审计子 agent：navigator / static / authz / input / config / runtime / evidence / cross / arbiter / synthesizer / environment / fixer |
| `skills/security-audit/` | 审计编排技能（`SKILL.md`）：finding 契约与 JSON schema、覆盖账本、11 类攻击面知识、playbooks、Docker 运行时策略、两个校验脚本及其测试 |
| `workflows/` | 3 个 fan-out 脚本：`audit-sweep.js`（并行块审计）、`audit-verify.js`（证据门 + 对抗复核）、`audit-runtime-batch.js`（批量动态验证） |
| `mcp.json` | MCP 服务：`aboutsecurity` 本地渗透知识库（HTTP，`127.0.0.1:1337`） |
| `settings.json` | Pi 个人配置：默认 provider/model、已装插件包、subagent 预算、TUI 偏好 |
| `AGENTS.md` | 全局行为规则：uv / pnpm、工具路由、安全查询必须先查知识库、产物写 `./tmp/` |

依赖的插件包（见 `settings.json`）：`pi-subagents`、`pi-web-access`、`@ff-labs/pi-fff`、`pi-blackhole`、`ida-mcp`。

## 安装

```bash
git clone https://github.com/LTX-GOD/Pi-for-sec.git
cd Pi-for-sec
ln -s "$PWD/agents"    ~/.pi/agent/agents
ln -s "$PWD/skills"    ~/.pi/agent/skills
ln -s "$PWD/workflows" ~/.pi/agent/workflows
```

`settings.json` / `mcp.json` 是个人配置，**不要直接覆盖**已存在的文件，手工合并对应字段。`AGENTS.md` 可复制或软链到 `~/.pi/agent/AGENTS.md`。

安装后先修掉硬编码路径（原作者的 `/Users/zsm/...` 共 17 处，分布在 `workflows/*.js` 与 `skills/security-audit/*.md`）：

```bash
grep -rl "/Users/zsm" . | xargs sed -i '' "s#/Users/zsm/.pi/agent#$HOME/.pi/agent#g"
```

校验 workflow 脚本可用：

```js
subagent({ action: "validate", workflow: "~/.pi/agent/workflows/audit-sweep.js" })
```

## 使用

- **代码审计**：说“审计这个仓库 / 做个安全 review”触发 `security-audit`。supervisor 决定路由，3 个 workflow 只负责机械 fan-out；证据门与对抗复核不通过不放行。
- **渗透查询**：任何 payload / 提权 / 漏洞细节问题，先走 `mcp__aboutsecurity__search_security`（空格分隔关键词），不凭记忆回答。需要本地 1337 服务在线。
- **日常编码**：无特殊限制，产物按 `AGENTS.md` 落到 `./tmp/`。

## 免责声明

仅用于自有资产与已获授权的测试目标。使用者自负法律责任。