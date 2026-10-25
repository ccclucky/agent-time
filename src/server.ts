import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { Temporal } from "@js-temporal/polyfill";
import { Store } from "./store.js";
import { Directories } from "./directories.js";
import { report } from "./metrics.js";
import { SOURCES } from "./adapters.js";
import { ValidationError } from "./types.js";
const WEB = new URL("../public/", import.meta.url);
// 静态资源白名单：只暴露下面这几个文件，新增资源必须同时登记在这里。
// logo 从 1024px/662KB 的 jpg 换成 136px/26KB 的 png —— 侧栏显示位只有 44px。
const STATIC: Record<string, string> = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/style.css": "style.css",
  "/logo.png": "logo.png",
  "/favicon.png": "favicon.png",
};
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
};
export function makeServer(store: Store, directories = new Directories(store)) {
  const respond = (
    res: ServerResponse,
    body: Buffer | string,
    type = "application/json; charset=utf-8",
    status = 200,
  ) => {
    res.writeHead(status, {
      "Content-Type": type,
      "Content-Length": Buffer.byteLength(body),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(body);
  };
  const json = (res: ServerResponse, data: unknown, status = 200) =>
    respond(res, JSON.stringify(data), undefined, status);
  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      try {
        const address = server.address(),
          port = typeof address === "object" && address ? address.port : 0,
          hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
        if (!hosts.includes(req.headers.host ?? "")) {
          json(res, { error: "仅接受本机地址访问" }, 403);
          return;
        }
        if (
          req.headers.origin &&
          !hosts.map((h) => "http://" + h).includes(req.headers.origin)
        ) {
          json(res, { error: "不接受其他网站的请求" }, 403);
          return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (req.method === "GET") {
          if (url.pathname === "/api/report") {
            const q = url.searchParams,
              tz = q.get("timezone") || "UTC";
            let today: Temporal.PlainDate;
            try {
              today = Temporal.Now.plainDateISO(tz);
            } catch {
              throw new ValidationError("日期或时区无效");
            }
            json(res, {
              ...report(
                store.sessions(),
                q.get("start") || today.subtract({ days: 6 }).toString(),
                q.get("end") || today.toString(),
                tz,
                q.get("agent") || "all",
              ),
              generated_at: new Date().toISOString(),
            });
          } else if (url.pathname === "/api/directories")
            json(res, { directories: directories.list() });
          else if (url.pathname === "/api/sources")
            json(res, { adapters: SOURCES, ...store.sourceInfo() });
          else if (url.pathname === "/api/session/transcript") {
            const id = url.searchParams.get("id");
            if (!id || !/^\S{1,300}$/.test(id))
              throw new ValidationError("缺少有效的会话 id 参数");
            const transcript = store.transcript(id);
            if (!transcript) {
              json(res, { error: "未找到该会话的本地来源记录" }, 404);
              return;
            }
            json(res, transcript);
          } else if (STATIC[url.pathname]) {
            const file = STATIC[url.pathname],
              ext = file.slice(file.lastIndexOf(".") + 1);
            respond(
              res,
              readFileSync(new URL(file, WEB)),
              MIME[ext] ?? "application/octet-stream",
            );
          } else json(res, { error: "未找到页面" }, 404);
        } else if (req.method === "POST") {
          if (!["/api/refresh", "/api/directories"].includes(req.url ?? "")) {
            json(res, { error: "未找到操作" }, 404);
            return;
          }
          if (
            req.headers["content-type"] !== "application/json" ||
            req.headers["x-agenttime"] !== "1"
          ) {
            json(res, { error: "请求格式不受支持" }, 403);
            return;
          }
          const limit = req.url === "/api/directories" ? 8192 : 1024;
          let body = Buffer.alloc(0);
          const length = Number(req.headers["content-length"] ?? 0);
          if (!Number.isInteger(length) || length < 0 || length > limit)
            throw new ValidationError("请求过大或格式不正确");
          for await (const chunk of req) {
            body = Buffer.concat([body, chunk]);
            if (body.length > limit)
              throw new ValidationError("请求过大或格式不正确");
          }
          let p: unknown;
          try {
            p = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(body) || "{}",
            );
          } catch {
            throw new ValidationError("请求格式不正确");
          }
          if (req.url === "/api/directories") {
            if (
              !p ||
              typeof p !== "object" ||
              Array.isArray(p) ||
              Object.keys(p).sort().join(",") !== "agent,enabled,path"
            )
              throw new ValidationError("目录设置需要指定工具、目录与启用状态");
            const v = p as Record<string, unknown>;
            json(res, {
              directory: directories.save(v.agent, v.path, v.enabled),
            });
          } else {
            if (
              !p ||
              typeof p !== "object" ||
              Array.isArray(p) ||
              Object.keys(p).length
            )
              throw new ValidationError(
                "请先在配置页保存目录，不能在同步请求中指定任意文件",
              );
            json(res, await store.refresh(directories));
          }
        } else json(res, { error: "请求方法不受支持" }, 405);
      } catch (e) {
        if (!res.headersSent)
          json(
            res,
            {
              error:
                e instanceof ValidationError
                  ? e.message
                  : "本地数据暂时不可读，请检查路径、权限及端口",
            },
            e instanceof ValidationError ? 400 : 500,
          );
        else res.end();
      }
    },
  );
  return server;
}
