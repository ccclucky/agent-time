"""Run from a checkout: python -m agenttime --help."""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import sys
from .store import Store
from .server import make_server


def default_db():
    root = Path(os.environ.get("XDG_DATA_HOME", str(Path.home()/".local"/"share")))
    return root/"agenttime"/"agenttime.sqlite3"


def main():
    parser = argparse.ArgumentParser(description="AgentTime — 本地 Agent 时间账本")
    parser.add_argument("--db", type=Path, default=default_db(), help="本地 SQLite 文件位置")
    sub = parser.add_subparsers(dest="command", required=True)
    imp = sub.add_parser("import", help="显式导入用户选择的 Codex 本地 JSONL；不改写源文件")
    imp.add_argument("--agent", choices=["codex"], required=True)
    imp.add_argument("path", type=Path)
    serve = sub.add_parser("serve", help="启动本地网页；不会自动扫描设备")
    serve.add_argument("--port", type=int, default=8765)
    sub.add_parser("refresh", help="重新读取此前通过 import 登记的文件")
    args = parser.parse_args()
    try:
        store = Store(args.db)
        if args.command == "import":
            selected = args.path.expanduser().resolve(strict=True)
            paths = [selected] if selected.is_file() else sorted(
                p for p in selected.rglob("*.jsonl") if p.is_file() and not p.is_symlink())
            if not paths:
                parser.error("指定目录没有 .jsonl 文件")
            if len(paths) > 5000:
                parser.error("单次最多导入 5000 个文件，请选择更小的目录")
            good, failed, issues = 0, 0, 0
            for path in paths:
                try:
                    result = store.import_file(path)
                    good += 1
                    issues += len(result["issues"])
                    for issue in result["issues"]:
                        print("记录提示：" + issue, file=sys.stderr)
                except (ValueError, OSError) as exc:
                    failed += 1
                    message = str(exc) if isinstance(exc, ValueError) else "文件无法读取"
                    print("跳过文件：" + message, file=sys.stderr)
            print(json.dumps({"imported_files": good, "failed_files": failed,
                              "warnings": issues, "note": "只保存统计元数据；未修改源记录"}, ensure_ascii=False))
            return 1 if failed else 0
        if args.command == "refresh":
            result = store.refresh()
            print(json.dumps(result, ensure_ascii=False))
            return 1 if result["failed"] else 0
        if not 0 <= args.port <= 65535:
            parser.error("端口应在 0–65535 之间")
        server = make_server(store, args.port)
        print(f"AgentTime 已启动：在本机浏览器访问 http://127.0.0.1:{server.server_address[1]}", flush=True)
        print("仅绑定本机地址，无遥测。Ctrl+C 停止。", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
        return 0
    except (OSError, ValueError, sqlite3.Error):
        print("无法启动或读取本地数据，请检查路径、权限及端口。", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
