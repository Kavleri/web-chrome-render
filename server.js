import http from "node:http";
import crypto from "node:crypto";
import httpProxy from "http-proxy";

const port = Number.parseInt(process.env.PORT || "10000", 10);
const target = `http://127.0.0.1:${process.env.NOVNC_PORT || 6080}`;
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
  });
  response.end("Authentication required\n");
}

function checkNoVnc() {
  return new Promise((resolve) => {
    const request = http.get(`${target}/vnc.html`, { timeout: 2_000 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
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
    checkNoVnc().then((ready) => {
      response.writeHead(ready ? 200 : 503, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ ok: ready, service: "web-chrome-render" }));
    });
    return;
  }

  if (hasValidBasicAuth(request)) {
    setSession(response);
  } else if (!hasValidSession(request)) {
    unauthorized(response);
    return;
  }

  if (request.url === "/") {
    response.writeHead(302, { Location: "/vnc.html" });
    response.end();
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
