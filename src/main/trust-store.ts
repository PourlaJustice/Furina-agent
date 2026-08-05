// 危险操作信任记录（userData/trusted-tools.json）
// 用户在确认弹窗中选择"本次及以后默认通过"后，该操作类型会被记录，
// 后续同类操作直接放行，不再弹窗。
import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

interface TrustStore {
  trustedTools: string[];
}

function storePath(): string {
  return path.join(app.getPath('userData'), 'trusted-tools.json');
}

function loadStore(): TrustStore {
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8');
    const data = JSON.parse(raw) as TrustStore;
    return Array.isArray(data.trustedTools) ? { trustedTools: data.trustedTools } : { trustedTools: [] };
  } catch {
    return { trustedTools: [] };
  }
}

function saveStore(store: TrustStore): void {
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Trust] 保存信任记录失败:', err);
  }
}

/** 该操作是否已被信任（支持按服务前缀，如 netease-music__） */
export function isToolTrusted(name: string): boolean {
  const list = loadStore().trustedTools;
  return list.some((entry) => name === entry || name.startsWith(entry));
}

/** 信任某类操作：MCP 工具按服务前缀信任（netease-music__ 等），内置工具按名称信任 */
export function trustTool(name: string): string[] {
  const store = loadStore();
  const prefix = name.includes("__") ? name.slice(0, name.indexOf("__") + 2) : name;
  if (!store.trustedTools.includes(prefix)) {
    store.trustedTools.push(prefix);
    saveStore(store);
  }
  return store.trustedTools;
}

/** 当前已信任的操作列表 */
export function listTrustedTools(): string[] {
  return loadStore().trustedTools;
}

/** 清除全部信任，恢复为每次询问 */
export function clearTrustedTools(): string[] {
  saveStore({ trustedTools: [] });
  return [];
}
