import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
// 不用 "node:fs"：@types/node 的 `declare module "node:fs" { export * from "fs" }`
// 再导出在 moduleResolution:bundler 下会把 fs.readFileSync 塌缩成单签名
// (path, encoding: "utf-8")，一参二进制读取报 TS2554；裸 "fs" 拿到完整重载。
import fs from "fs";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import {
  PDF_WORKER_BOOT_DEV_PATH,
  PDF_WORKER_BOOT_FILE,
  PDF_WORKER_DEV_PATH,
  PDF_WORKER_OFFICIAL_FILE,
  PDF_WORKER_OFFICIAL_SPECIFIER,
  pdfWorkerBootModule,
} from "./src/reader/formats/pdf-worker-entry.ts";

// Windows 专用：这台机器上 esbuild 在 %TEMP%（AppData\Local\Temp）删除自己
// 写入的临时文件会被系统策略拒绝（"remove %TEMP%\esbuild-*: Access is
// denied"），而任何输入超过 1MB 的 esbuild transform 都会走「写临时文件再
// 交服务进程删除」路径（node_modules/esbuild/lib/main.js 的 randomFileName /
// 1MB 阈值），令 `npm run build` 里 vite 的 CSS 压缩（katex.min.css?inline
// 全字体内联后约 8MB）、JS 转译（mermaid / pdfjs 的超大模块）与大 chunk
// minify 全部失败。Node 的 os.tmpdir() 每次调用都读取 TEMP/TMP（Windows 上
// TEMP 优先、不缓存），因此在本进程最早加载的 vite.config.ts 里把临时目录
// 重定向到项目内可正常写删的目录（npm run build / npm test / tauri:dev 均
// 以仓库根为 cwd 运行；.tmp 已列入 .gitignore）。
if (process.platform === "win32") {
  const esbuildTmpDir = path.join(process.cwd(), ".tmp");
  fs.mkdirSync(esbuildTmpDir, { recursive: true });
  process.env.TEMP = esbuildTmpDir;
  process.env.TMP = esbuildTmpDir;
}

const require = createRequire(import.meta.url);
const host = process.env.TAURI_DEV_HOST;
const OPDS_DEV_PROXY_PATH = "/__lightink/opds-proxy";
const MAX_OPDS_PROXY_BYTES = 80 * 1024 * 1024;

function requestHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function allowedOpdsProxyTarget(raw: string | null): URL | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  try {
    const target = new URL(raw);
    if (
      (target.protocol !== "http:" && target.protocol !== "https:") ||
      target.hostname === "" ||
      target.username !== "" ||
      target.password !== ""
    ) {
      return undefined;
    }
    return target;
  } catch {
    return undefined;
  }
}

async function handleOpdsDevProxy(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    res.statusCode = 405;
    res.end("Method Not Allowed");
    return;
  }
  const incoming = new URL(req.url ?? "/", "http://127.0.0.1");
  const target = allowedOpdsProxyTarget(incoming.searchParams.get("url"));
  if (target === undefined) {
    res.statusCode = 400;
    res.end("Unsupported OPDS url");
    return;
  }
  const headers = new Headers({
    Accept:
      requestHeader(req, "accept") ??
      "application/atom+xml, application/opds+json, application/json, text/xml, */*",
  });
  const authorization = requestHeader(req, "authorization");
  if (authorization !== undefined) headers.set("Authorization", authorization);
  try {
    const response = await fetch(target, {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    res.statusCode = response.status;
    const contentType = response.headers.get("content-type");
    if (contentType !== null) res.setHeader("Content-Type", contentType);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) res.setHeader("Content-Length", contentLength);
    if (response.body === null) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_OPDS_PROXY_BYTES) {
        await reader.cancel().catch(() => undefined);
        res.destroy();
        return;
      }
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve, reject) => {
          res.once("drain", resolve);
          res.once("error", reject);
        });
      }
    }
    res.end();
  } catch (error) {
    res.statusCode = 502;
    res.end(error instanceof Error ? error.message : "OPDS proxy fetch failed");
  }
}

function lightinkPdfWorkerStatic(): Plugin {
  const file = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs");
  const boot = pdfWorkerBootModule(PDF_WORKER_OFFICIAL_SPECIFIER);
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    const pathName = (req.url ?? "").split("?")[0];
    if (pathName === PDF_WORKER_BOOT_DEV_PATH) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end(boot);
      return;
    }
    if (pathName !== PDF_WORKER_DEV_PATH) {
      next();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(file).pipe(res);
  };
  return {
    name: "lightink-pdf-worker-static",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: PDF_WORKER_OFFICIAL_FILE,
        source: fs.readFileSync(file),
      });
      this.emitFile({
        type: "asset",
        fileName: PDF_WORKER_BOOT_FILE,
        source: boot,
      });
    },
  };
}

function lightinkOpdsDevProxy(): Plugin {
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== OPDS_DEV_PROXY_PATH) {
      next();
      return;
    }
    void handleOpdsDevProxy(req, res);
  };
  return {
    name: "lightink-opds-dev-proxy",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [lightinkOpdsDevProxy(), lightinkPdfWorkerStatic()],
  // pdf.js worker 走静态中间件 / 生产 ?url，不再经 Vite worker 打包。
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  build: {
    // 字体资产一律内联为 data URI：导出的独立 HTML（T10, R5）经 file://
    // 打开时没有任何 /assets/ 基座，KaTeX @font-face 的 url() 必须随 CSS
    // 文本自包含，否则公式字体 404。本地桌面应用内联成本可接受。
    assetsInlineLimit: (filePath: string) =>
      /\.(?:woff2?|ttf|otf|eot)(?:\?.*)?$/.test(filePath) || undefined,
  },
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
