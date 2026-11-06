// The local cells' egress proxy (plan Task 13). `ensureEgress` runs this file's text with `node -e` in the
// factory-egress container. It admits only the host:port pairs in EGRESS_ALLOW: CONNECT for HTTPS, and plain
// HTTP forwarding for the control plane and Azurite. Everything else gets 403. Built-in modules only.
import { createServer, request } from "node:http";
import { connect } from "node:net";

const allow = new Set((process.env.EGRESS_ALLOW ?? "").split(",").filter(Boolean));
const allowed = (host, port) => allow.has(`${host.toLowerCase()}:${port}`);

const server = createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url ?? "");
  } catch {
    return void res.writeHead(400).end();
  }
  const port = url.port || "80";
  if (url.protocol !== "http:" || !allowed(url.hostname, port)) return void res.writeHead(403).end();
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const up = request({ host: url.hostname, port, method: req.method, path: url.pathname + url.search, headers }, (upRes) => {
    res.writeHead(upRes.statusCode ?? 502, upRes.headers);
    upRes.pipe(res);
  });
  up.on("error", () => (res.headersSent ? res.destroy() : res.writeHead(502).end()));
  res.on("close", () => up.destroy());
  req.pipe(up);
});

server.on("connect", (req, socket, head) => {
  const target = req.url ?? "";
  const i = target.lastIndexOf(":");
  const host = target.slice(0, i);
  const port = target.slice(i + 1);
  socket.on("error", () => {});
  if (i < 1 || !allowed(host, port)) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  let open = false;
  const up = connect(Number(port), host, () => {
    open = true;
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", () => (open ? socket.destroy() : socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n")));
  socket.on("close", () => up.destroy());
});

server.listen(3128);
