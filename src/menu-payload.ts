/**
 * 菜单点击 payload 存储
 *
 * 背景：
 * - 微信自定义菜单 click 的 key 最长 128 字节
 * - get_current_selfmenu_info 的后台菜单里，value/url/title 可能很长且包含 `_`
 * - 直接把这些内容拼进 key 会导致创建菜单失败或解析错误
 *
 * 方案：
 * - 将长 payload 存到本地 JSON 文件
 * - key 只携带短 id（哈希），保证长度稳定
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const DATA_DIR = process.env.WEMP_DATA_DIR || path.join(process.env.HOME || "/tmp", ".openclaw", "data", "wemp");
const MENU_PAYLOAD_FILE = path.join(DATA_DIR, "menu-payloads.json");

let cachedStore: StoreFile | null = null;

export type MenuPayload =
  | { kind: "text"; text: string }
  | { kind: "news"; title: string; contentUrl: string }
  | { kind: "image"; mediaId: string }
  | { kind: "voice"; mediaId: string }
  | { kind: "video"; value: string }
  | { kind: "finder"; value: string }
  | { kind: "unknown"; originalType?: string; key?: string; value?: string; url?: string };

type StoredPayload = {
  payload: MenuPayload;
  updatedAt: number;
};

type StoreFile = {
  version: 1;
  // accountId -> id -> payload
  accounts: Record<string, Record<string, StoredPayload>>;
};

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadStoreFromDisk(): StoreFile {
  try {
    ensureDataDir();
    if (!fs.existsSync(MENU_PAYLOAD_FILE)) {
      return { version: 1, accounts: {} };
    }
    const raw = fs.readFileSync(MENU_PAYLOAD_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (parsed.version !== 1 || !parsed.accounts) return { version: 1, accounts: {} };
    return { version: 1, accounts: parsed.accounts };
  } catch (err) {
    console.warn("[wemp:menu-payload] 加载菜单 payload 失败，将重新生成:", err);
    return { version: 1, accounts: {} };
  }
}

function saveStoreToDisk(store: StoreFile): void {
  ensureDataDir();
  const tmp = `${MENU_PAYLOAD_FILE}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
    fs.renameSync(tmp, MENU_PAYLOAD_FILE);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

function getStore(): StoreFile {
  if (cachedStore) return cachedStore;
  cachedStore = loadStoreFromDisk();
  return cachedStore;
}

/**
 * 生成稳定的短 id（16 hex chars = 8 bytes）
 * - 仅使用安全字符，避免微信 key 编码/解析问题
 */
export function makeMenuPayloadId(accountId: string, payload: MenuPayload): string {
  const h = crypto.createHash("sha256");
  h.update(accountId);
  h.update("\n");
  h.update(JSON.stringify(payload));
  return h.digest("hex").slice(0, 16);
}

export function upsertMenuPayload(accountId: string, id: string, payload: MenuPayload): void {
  const store = getStore();
  if (!store.accounts[accountId]) store.accounts[accountId] = {};
  store.accounts[accountId][id] = { payload, updatedAt: Date.now() };
  saveStoreToDisk(store);
}

export function getMenuPayload(accountId: string, id: string): MenuPayload | null {
  const store = getStore();
  const entry = store.accounts[accountId]?.[id];
  return entry?.payload ?? null;
}
