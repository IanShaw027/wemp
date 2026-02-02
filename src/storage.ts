/**
 * 统一的存储工具模块
 * 提供文件系统操作的抽象层，避免重复的文件操作代码
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logError } from "./log.js";

function sleepSync(ms: number): void {
  const delayMs = Math.max(0, Math.trunc(ms));
  if (delayMs <= 0) return;

  // Prefer Atomics.wait to avoid CPU busy-wait.
  try {
    // eslint-disable-next-line no-undef
    if (typeof Atomics !== "undefined" && typeof SharedArrayBuffer !== "undefined") {
      // eslint-disable-next-line no-undef
      const sab = new SharedArrayBuffer(4);
      const ia = new Int32Array(sab);
      // eslint-disable-next-line no-undef
      Atomics.wait(ia, 0, 0, delayMs);
      return;
    }
  } catch {
    // fall back below
  }

  const start = Date.now();
  while (Date.now() - start < delayMs) {
    // busy-wait fallback (should be rare)
  }
}

/**
 * 获取数据存储目录路径
 * 可通过环境变量 WEMP_DATA_DIR 自定义
 */
export function getDataDir(): string {
  return process.env.WEMP_DATA_DIR || path.join(process.env.HOME || "/tmp", ".openclaw", "data", "wemp");
}

/**
 * 确保目录存在，如果不存在则创建
 * @param dirPath 目录路径
 */
export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

/**
 * 检查文件是否存在
 * @param filePath 文件路径
 * @returns 文件是否存在
 */
export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

/**
 * 读取 JSON 文件
 * @param filePath 文件路径
 * @param defaultValue 文件不存在或读取失败时返回的默认值
 * @returns 解析后的 JSON 数据或默认值
 */
export function readJsonFile<T>(filePath: string, defaultValue: T): T {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    logError(`[wemp:storage] 读取 JSON 文件失败 (${filePath}):`, error);
    return defaultValue;
  }
}

/**
 * 写入 JSON 文件（原子写入）
 * 使用临时文件 + rename 确保写入的原子性
 * @param filePath 文件路径
 * @param data 要写入的数据
 */
export function writeJsonFile<T>(filePath: string, data: T): void {
  const dir = path.dirname(filePath);
  ensureDir(dir);

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // ignore chmod errors on unusual filesystems
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp);
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * JSON 存储类
 * 提供带缓存的 JSON 文件存储，支持原子写入
 */
export class JsonStore<T> {
  private cache: T | null = null;

  constructor(
    private readonly filePath: string,
    private readonly defaultValue: T
  ) {}

  /**
   * 读取数据（带缓存）
   */
  read(): T {
    if (this.cache !== null) {
      return this.cache;
    }
    this.cache = readJsonFile(this.filePath, this.defaultValue);
    return this.cache;
  }

  /**
   * 写入数据（更新缓存并持久化）
   */
  write(data: T): void {
    this.cache = data;
    writeJsonFile(this.filePath, data);
  }

  /**
   * 清除缓存（下次读取时重新从磁盘加载）
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * 更新数据（使用回调函数）
   */
  update(updater: (current: T) => T): void {
    const current = this.read();
    const updated = updater(current);
    this.write(updated);
  }
}

export type FileLockOptions = {
  /** Max time to wait for lock before failing */
  timeoutMs?: number;
  /** Consider lock stale after this time */
  staleMs?: number;
};

/**
 * Best-effort file lock (single-host).
 * Uses an adjacent lock file created with O_EXCL to avoid concurrent writers.
 */
export function withFileLock<T>(
  filePath: string,
  fn: () => T,
  options?: FileLockOptions,
): T {
  const timeoutMs = Math.max(0, Math.trunc(options?.timeoutMs ?? 5_000));
  const staleMs = Math.max(1_000, Math.trunc(options?.staleMs ?? 30_000));

  const dir = path.dirname(filePath);
  ensureDir(dir);

  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`, { encoding: "utf-8" });
      } catch {
        // ignore
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
      }
      break;
    } catch (err) {
      const code = (err as any)?.code;
      if (code !== "EEXIST") {
        throw err;
      }

      // Check staleness
      try {
        const stat = fs.statSync(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > staleMs) {
          try {
            fs.unlinkSync(lockPath);
            continue;
          } catch {
            // another process may have removed it; fall through to wait
          }
        }
      } catch {
        // lock disappeared between checks; retry
        continue;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timeout acquiring lock for ${filePath}`);
      }

      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // ignore unlock errors
    }
  }
}
