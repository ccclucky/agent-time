"""Read Codex rollout boundaries, not prompts, tool payloads or credentials.

Approval intervals are deliberately unknown: Codex's rollout persistence policy
omits those events. A task interval therefore measures processing, not pure work.
"""
from datetime import datetime
import hashlib
import json
from pathlib import PurePosixPath
import re

MAX_LINE = 16 * 1024 * 1024
ID = re.compile(r"[A-Za-z0-9_.:-]{1,200}\Z")
KINDS = {"task_started": "start", "turn_started": "start",
         "task_complete": "complete", "turn_complete": "complete",
         "turn_aborted": "abort"}


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("missing timestamp")
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None or not 1970 <= dt.year <= 2200:
        raise ValueError("timestamp needs timezone and a supported year")
    return round(dt.timestamp() * 1000)


def parse(path):
    """Return a sanitized file snapshot. Caller commits only validated snapshots."""
    meta, events, issues, excluded = None, [], set(), False
    with path.open("rb") as stream:
        while True:
            line = stream.readline(MAX_LINE + 1)
            if not line:
                break
            if len(line) > MAX_LINE:
                raise ValueError("单条记录超过 16 MiB；文件未导入")
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                if not isinstance(row, dict):
                    raise ValueError()
                payload = row.get("payload")
                if not isinstance(payload, dict):
                    continue
                kind = row.get("type")
                if kind == "session_meta":
                    sid = payload.get("id")
                    if not isinstance(sid, str) or not ID.fullmatch(sid):
                        raise ValueError()
                    if meta is not None and meta["id"] != sid:
                        excluded = True
                    source = payload.get("source")
                    origin = str(payload.get("originator", "")).lower()
                    # Unknown sources, fork inheritance and child agents need an
                    # explicit adapter, rather than guessing their accounting.
                    if (source not in ("cli", "vscode", "exec")
                        or any(x in origin for x in ("cloud", "remote"))
                        or payload.get("forked_from_id") or payload.get("parent_thread_id")
                        or payload.get("history_base") or payload.get("subagent_history_start_ordinal")
                        or payload.get("history_mode") not in (None, "legacy")
                        or payload.get("thread_source", "user") not in (None, "user")):
                        excluded = True
                    cwd = payload.get("cwd", "")
                    project = PurePosixPath(str(cwd).replace("\\", "/")).name[:100] or "未知项目"
                    meta = {"id": sid, "agent": "Codex", "project": project,
                            "client": source if isinstance(source, str) else "unknown"}
                    continue
                if kind == "event_msg" and payload.get("type") == "thread_rolled_back":
                    excluded = True
                    continue
                if kind == "turn_context":
                    event_kind = "model"
                elif kind == "event_msg" and payload.get("type") in KINDS:
                    event_kind = KINDS[payload["type"]]
                    if event_kind == "complete" and payload.get("error") is not None:
                        event_kind = "fail"
                else:
                    continue
                tid = payload.get("turn_id")
                if not isinstance(tid, str) or not ID.fullmatch(tid):
                    issues.add("部分事件没有可关联的交互 ID，未猜测归属")
                    continue
                at = timestamp(row.get("timestamp"))
                event = {"turn_id": tid, "kind": event_kind, "at_ms": at, "model": None}
                if event_kind == "model":
                    model = payload.get("model")
                    if not isinstance(model, str) or not model.strip():
                        continue
                    event["model"] = model[:120]
                events.append(event)
            except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError):
                issues.add("存在无法解析的记录；只保留可验证的元数据，请检查源文件")
    if meta is None:
        raise ValueError("未找到有效 Codex 会话元数据")
    if excluded:
        raise ValueError("来源未知、远程、子 Agent、分支继承或回滚记录暂不支持；未导入")
    unique = {}
    for event in events:
        encoded = json.dumps([meta["id"], event], sort_keys=True, ensure_ascii=True)
        event["key"] = hashlib.sha256(encoded.encode()).hexdigest()
        unique[event["key"]] = event
    return {"session": meta, "events": list(unique.values()), "issues": sorted(issues)}
