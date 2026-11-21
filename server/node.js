import http from 'node:http';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createSqliteDriver } from './driver-sqlite.js';
import { createSqlStore } from './store-sql.js';
import { createApp } from './app.js';
import { configFromEnv } from './config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const dataDir = path.join(root, 'data');
const dbPath = process.env.NILU_DB || path.join(dataDir, 'nilu.db');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const PUBLIC_FILES = new Set(['/', '/index.html', '/favicon.ico', '/robots.txt', '/.nojekyll']);

function isPublicPath(pathname) {
  if (PUBLIC_FILES.has(pathname)) return true;
  return pathname.startsWith('/assets/') && !pathname.split('/').some((part) => part.startsWith('.'));
}

function contentType(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function readRequestBody(request, limit = 300 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('body too large');
      error.code = 'BODY_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  await mkdir(dataDir, { recursive: true });
  const schema = await readFile(path.join(here, 'schema.sql'), 'utf8');
  const driver = createSqliteDriver(dbPath);
  const store = createSqlStore(driver);
  await store.init(schema);

  const config = configFromEnv(process.env);
  const localOrigins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  config.appOrigins = [...new Set([...config.appOrigins, ...localOrigins])];
  const app = createApp({ store, config });

  const server = http.createServer(async (request, response) => {
    const started = Date.now();
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || `127.0.0.1:${port}`}`);
      if (url.pathname.startsWith('/api/')) {
        let body;
        if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
          try {
            body = await readRequestBody(request);
          } catch (error) {
            if (error.code === 'BODY_TOO_LARGE') {
              response.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify({ error: 'body_too_large', message: '提交的内容太大了' }));
              return;
            }
            throw error;
          }
        }
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        }
        const apiRequest = new Request(url, {
          method: request.method,
          headers,
          body: body && body.length ? body : undefined,
        });
        const apiResponse = await app.fetch(apiRequest);
        const responseHeaders = {};
        apiResponse.headers.forEach((value, key) => { responseHeaders[key] = value; });
        response.writeHead(apiResponse.status, responseHeaders);
        response.end(Buffer.from(await apiResponse.arrayBuffer()));
        return;
      }

      if (!['GET', 'HEAD'].includes(request.method || 'GET')) {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end('Method Not Allowed');
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400);
        response.end('Bad Request');
        return;
      }
      if (pathname === '/') pathname = '/index.html';
      if (pathname.split('/').some((part) => part === '..' || part === '.') || pathname.includes('\\')) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      if (!isPublicPath(pathname)) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }
      const filePath = path.resolve(root, `.${pathname}`);
      const assetRoot = path.join(root, 'assets');
      const withinRoot = pathname.startsWith('/assets/')
        ? filePath.startsWith(assetRoot + path.sep)
        : filePath === path.join(root, pathname.slice(1));
      if (!withinRoot) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
      }
      let data;
      try {
        data = await readFile(filePath);
      } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Not Found');
        return;
      }
      const isHtml = pathname.endsWith('.html');
      response.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Content-Length': data.length,
        'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=300',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      if (request.method === 'HEAD') response.end();
      else response.end(data);
    } catch (error) {
      console.error('request failed', error);
      if (!response.headersSent) {
        response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      }
      response.end(JSON.stringify({ error: 'internal_error', message: '服务器开了个小差' }));
    } finally {
      if (process.env.NILU_LOG !== '0') {
        console.log(`${request.method} ${request.url} ${response.statusCode} ${Date.now() - started}ms`);
      }
    }
  });

  server.listen(port, host, () => {
    console.log(`逆旅 · 本地服务 http://${host}:${port}`);
    console.log(`数据库 ${dbPath}`);
    console.log(`账号登录 ${config.githubClientId ? 'GitHub OAuth 已配置' : '未配置 GitHub OAuth'}${config.devAuth ? ' · 本地测试登录已开启' : ''}`);
  });

  const shutdown = () => {
    server.close(() => {
      driver.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
