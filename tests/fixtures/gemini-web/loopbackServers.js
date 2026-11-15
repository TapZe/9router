// Loopback fixtures for the Gemini Web transport. These servers implement just
// enough of each proxy protocol to prove real TCP handshakes: no external
// network, no captured credentials, no fixed ports.

import http from "node:http";
import https from "node:https";
import net from "node:net";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      resolve(`127.0.0.1:${address.port}`);
    });
  });
}

/** Track every accepted socket so a fixture shutdown never waits on one. */
function trackSockets(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };
}

function closeServer(server, destroySockets) {
  return new Promise((resolve) => {
    destroySockets();
    server.closeAllConnections?.();
    server.close(resolve);
  });
}

export async function startHeaderServer({ headerBytes = 64 * 1024, body = "ok" } = {}) {
  const server = http.createServer((request, response) => {
    server.requestCount += 1;
    response.writeHead(200, {
      "content-type": "text/plain",
      "x-large-header": "a".repeat(headerBytes),
    });
    response.end(body);
  });
  server.requestCount = 0;
  const destroySockets = trackSockets(server);
  const host = await listen(server);
  return {
    host,
    url: `http://${host}/`,
    origin: `http://${host}`,
    requestCount: () => server.requestCount,
    close: () => closeServer(server, destroySockets),
  };
}

export async function startHttpConnectProxy() {
  const server = http.createServer((request, response) => {
    response.writeHead(405, { "content-type": "text/plain" });
    response.end("CONNECT only");
  });
  server.connectCount = 0;
  server.on("connect", (request, clientSocket, head) => {
    server.connectCount += 1;
    const separator = request.url.lastIndexOf(":");
    const host = request.url.slice(0, separator).replace(/^\[|\]$/g, "");
    const port = Number(request.url.slice(separator + 1));
    const upstream = net.connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  const destroySockets = trackSockets(server);
  const host = await listen(server);
  return {
    url: `http://${host}`,
    connectCount: () => server.connectCount,
    close: () => closeServer(server, destroySockets),
  };
}

function pipeSocksSocket(socket, rest, host, port, reply) {
  socket.pause();
  // The fixture listens on 127.0.0.1. Clients that resolve "localhost" may
  // hand us the IPv6 loopback instead, so normalize both forms while still
  // exercising the domain-address (4a/5h) and resolved-address paths.
  let targetHost = host;
  if (targetHost === "localhost" || targetHost === "::1" || targetHost === "0:0:0:0:0:0:0:1") {
    targetHost = "127.0.0.1";
  }
  const upstream = net.connect(port, targetHost, () => {
    socket.write(reply);
    if (rest && rest.length > 0) upstream.write(rest);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

export async function startSocks5Proxy() {
  const server = net.createServer((socket) => {
    let stage = "greeting";
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount) return;
        socket.write(Buffer.from([0x05, 0x00]));
        buffer = buffer.subarray(2 + methodCount);
        stage = "request";
      }
      if (stage !== "request") return;
      if (buffer.length < 4) return;
      const addressType = buffer[3];
      let host;
      let addressLength;
      if (addressType === 0x01) {
        if (buffer.length < 10) return;
        host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
        addressLength = 4;
      } else if (addressType === 0x03) {
        if (buffer.length < 5) return;
        const nameLength = buffer[4];
        if (buffer.length < 5 + nameLength + 2) return;
        host = buffer.subarray(5, 5 + nameLength).toString("utf8");
        addressLength = 1 + nameLength;
      } else if (addressType === 0x04) {
        if (buffer.length < 22) return;
        const parts = [];
        for (let offset = 0; offset < 16; offset += 2) {
          parts.push(buffer.readUInt16BE(4 + offset).toString(16));
        }
        host = parts.join(":");
        addressLength = 16;
      } else {
        socket.destroy();
        return;
      }
      if (buffer.length < 4 + addressLength + 2) return;
      const port = buffer.readUInt16BE(4 + addressLength);
      const rest = buffer.subarray(4 + addressLength + 2);
      socket.removeListener("data", onData);
      stage = "done";
      server.handshakes += 1;
      pipeSocksSocket(socket, rest, host, port, Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  server.handshakes = 0;
  const destroySockets = trackSockets(server);
  const host = await listen(server);
  return {
    url: `socks5://${host}`,
    handshakes: () => server.handshakes,
    close: () => closeServer(server, destroySockets),
  };
}

export async function startSocks4Proxy() {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let parsed = false;
    const onData = (chunk) => {
      if (parsed) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 9) return;
      if (buffer[0] !== 0x04 || buffer[1] !== 0x01) {
        socket.destroy();
        return;
      }
      const port = buffer.readUInt16BE(2);
      const address = [buffer[4], buffer[5], buffer[6], buffer[7]];
      let cursor = 8;
      const userIdEnd = buffer.indexOf(0x00, cursor);
      if (userIdEnd === -1) return;
      cursor = userIdEnd + 1;
      let host;
      const isSocks4a = address[0] === 0 && address[1] === 0 && address[2] === 0 && address[3] !== 0;
      if (isSocks4a) {
        const hostEnd = buffer.indexOf(0x00, cursor);
        if (hostEnd === -1) return;
        host = buffer.subarray(cursor, hostEnd).toString("utf8");
        cursor = hostEnd + 1;
      } else {
        host = address.join(".");
      }
      const rest = buffer.subarray(cursor);
      parsed = true;
      socket.removeListener("data", onData);
      server.handshakes += 1;
      pipeSocksSocket(socket, rest, host, port, Buffer.from([0x00, 0x5a, 0, 0, 0, 0, 0, 0]));
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
  server.handshakes = 0;
  const destroySockets = trackSockets(server);
  const host = await listen(server);
  return {
    url: `socks4://${host}`,
    handshakes: () => server.handshakes,
    close: () => closeServer(server, destroySockets),
  };
}

/** HTTPS server with a self-signed certificate for 127.0.0.1. */
export async function startSelfSignedTlsServer() {
  const forgeModule = await import("node-forge");
  const forge = forgeModule.default ?? forgeModule;
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 3_600_000);
  const subject = [{ name: "commonName", value: "127.0.0.1" }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    { name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());

  const server = https.createServer(
    {
      key: forge.pki.privateKeyToPem(keys.privateKey),
      cert: forge.pki.certificateToPem(certificate),
    },
    (request, response) => {
      server.requestCount += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("secure-ok");
    }
  );
  server.requestCount = 0;
  server.tlsClientErrors = 0;
  server.on("tlsClientError", () => {
    server.tlsClientErrors += 1;
  });
  const destroySockets = trackSockets(server);
  const host = await listen(server);
  return {
    host,
    url: `https://${host}/`,
    requestCount: () => server.requestCount,
    tlsClientErrors: () => server.tlsClientErrors,
    close: () => closeServer(server, destroySockets),
  };
}
