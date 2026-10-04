/**
 * Subagent 专用 MCP 子集：只有 fetch-server + aboutsecurity。
 *
 * 子代理不加载 CLI 内置扩展，所以原生 MCP 在子会话里不存在，必须自己 createMcpExtension。
 * 用子集而非 `builtin:mcp`：后者会读整个 mcp.json，让每个子代理额外 spawn burp/obs/leoai。
 * 不叫 index.ts，所以不会被主会话当作 ambient 扩展加载，只由 agent 的
 * `subagentOnlyExtensions` 以绝对路径引用。
 */
import { createMcpExtension } from "@earendil-works/pi-coding-agent";

const ABOUTSECURITY_URL = "http:///mcp";
const ABOUTSECURITY_TOKEN = "";

export default createMcpExtension({
  /** uvx 首次冷启动可能超 10s；MCP 工具在子代理的严格 allowlist 里，未就绪会直接抛错。 */
  startupWaitMs: 15_000,
  loadConfig: () => ({
    autoEnableCodemode: false,
    errors: [],
    servers: [
      {
        name: "fetch-server",
        source: "extensions/mcp-child/subagent.ts",
        scope: "extension",
        config: {
          command: "uvx",
          args: ["--with", "mcp<2", "mcp-server-fetch"],
          exposure: "direct",
        },
      },
      {
        name: "aboutsecurity",
        source: "extensions/mcp-child/subagent.ts",
        scope: "extension",
        config: {
          type: "http",
          url: ABOUTSECURITY_URL,
          headers: { Authorization: `Bearer ${ABOUTSECURITY_TOKEN}` },
          exposure: "direct",
        },
      },
    ],
  }),
});
