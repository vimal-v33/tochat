/**
 * ToChat — Real-Time E2E Encrypted Chat Server
 * Stack: Node.js + WebSocket (ws library)
 * 
 * The server is a RELAY ONLY — it never sees plaintext.
 * All encryption/decryption happens on the client using Web Crypto API (ECDH + AES-GCM).
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// HTTP server to serve the frontend
const httpServer = http.createServer((req, res) => {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// WebSocket server
const wss = new WebSocket.Server({ server: httpServer });

// Connected clients: Map<username, { ws, publicKey }>
const clients = new Map();

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function sendTo(username, data) {
  const client = clients.get(username);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

function getUserList() {
  return Array.from(clients.entries()).map(([username, info]) => ({
    username,
    publicKey: info.publicKey,
  }));
}

wss.on('connection', (ws) => {
  let myUsername = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── JOIN: user registers with username + ECDH public key ──
      case 'join': {
        const { username, publicKey } = msg;
        if (!username || clients.has(username)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Username taken or invalid.' }));
          return;
        }
        myUsername = username;
        clients.set(username, { ws, publicKey });

        // Confirm join + send current user list
        ws.send(JSON.stringify({
          type: 'joined',
          username,
          users: getUserList(),
        }));

        // Notify others
        broadcast({
          type: 'user_joined',
          username,
          publicKey,
          users: getUserList(),
        }, ws);

        console.log(`[+] ${username} joined. (${clients.size} online)`);
        break;
      }

      // ── ENCRYPTED MESSAGE: server relays ciphertext, never decrypts ──
      case 'message': {
        const { to, encryptedPayload, iv, fromPublicKey } = msg;
        if (!myUsername) return;

        sendTo(to, {
          type: 'message',
          from: myUsername,
          to,
          encryptedPayload, // base64 AES-GCM ciphertext
          iv,               // base64 IV
          fromPublicKey,
          timestamp: Date.now(),
        });

        // Confirm delivery
        ws.send(JSON.stringify({ type: 'delivered', to, timestamp: Date.now() }));
        break;
      }

      // ── TYPING indicator ──
      case 'typing': {
        if (!myUsername || !msg.to) return;
        sendTo(msg.to, { type: 'typing', from: myUsername, isTyping: msg.isTyping });
        break;
      }

      // ── PUBLIC KEY request ──
      case 'get_key': {
        const target = clients.get(msg.username);
        if (target) {
          ws.send(JSON.stringify({
            type: 'public_key',
            username: msg.username,
            publicKey: target.publicKey,
          }));
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myUsername) {
      clients.delete(myUsername);
      broadcast({ type: 'user_left', username: myUsername, users: getUserList() });
      console.log(`[-] ${myUsername} left. (${clients.size} online)`);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🔐 ToChat Server running at http://localhost:${PORT}`);
  console.log(`   WebSocket ready. Messages are relay-only — server never decrypts.\n`);
});
