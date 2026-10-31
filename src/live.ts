import { watch, type FSWatcher, statSync } from "node:fs";
import { Directories } from "./directories.js";
import type { Store } from "./store.js";

// 实时账本（slice 11）：serve 模式下对已启用源目录做增量探测，发现变化后
// 自动重导入，前端通过 /api/pulse 感知 revision 前进而自动刷新，替代
// 「先点同步再看」的手动心智。
//
// 双通道探测，任一通道都足以触发：
// - watch 通道：fs.watch 递归监听源根目录（Node ≥22 在 macOS/Windows/Linux
//   均支持 recursive），事件到齐后去抖合并再导入——附加型 JSONL 每轮会写多次；
// - 扫描通道：定时对已发现会话文件做 size+mtimeNs 比对，兜底覆盖监听器
//   静默丢失、平台降级与「接入设置刚变更」的情况。
//
// 单飞纪律：手动 /api/refresh 与自动触发共用同一条 promise 队列，任何时刻
// 最多一个 refresh 在跑，避免并发重导在 SQLite 写入上互相踩踏。

export type RefreshSummary = {
  updated: number;
  failed: number;
  excluded: number;
  discovered: number;
  notices: string[];
};

export type LiveSyncOptions = {
  /** mtime 兜底扫描间隔；默认 20s */
  scanIntervalMs?: number;
  /** watch 事件去抖窗口；默认 3s */
  debounceMs?: number;
};

export class LiveSync {
  /** 每完成一次同步（手动或自动）自增；前端据此判断要不要重新拉取报表 */
  revision = 0;
  private watchers = new Map<string, FSWatcher>();
  private scanTimer: NodeJS.Timeout | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private last: { at_utc: string; result: RefreshSummary } | null = null;
  private signature = new Map<string, { size: bigint; mtimeNs: bigint }>();
  private readonly scanIntervalMs: number;
  private readonly debounceMs: number;

  constructor(
    private directories: Directories,
    private store: Store,
    options: LiveSyncOptions = {},
  ) {
    this.scanIntervalMs = options.scanIntervalMs ?? 20_000;
    this.debounceMs = options.debounceMs ?? 3_000;
  }

  /** 探测方式：watch=文件监听，poll=仅定时扫描，mixed=两者并存 */
  get mode(): "watch" | "poll" | "mixed" {
    const watching = this.watchers.size > 0;
    return watching && this.scanIntervalMs > 0
      ? "mixed"
      : watching
        ? "watch"
        : "poll";
  }

  start() {
    this.rearm();
    this.scan();
    if (this.scanIntervalMs > 0) {
      this.scanTimer = setInterval(() => this.scan(), this.scanIntervalMs);
      this.scanTimer.unref();
    }
  }

  stop() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    if (this.scanTimer) clearInterval(this.scanTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.scanTimer = this.debounceTimer = null;
  }

  /** 接入设置变化（启用/换目录）后重排监听面；扫描通道无需重排 */
  rearm() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const item of this.directories.list()) {
      if (!item.enabled || !item.supported || item.status !== "directory")
        continue;
      const root = item.resolved_path!;
      if (this.watchers.has(root)) continue;
      try {
        // recursive watch 在 Node ≥19.1 全平台可用；失败时靠扫描通道兜底
        const w = watch(root, { recursive: true }, () => this.schedule());
        w.on("error", () => {
          w.close();
          this.watchers.delete(root);
        });
        w.unref();
        this.watchers.set(root, w);
      } catch {
        // 平台不支持：该目录仅由扫描通道覆盖
      }
    }
  }

  /** 手动同步也走同一条队列：结果计入 revision，让其他标签页跟手刷新 */
  sync(): Promise<RefreshSummary> {
    return this.enqueue();
  }

  /** 接入设置刚保存后由 server 调用：立即跑一轮探测，不等下一个扫描周期 */
  nudge() {
    this.scan();
  }

  /** watch 事件入口：去抖窗口内的多次写入合并为一次导入 */
  private schedule() {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.enqueue();
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private enqueue(): Promise<RefreshSummary> {
    const run = this.queue.then(() => this.runRefresh());
    // 队列本身吞错：refresh 内部已把失败记入快照 last_error，不让一次
    // 坏文件中断后续自动同步
    this.queue = run.catch(() => {});
    return run;
  }

  private async runRefresh(): Promise<RefreshSummary> {
    const r = await this.store.refresh(this.directories);
    const result: RefreshSummary = {
      updated: r.updated,
      failed: r.failed,
      excluded: r.excluded,
      discovered: r.discovered,
      notices: r.notices,
    };
    this.last = { at_utc: new Date().toISOString(), result };
    this.revision++;
    return result;
  }

  /** 扫描通道：与会话文件改动同一判定口径（size + mtimeNs），变化即去抖导入 */
  private scan() {
    let files: Map<string, string>;
    try {
      files = this.directories.collect().files;
    } catch {
      return; // 超过 5000 文件上限等配置问题：交由手动同步时如实报错
    }
    let changed = files.size !== this.signature.size;
    if (!changed) {
      for (const [p, root] of files) {
        const prev = this.signature.get(p);
        if (!prev) {
          changed = true;
          break;
        }
        try {
          const st = statSync(p, { bigint: true });
          if (st.size !== prev.size || st.mtimeNs !== prev.mtimeNs) {
            changed = true;
            break;
          }
        } catch {
          changed = true; // 文件被移走：交给 refresh 走「旧快照保留」路径
          break;
        }
      }
    }
    if (changed) {
      // 以扫描结果重建基线：refresh 不修改源文件，基线与导入解耦
      const next = new Map<string, { size: bigint; mtimeNs: bigint }>();
      for (const [p] of files) {
        try {
          const st = statSync(p, { bigint: true });
          next.set(p, { size: st.size, mtimeNs: st.mtimeNs });
        } catch {
          // 已消失的文件不入基线，留给 refresh 处理
        }
      }
      this.signature = next;
      this.schedule();
    }
  }

  pulse() {
    return {
      revision: this.revision,
      mode: this.mode,
      watching: this.watchers.size,
      last_refresh_at_utc: this.last?.at_utc ?? null,
      last_result: this.last?.result ?? null,
    };
  }
}
