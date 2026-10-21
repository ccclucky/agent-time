"""Transactional local metadata storage. Importing the same file is idempotent."""
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from .adapters import codex

SCHEMA = """
CREATE TABLE IF NOT EXISTS source (
 id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL,
 project TEXT NOT NULL, client TEXT NOT NULL, issues TEXT NOT NULL, last_error TEXT, config_root TEXT,
 imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS directory (
 agent TEXT PRIMARY KEY, path TEXT, enabled INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS event (
 source_id TEXT NOT NULL REFERENCES source(id) ON DELETE CASCADE,
 key TEXT NOT NULL, turn_id TEXT NOT NULL, kind TEXT NOT NULL,
 at_ms INTEGER NOT NULL, model TEXT, PRIMARY KEY(source_id,key)
);
"""


class Store:
    def __init__(self, path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self.connect() as db:
            db.executescript(SCHEMA)
            if "last_error" not in {row[1] for row in db.execute("PRAGMA table_info(source)")}:
                db.execute("ALTER TABLE source ADD COLUMN last_error TEXT")
            if "config_root" not in {row[1] for row in db.execute("PRAGMA table_info(source)")}:
                db.execute("ALTER TABLE source ADD COLUMN config_root TEXT")
        try:
            self.path.chmod(0o600)
        except OSError:
            pass  # Windows permissions are controlled by its filesystem ACLs.

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    def import_file(self, path, *, config_root=None):
        path = Path(path).expanduser().resolve(strict=True)
        if path == self.path or not path.is_file() or path.suffix != ".jsonl":
            raise ValueError("请选择 Codex .jsonl 文件")
        # Do not persist half of a snapshot that is actively being appended.
        before = path.stat()
        if before.st_size > 512 * 1024 * 1024:
            raise ValueError("文件超过 512 MiB；请先选择较小的会话文件")
        data = codex.parse(path)
        after = path.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            raise ValueError("文件正在变化，本次保留旧记录；稍后重新同步")
        sid = hashlib.sha256(os.fsencode(str(path))).hexdigest()
        meta = data["session"]
        with self.connect() as db:
            db.execute("""INSERT INTO source(id,path,session_id,project,client,issues,config_root)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
              session_id=excluded.session_id,project=excluded.project,
              client=excluded.client,issues=excluded.issues,config_root=excluded.config_root,last_error=NULL,imported_at=CURRENT_TIMESTAMP""",
              (sid, str(path), meta["id"], meta["project"], meta["client"], json.dumps(data["issues"]), config_root))
            db.execute("DELETE FROM event WHERE source_id=?", (sid,))
            db.executemany("INSERT INTO event VALUES(?,?,?,?,?,?)",
              [(sid, e["key"], e["turn_id"], e["kind"], e["at_ms"], e["model"]) for e in data["events"]])
        return {"events": len(data["events"]), "issues": data["issues"]}

    def refresh(self, directories=None):
        from .directories import Directories
        directories = directories or Directories(self)
        # Discover before mutating snapshots, so exceeding the file limit does
        # not leave a partially imported selection.
        discovered, notices = directories.collect()
        configured = {item["resolved_path"] for item in directories.list()
                      if item["enabled"] and item["supported"] and item["resolved_path"]}
        with self.connect() as db:
            saved = db.execute("SELECT path,config_root FROM source").fetchall()
        paths = {s["path"]: s["config_root"] for s in saved
                 if s["config_root"] is None or s["config_root"] in configured}
        # A file no longer in the configured history tree is not read again.
        # Preserve its old snapshot and surface it as stale.
        missing = {path for path, root in paths.items()
                   if root is not None and path not in discovered}
        paths.update(discovered)
        ok, failed = 0, 0
        for path, root in sorted(paths.items()):
            try:
                if path in missing:
                    raise ValueError("不再处于已配置的会话目录")
                self.import_file(path, config_root=root)
                ok += 1
            except (OSError, ValueError, sqlite3.Error):
                failed += 1
                with self.connect() as db:
                    db.execute("UPDATE source SET last_error=? WHERE path=?",
                      ("最近同步失败；显示上次成功导入的快照", path))
        # Codex can move sessions into archived_sessions. Retire a missing
        # managed-file snapshot only after another successfully refreshed file
        # proves that it contains every one of the same normalized events.
        # No source files or unique history are removed.
        retired = 0
        with self.connect() as db:
            for path in missing:
                old = db.execute("SELECT id,session_id,config_root FROM source WHERE path=?", (path,)).fetchone()
                if not old:
                    continue
                other = db.execute("""SELECT 1 FROM source WHERE id<>? AND session_id=?
                  AND config_root=? AND last_error IS NULL LIMIT 1""",
                  (old["id"], old["session_id"], old["config_root"])).fetchone()
                uncovered = db.execute("""SELECT 1 FROM event e WHERE e.source_id=? AND NOT EXISTS (
                  SELECT 1 FROM event alt JOIN source s ON s.id=alt.source_id
                  WHERE s.id<>? AND s.session_id=? AND s.config_root=?
                  AND s.last_error IS NULL AND alt.key=e.key) LIMIT 1""",
                  (old["id"], old["id"], old["session_id"], old["config_root"])).fetchone()
                if other and not uncovered:
                    db.execute("DELETE FROM source WHERE id=?", (old["id"],))
                    retired += 1
        failed -= retired
        return {"updated": ok, "failed": failed, "discovered": len(discovered), "relocated": retired,
                "notices": notices,
                "note": "配置目录会发现新会话；关闭接入或更换目录不会删除既有统计"}

    def sessions(self):
        with self.connect() as db:
            # Keep source metadata and events in one read snapshot while a
            # separate CLI process or refresh transaction imports new files.
            db.execute("BEGIN")
            sources = db.execute("SELECT id,session_id,project,client,issues,last_error,imported_at FROM source ORDER BY id").fetchall()
            events = db.execute("""SELECT DISTINCT s.session_id,e.key,e.turn_id,e.kind,e.at_ms,e.model
              FROM event e JOIN source s ON s.id=e.source_id ORDER BY e.at_ms,e.key""").fetchall()
        sessions = {}
        for s in sources:
            item = sessions.setdefault(s["session_id"], {"id": s["session_id"], "agent": "Codex",
              "project": s["project"], "issues": [], "turns": [], "imported_at": s["imported_at"]})
            item["issues"] = sorted(set(item["issues"] + json.loads(s["issues"]) + ([s["last_error"]] if s["last_error"] else [])))
            item["imported_at"] = max(item["imported_at"], s["imported_at"])
        seen, grouped = set(), {}
        for event in events:
            if event["key"] in seen:
                continue
            seen.add(event["key"])
            grouped.setdefault((event["session_id"], event["turn_id"]), []).append(dict(event))
        for (sid, tid), entries in grouped.items():
            starts = sorted({e["at_ms"] for e in entries if e["kind"] == "start"})
            endings = {(e["at_ms"], e["kind"]) for e in entries if e["kind"] in ("complete", "abort", "fail")}
            start = starts[0] if len(starts) == 1 else None
            end, end_kind = next(iter(endings)) if len(endings) == 1 else (None, None)
            status = "completed" if end_kind == "complete" else "aborted" if end_kind == "abort" else "failed" if end_kind == "fail" else "open"
            reason = None
            if len(starts) > 1 or len(endings) > 1:
                status, reason = "invalid", "同一轮存在冲突的起止事件，未计入耗时"
            elif start is None:
                status, reason = "incomplete", "缺少执行开始事件"
            elif end is not None and end < start:
                status, reason = "invalid", "结束时间早于开始时间，未计入耗时"
            elif end is None:
                reason = "尚无结束事件；可能进行中，也可能记录中断，不推测当前状态"
            models = sorted({e["model"] for e in entries if e["model"]})
            sessions[sid]["turns"].append({"id": tid, "start_ms": start, "end_ms": end,
              "elapsed_ms": end-start if status in ("completed", "aborted", "failed") else None,
              "status": status, "reason": reason, "models": models, "events": entries,
              "work_ms": None, "human_ms": None, "response_gap_ms": None})
        for session in sessions.values():
            session["turns"].sort(key=lambda t: (t["start_ms"] or t["end_ms"] or 0, t["id"]))
        return list(sessions.values())
