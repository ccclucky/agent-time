"""User-controlled tool directories; filesystem discovery stays in log folders.

Reading settings checks directory metadata only. Saving a path never reads or
creates tool configuration. Only an explicitly enabled supported adapter scans
known history subdirectories during sync.
"""
import os
import sys
from pathlib import Path
from .locations import RULES, locate

TOOLS = {
    agent: {"name": name, "logs": RULES[agent]["logs"], "supported": agent == "codex"}
    for agent, name in (("codex", "Codex"), ("claude", "Claude Code"),
                        ("omp", "Oh-My-Pi"), ("pi", "Pi"),
                        ("opencode", "OpenCode"), ("antigravity", "Antigravity"))
}
MAX_FILES = 5000


def resolve_path(raw, home):
    if not isinstance(raw, str) or not raw or len(raw) > 4096 or "\x00" in raw:
        raise ValueError("请输入有效的本地目录")
    if raw == "~" or raw.startswith("~/") or raw.startswith("~\\"):
        path = home / raw[2:] if len(raw) > 1 else home
    else:
        path = Path(raw)
    if not path.is_absolute():
        raise ValueError("请使用绝对路径或以 ~/ 开头的路径")
    resolved = path.resolve()
    if resolved == Path(resolved.anchor) or resolved == home.resolve():
        raise ValueError("请选择具体工具目录，不要选择整个磁盘或用户主目录")
    return resolved


class Directories:
    def __init__(self, store, *, home=None, environment=None, platform=None):
        self.store = store
        self.home = Path.home() if home is None else Path(home)
        self.environment = os.environ if environment is None else environment
        self.platform = sys.platform if platform is None else platform

    def location(self, agent):
        return locate(agent, self.home, self.environment, self.platform)

    def default(self, agent):
        inferred = self.location(agent)
        return inferred["path"], inferred["source"]

    def get(self, agent):
        if agent not in TOOLS:
            raise ValueError("不支持的工具")
        with self.store.connect() as db:
            saved = db.execute("SELECT path,enabled FROM directory WHERE agent=?", (agent,)).fetchone()
        inferred = self.location(agent)
        default, default_source = inferred["path"], inferred["source"]
        raw = saved["path"] if saved and saved["path"] is not None else default
        source = "custom" if saved and saved["path"] is not None else default_source
        status, resolved = "unverified", None
        if raw:
            try:
                path = resolve_path(raw, self.home)
                resolved = str(path)
                # stat, not transcript/config/credential reads.
                status = "directory" if path.is_dir() else "not_directory" if path.exists() else "missing"
            except (OSError, ValueError):
                status = "unreadable"
        return {"agent": agent, "name": TOOLS[agent]["name"], "path": raw,
                "default_path": default, "resolved_path": resolved, "source": source,
                "enabled": bool(saved and saved["enabled"]), "status": status,
                "supported": TOOLS[agent]["supported"],
                "history_subdirectories": list(TOOLS[agent]["logs"]),
                "location_note": inferred["note"], "evidence_url": inferred["evidence_url"],
                "history_locations": [str(Path(resolved)/subdir) for subdir in TOOLS[agent]["logs"]] if resolved else [],
                "default_verified": inferred["path"] is not None and inferred["evidence_url"] is not None}

    def list(self):
        return [self.get(agent) for agent in TOOLS]

    def save(self, agent, raw, enabled):
        if agent not in TOOLS or type(enabled) is not bool:
            raise ValueError("请选择有效工具和接入状态")
        if enabled and not TOOLS[agent]["supported"]:
            raise ValueError("此工具适配器尚未实现，只能保存目录，不能启用接入")
        # Null resets the override. Missing directories can be saved before a
        # tool is installed, but existing files cannot be selected as folders.
        effective = raw if raw is not None else self.default(agent)[0]
        if effective is not None:
            path = resolve_path(effective, self.home)
            if path.exists() and not path.is_dir():
                raise ValueError("此路径是文件，请选择工具的数据目录")
        if enabled and effective is None:
            raise ValueError("尚未确认默认位置，请先指定目录")
        with self.store.connect() as db:
            db.execute("""INSERT INTO directory(agent,path,enabled) VALUES(?,?,?)
              ON CONFLICT(agent) DO UPDATE SET path=excluded.path,enabled=excluded.enabled""",
              (agent, raw, int(enabled)))
        return self.get(agent)

    def collect(self):
        """Re-discover enabled roots each time, including newly created sessions.

        Returns paths and their root owner. Traversal never enters arbitrary
        root contents: only known log subdirectories, no symlink traversal.
        """
        files, notices = {}, []
        for item in self.list():
            if not item["enabled"] or not item["supported"]:
                continue
            if item["status"] != "directory":
                notices.append(f'{item["name"]} 数据目录不存在或无法读取；未扫描')
                continue
            root = Path(item["resolved_path"])
            count = 0
            try:
                for folder in TOOLS[item["agent"]]["logs"]:
                    location = root / folder
                    if location.is_symlink():
                        notices.append(f'{item["name"]} 会话子目录是符号链接，未扫描；请将数据根目录设为实际位置')
                        continue
                    if not location.is_dir():
                        continue
                    def fail(error):
                        raise error
                    for directory, subdirs, names in os.walk(location, followlinks=False, onerror=fail):
                        current = Path(directory)
                        subdirs[:] = sorted(n for n in subdirs if not (current/n).is_symlink())
                        for name in sorted(names):
                            path = current/name
                            if path.suffix != ".jsonl" or path.is_symlink() or not path.is_file():
                                continue
                            # Recheck containment after resolving, including a
                            # symlink inserted since os.walk listed the entry.
                            real = path.resolve(strict=True)
                            if not real.is_relative_to(root):
                                notices.append(f'{item["name"]} 有记录链接超出数据目录，未读取')
                                continue
                            files[str(real)] = str(root)
                            count += 1
                            if len(files) > MAX_FILES:
                                raise ValueError("配置目录内超过 5000 个会话文件，请缩小数据目录范围")
                if count == 0:
                    notices.append(f'{item["name"]} 目录存在，但没有找到可导入的会话 JSONL')
            except OSError:
                notices.append(f'{item["name"]} 部分会话目录无法读取；已有记录保留旧快照')
        return files, list(dict.fromkeys(notices))
