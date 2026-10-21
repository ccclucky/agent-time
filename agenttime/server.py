"""Loopback-only HTTP interface. No arbitrary path/file API or external assets."""
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from .metrics import report
from .directories import Directories

WEB = Path(__file__).with_name("web")
SOURCES = [
 {"agent": "Codex", "status": "首批适配 · 只读导入", "supported": True,
  "note": "读取明确的开始与结束事件；等待确认或补充的时间无法单独恢复。"},
 {"agent": "Claude Code", "status": "已调研 · 尚未接入", "supported": False,
  "note": "需继续验证 hooks 完成与授权恢复语义。"},
 {"agent": "OpenCode", "status": "已调研 · 尚未接入", "supported": False,
  "note": "不同版本存储结构有差异，需独立适配导出格式。"},
 {"agent": "Pi", "status": "已调研 · 尚未接入", "supported": False,
  "note": "模型循环不是用户交互轮次，需验证完成边界。"},
 {"agent": "Oh-My-Pi", "status": "已调研 · 尚未接入", "supported": False,
  "note": "与 Pi 分别适配，需验证完成时间和分支归属。"},
 {"agent": "Antigravity", "status": "数据格式待验证", "supported": False,
  "note": "尚无经过验证的稳定本地导入格式。"},
]


def make_server(store, port=8765, *, directories=None):
    directories = directories or Directories(store)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def allowed(self):
            port = self.server.server_address[1]
            hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
            if self.headers.get("Host") not in hosts:
                self.send_json({"error": "仅接受本机地址访问"}, 403)
                return False
            origin = self.headers.get("Origin")
            if origin and origin not in {"http://" + h for h in hosts}:
                self.send_json({"error": "不接受其他网站的请求"}, 403)
                return False
            return True

        def respond(self, body, content_type, status=200):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
            self.end_headers()
            self.wfile.write(body)

        def send_json(self, data, status=200):
            self.respond(json.dumps(data, ensure_ascii=False, allow_nan=False).encode(),
                         "application/json; charset=utf-8", status)

        def do_GET(self):
            if not self.allowed():
                return
            parsed = urlsplit(self.path)
            try:
                if parsed.path == "/api/report":
                    params = parse_qs(parsed.query)
                    tz = params.get("timezone", ["UTC"])[0]
                    today = datetime.now(ZoneInfo(tz)).date()
                    start = params.get("start", [(today-timedelta(days=6)).isoformat()])[0]
                    end = params.get("end", [today.isoformat()])[0]
                    result = report(store.sessions(), start, end, tz, params.get("agent", ["all"])[0])
                    result["generated_at"] = datetime.now().astimezone().isoformat()
                    self.send_json(result)
                elif parsed.path == "/api/directories":
                    self.send_json({"directories": directories.list()})
                elif parsed.path == "/api/sources":
                    with store.connect() as db:
                        row = db.execute("SELECT count(*),max(imported_at),sum(last_error IS NOT NULL) FROM source").fetchone()
                        imports = [{"session_id": s["session_id"], "project": s["project"],
                          "imported_at_utc": s["imported_at"],
                          "issues": json.loads(s["issues"]) + ([s["last_error"]] if s["last_error"] else [])}
                          for s in db.execute("SELECT session_id,project,issues,last_error,imported_at FROM source ORDER BY imported_at DESC")]
                    self.send_json({"adapters": SOURCES, "registered_files": row[0], "last_imported_at_utc": row[1], "failed_sources": row[2] or 0, "imports": imports,
                                    "privacy": "仅本机存储统计元数据，不保存问题、答复、工具参数或凭据。"})
                elif parsed.path in ("/", "/index.html", "/app.js", "/style.css"):
                    name = "index.html" if parsed.path == "/" else parsed.path[1:]
                    mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css"}[Path(name).suffix]
                    self.respond((WEB/name).read_bytes(), mime + "; charset=utf-8")
                else:
                    self.send_json({"error": "未找到页面"}, 404)
            except (ValueError, ZoneInfoNotFoundError, OverflowError):
                self.send_json({"error": "日期或时区无效；请选择有效范围（最多 367 天）"}, 400)
            except (OSError, sqlite3.Error):
                self.send_json({"error": "本地数据暂时不可读，请检查数据目录权限"}, 500)

        def do_POST(self):
            if not self.allowed():
                return
            if self.path not in ("/api/refresh", "/api/directories"):
                self.send_json({"error": "未找到操作"}, 404)
                return
            if self.headers.get("Content-Type") != "application/json" or self.headers.get("X-AgentTime") != "1":
                self.send_json({"error": "请求格式不受支持"}, 403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                limit = 8192 if self.path == "/api/directories" else 1024
                if not 0 <= length <= limit:
                    raise ValueError("请求过大或格式不正确")
                payload = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/api/directories":
                    if not isinstance(payload, dict) or set(payload) != {"agent", "path", "enabled"}:
                        raise ValueError("目录设置需要指定工具、目录与启用状态")
                    if not isinstance(payload["agent"], str):
                        raise ValueError("请选择有效工具")
                    self.send_json({"directory": directories.save(payload["agent"], payload["path"], payload["enabled"])})
                else:
                    if payload != {}:
                        raise ValueError("请先在配置页保存目录，不能在同步请求中指定任意文件")
                    self.send_json(store.refresh(directories))
            except (ValueError, UnicodeError) as exc:
                # Only our validation messages, never OS exception text/paths.
                message = str(exc) if type(exc) is ValueError else "请求格式不正确"
                self.send_json({"error": message}, 400)
            except (OSError, sqlite3.Error):
                self.send_json({"error": "无法更新本地设置，请检查目录与数据库权限"}, 500)

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
