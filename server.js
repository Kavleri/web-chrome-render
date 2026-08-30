import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import httpProxy from "http-proxy";

const port = Number.parseInt(process.env.PORT || "10000", 10);
const noVncRoot = process.env.NOVNC_ROOT || "/usr/share/novnc";
const mobileCssPath = process.env.MOBILE_CSS_PATH || "/app/mobile.css";
const target = `http://127.0.0.1:${process.env.NOVNC_PORT || 6080}`;
const noVncEntry = "/vnc.html?autoconnect=1&resize=scale&view_only=0&view_clip=0&reconnect=1&reconnect_delay=5000&path=websockify";
const username = process.env.BROWSER_AUTH_USER || "";
const password = process.env.BROWSER_AUTH_PASSWORD || "";

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port");
}

if (!username || !password) {
  throw new Error("BROWSER_AUTH_USER and BROWSER_AUTH_PASSWORD are required");
}

const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const sessionCookieName = "browser_session";
const sessionTtlMs = 12 * 60 * 60 * 1000;
const sessions = new Map();
const proxy = httpProxy.createProxyServer({
  target,
  ws: true,
  changeOrigin: true,
  xfwd: true,
  proxyTimeout: 30_000,
});

function unauthorized(response) {
  response.writeHead(401, {
    "Content-Type": "text/plain; charset=utf-8",
    "WWW-Authenticate": 'Basic realm="Chrome desktop", charset="UTF-8"',
    "Cache-Control": "no-store",
    "Permissions-Policy": "clipboard-read=(self), clipboard-write=(self)",
  });
  response.end("Authentication required\n");
}

function checkNoVnc() {
  return fs.existsSync(path.join(noVncRoot, "vnc.html"));
}

function safeNoVncPath(requestPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestPath || "/", "http://localhost").pathname);
  } catch {
    return null;
  }
  const relativePath = pathname === "/" ? "vnc.html" : pathname.replace(/^\/+/, "");
  const absolutePath = path.resolve(noVncRoot, relativePath);
  const root = path.resolve(noVncRoot);
  const rootWithSeparator = `${root}${path.sep}`;
  if (absolutePath !== root && !absolutePath.startsWith(rootWithSeparator)) {
    return null;
  }
  return absolutePath;
}

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function serveNoVncAsset(request, response) {
  const assetPath = safeNoVncPath(request.url);
  if (!assetPath) {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid asset path\n");
    return true;
  }

  let stats;
  try {
    stats = fs.statSync(assetPath);
  } catch {
    return false;
  }
  if (!stats.isFile()) {
    return false;
  }

  if (assetPath === path.join(noVncRoot, "vnc.html")) {
    fs.readFile(assetPath, "utf8", (error, html) => {
      if (error) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Unable to load noVNC\n");
        return;
      }
      const responsiveHtml = html.replace(
        /<\/head>/i,
        '    <link rel="stylesheet" href="/mobile.css">\n</head>',
      );
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'",
        "Permissions-Policy": "clipboard-read=(self), clipboard-write=(self)",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end(responsiveHtml);
    });
    return true;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; script-src 'self' 'unsafe-inline'",
    "Permissions-Policy": "clipboard-read=(self), clipboard-write=(self)",
    "Content-Type": mimeTypes.get(path.extname(assetPath).toLowerCase()) || "application/octet-stream",
  });
  fs.createReadStream(assetPath).on("error", () => response.destroy()).pipe(response);
  return true;
}

function hasValidBasicAuth(request) {
  const authorization = request.headers.authorization || "";
  const actual = Buffer.from(authorization);
  const expected = Buffer.from(expectedAuthorization);
  if (actual.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(actual, expected);
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie || "";
  for (const cookie of cookies.split(";")) {
    const [key, ...value] = cookie.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return "";
}

function hasValidSession(request) {
  const token = cookieValue(request, sessionCookieName);
  const expiresAt = sessions.get(token);
  if (!token || !expiresAt) {
    return false;
  }
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  sessions.set(token, Date.now() + sessionTtlMs);
  return true;
}

const sessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) {
      sessions.delete(token);
    }
  }
}, sessionTtlMs);
sessionCleanup.unref();

function setSession(response) {
  const token = crypto.randomBytes(32).toString("base64url");
  sessions.set(token, Date.now() + sessionTtlMs);
  response.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${sessionTtlMs / 1000}`,
  );
}

function proxyError(error, request, response) {
  console.error(`Proxy error for ${request.url}:`, error.message);
  if (response && typeof response.writeHead === "function") {
    if (!response.headersSent) {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    response.end("The browser desktop is starting. Please retry shortly.\n");
    return;
  }
  response?.destroy?.();
}

proxy.on("error", proxyError);

const server = http.createServer((request, response) => {
  if (request.url === "/health" || request.url?.startsWith("/health?")) {
    const ready = checkNoVnc();
    response.writeHead(ready ? 200 : 503, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ ok: ready, service: "web-chrome-render" }));
    return;
  }

  if (hasValidBasicAuth(request)) {
    setSession(response);
  } else if (!hasValidSession(request)) {
    unauthorized(response);
    return;
  }

  if (request.url === "/" || request.url === "/vnc.html") {
    response.writeHead(302, {
      "Cache-Control": "no-store",
      "Location": noVncEntry,
      "Permissions-Policy": "clipboard-read=(self), clipboard-write=(self)",
    });
    response.end();
    return;
  }

  if (request.url === "/mobile.css") {
    fs.createReadStream(mobileCssPath)
      .on("error", () => {
        if (!response.headersSent) {
          response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        }
        response.end("Not found\n");
      })
      .on("open", () => {
        response.writeHead(200, {
          "Cache-Control": "no-store",
          "Content-Type": "text/css; charset=utf-8",
          "Permissions-Policy": "clipboard-read=(self), clipboard-write=(self)",
        });
      })
      .pipe(response);
    return;
  }

  if (serveNoVncAsset(request, response)) {
    return;
  }

  proxy.web(request, response);
});

server.on("upgrade", (request, socket, head) => {
  if (!hasValidSession(request) && !hasValidBasicAuth(request)) {
    socket.write(
      "HTTP/1.1 401 Unauthorized\r\n" +
      'WWW-Authenticate: Basic realm="Chrome desktop", charset="UTF-8"\r\n' +
      "Connection: close\r\n\r\n",
    );
    socket.destroy();
    return;
  }

  proxy.ws(request, socket, head);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Chrome desktop proxy listening on 0.0.0.0:${port}`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
