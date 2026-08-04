// MCP 集成（阶段 8）：通过 MCP 协议连接外部工具服务器（stdio / SSE），统一注册给 Agent
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDef } from '../agent';

export interface MCPServerConfig {
  name: string;
  enabled?: boolean;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 是否在每次调用前弹窗确认（外部工具默认视为危险，防误操作） */
  dangerous?: boolean;
}

interface McpToolEntry {
  serverName: string;
  toolName: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  dangerous: boolean;
  call: (args: Record<string, unknown>) => Promise<unknown>;
}

const CONNECT_TIMEOUT = 20_000; // 单个服务器连接超时（秒级，避免卡住启动）

function sanitizeName(s: string): string {
  const out = String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
  return out.length > 60 ? out.slice(0, 60) : out;
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function formatMcpResult(result: unknown): string {
  try {
    const r = result as {
      isError?: boolean;
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
    };
    if (r && r.isError) {
      const text = (r.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      return `MCP 工具执行失败：${text || '未知错误'}`;
    }
    const parts = (r?.content ?? [])
      .map((c) => (c.type === 'text' ? c.text : `[${c.type ?? 'unknown'}]`))
      .filter((s) => s !== undefined && s !== null && s !== '');
    if (parts.length > 0) return parts.join('\n');
    if (r?.structuredContent !== undefined) return JSON.stringify(r.structuredContent);
    return '（无返回内容）';
  } catch (err) {
    return `MCP 返回解析失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

class MCPManager {
  private clients = new Map<string, Client>();
  private tools: McpToolEntry[] = [];
  private configs: MCPServerConfig[] = [];
  private started = false;

  loadConfig(): MCPServerConfig[] {
    try {
      const p = path.join(app.getAppPath(), 'mcp-servers.json');
      if (!fs.existsSync(p)) {
        this.configs = [];
        return this.configs;
      }
      const data = JSON.parse(fs.readFileSync(p, 'utf-8')) as { servers?: MCPServerConfig[] };
      this.configs = Array.isArray(data.servers) ? data.servers.filter((s) => s && s.name) : [];
      return this.configs;
    } catch (err) {
      console.error('[MCP] 配置文件读取失败:', err instanceof Error ? err.message : String(err));
      this.configs = [];
      return this.configs;
    }
  }

  /** 启动时调用：读取 mcp-servers.json 并连接所有启用的服务器（失败不影响主程序） */
  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.loadConfig();
    const enabled = this.configs.filter((c) => c.enabled !== false);
    if (enabled.length === 0) {
      console.log('[MCP] 没有启用的服务器（见 mcp-servers.json）');
      return;
    }
    await Promise.allSettled(enabled.map((c) => this.connect(c)));
    console.log(`[MCP] 已连接 ${this.clients.size}/${enabled.length} 个服务器，可用工具 ${this.tools.length} 个`);
  }

  /** 连接单个服务器（stdio 本地进程 或 SSE 远程地址） */
  async connect(cfg: MCPServerConfig): Promise<void> {
    try {
      let transport;
      if (cfg.transport === 'sse') {
        if (!cfg.url) throw new Error('SSE 服务器缺少 url 配置');
        transport = new SSEClientTransport(new URL(cfg.url), cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined);
      } else {
        if (!cfg.command) throw new Error('stdio 服务器缺少 command 配置');
        transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env });
      }
      const client = new Client({ name: 'furina-agent', version: '1.0.0' });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT, `连接超时（${cfg.name}）`);
      this.clients.set(cfg.name, client);
      await this.syncServerTools(cfg);
      console.log(`[MCP] 已连接服务器: ${cfg.name}（${cfg.transport}）`);
    } catch (err) {
      this.clients.delete(cfg.name);
      console.error(`[MCP] 服务器 ${cfg.name} 连接失败:`, err instanceof Error ? err.message : String(err));
    }
  }

  private async syncServerTools(cfg: MCPServerConfig): Promise<void> {
    const client = this.clients.get(cfg.name);
    if (!client) return;
    const { tools } = await client.listTools();
    const dangerous = cfg.dangerous !== false;
    for (const t of tools) {
      this.tools.push({
        serverName: cfg.name,
        toolName: t.name,
        description: t.description ?? undefined,
        inputSchema: (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
        dangerous,
        call: (args) => client.callTool({ name: t.name, arguments: args }),
      });
    }
  }

  /** 把当前已连接的 MCP 工具转成项目统一的 ToolDef（供旧 Agent 与 LangGraph 共用） */
  toToolDefs(): ToolDef[] {
    return this.tools.map((t) => ({
      name: `${sanitizeName(t.serverName)}__${sanitizeName(t.toolName)}`,
      description: t.description ?? `MCP 服务器 ${t.serverName} 提供的工具 ${t.toolName}`,
      parameters:
        t.inputSchema && typeof t.inputSchema === 'object' && (t.inputSchema as Record<string, unknown>).type
          ? t.inputSchema
          : { type: 'object', properties: {}, required: [] },
      dangerous: t.dangerous,
      execute: async (args) => formatMcpResult(await t.call(args)),
    }));
  }

  /** 退出前断开所有连接，避免残留子进程 */
  async disconnectAll(): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [, client] of this.clients) {
      tasks.push(client.close().catch(() => undefined));
    }
    await Promise.allSettled(tasks);
    this.clients.clear();
    this.tools = [];
  }
}

export const mcpManager = new MCPManager();

/** 启动时调用：读取配置并连接外部工具服务器 */
export function initMcp(): Promise<void> {
  return mcpManager.init();
}
