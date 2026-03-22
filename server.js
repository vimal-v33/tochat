/**
 * ToChat v3 — Real-Time E2E Encrypted Chat Server
 * Added: MongoDB Chat History + Cloudinary Image Upload
 */

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const CLOUD_NAME  = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY     = process.env.CLOUDINARY_API_KEY;
const API_SECRET  = process.env.CLOUDINARY_API_SECRET;

// MongoDB connection
let db = null;
async function connectDB() {
  if (!MONGODB_URI) { console.log('⚠️  No MONGODB_URI — history disabled'); return; }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db('tochat');
    console.log('✅ MongoDB connected');
  } catch(e) {
    console.error('MongoDB error:', e.message);
  }
}
connectDB();

// Save message to DB
async function saveMessage(from, to, content, msgType = 'text') {
  if (!db) return;
  try {
    await db.collection('messages').insertOne({
      from, to, content, msgType,
      timestamp: new Date(),
      room: [from, to].sort().join('_'),
    });
  } catch(e) { console.error('Save error:', e.message); }
}

// Get history between 2 users
async function getHistory(user1, user2, limit = 50) {
  if (!db) return [];
  try {
    const room = [user1, user2].sort().join('_');
    return await db.collection('messages')
      .find({ room })
      .sort({ timestamp: -1 })
      .limit(limit)
      .toArray()
      .then(msgs => msgs.reverse());
  } catch(e) { return []; }
}

// HTTP server
const httpServer = http.createServer((req, res) => {

  // ── UPLOAD ENDPOINT ──
  if (req.method === 'POST' && req.url === '/upload') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { fileData, fileType, fileName } = JSON.parse(body);
        const timestamp = Math.floor(Date.now() / 1000);
        const crypto = require('crypto');
        const signature = crypto.createHash('sha1').update(`timestamp=${timestamp}${API_SECRET}`).digest('hex');
        const boundary = '----FormBoundary' + Math.random().toString(36);
        const base64Data = fileData.split(',')[1] || fileData;

        const formBody = [
          `--${boundary}`,
          'Content-Disposition: form-data; name="file"',
          '',
          `data:${fileType};base64,${base64Data}`,
          `--${boundary}`,
          'Content-Disposition: form-data; name="api_key"',
          '',
          API_KEY,
          `--${boundary}`,
          'Content-Disposition: form-data; name="timestamp"',
          '',
          timestamp,
          `--${boundary}`,
          'Content-Disposition: form-data; name="signature"',
          '',
          signature,
          `--${boundary}`,
          'Content-Disposition: form-data; name="folder"',
          '',
          'tochat',
          `--${boundary}--`,
        ].join('\r\n');

        const options = {
          hostname: 'api.cloudinary.com',
          path: `/v1_1/${CLOUD_NAME}/auto/upload`,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': Buffer.byteLength(formBody),
          },
        };

        const cloudReq = https.request(options, (cloudRes) => {
          let data = '';
          cloudRes.on('data', chunk => { data += chunk; });
          cloudRes.on('end', () => {
            try {
              const result = JSON.parse(data);
              res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
              res.end(JSON.stringify({ url: result.secure_url, type: result.resource_type, name: fileName }));
            } catch(e) {
              res.writeHead(500); res.end(JSON.stringify({ error: 'Upload failed' }));
            }
          });
        });
        cloudReq.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        cloudReq.write(formBody);
        cloudReq.end();
      } catch(e) { res.writeHead(400); res.end(JSON.stringify({ error: 'Bad request' })); }
    });
    return;
  }

  // ── HISTORY ENDPOINT ──
  if (req.method === 'GET' && req.url.startsWith('/history')) {
    const url = new URL(req.url, `http://localhost`);
    const user1 = url.searchParams.get('user1');
    const user2 = url.searchParams.get('user2');
    getHistory(user1, user2).then(msgs => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(msgs));
    });
    return;
  }

  // CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST,GET', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // Static files
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  const contentTypes = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    res.end(data);
  });
});

// WebSocket
const wss = new WebSocket.Server({ server: httpServer });
const clients = new Map();

function sendTo(username, data) {
  const client = clients.get(username);
  if (client && client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(data));
}

function broadcast(data, excludeWs = null) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function getUserList() {
  return Array.from(clients.entries()).map(([username, info]) => ({ username, publicKey: info.publicKey }));
}

wss.on('connection', (ws) => {
  let myUsername = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch(msg.type) {
      case 'join': {
        const { username, publicKey } = msg;
        if (!username || clients.has(username)) {
          ws.send(JSON.stringify({ type:'error', message:'Username taken or invalid.' })); return;
        }
        myUsername = username;
        clients.set(username, { ws, publicKey });
        ws.send(JSON.stringify({ type:'joined', username, users: getUserList() }));
        broadcast({ type:'user_joined', username, publicKey, users: getUserList() }, ws);
        console.log(`[+] ${username} joined. (${clients.size} online)`);
        break;
      }

      case 'message': {
        const { to, encryptedPayload, iv, fromPublicKey } = msg;
        if (!myUsername) return;
        sendTo(to, { type:'message', from:myUsername, to, encryptedPayload, iv, fromPublicKey, timestamp: Date.now() });
        ws.send(JSON.stringify({ type:'delivered', to, timestamp: Date.now() }));
        // Save encrypted message to DB
        await saveMessage(myUsername, to, { encryptedPayload, iv }, 'text');
        break;
      }

      case 'file_message': {
        const { to, fileUrl, fileType, fileName } = msg;
        if (!myUsername) return;
        sendTo(to, { type:'file_message', from:myUsername, to, fileUrl, fileType, fileName, timestamp: Date.now() });
        ws.send(JSON.stringify({ type:'delivered', to, timestamp: Date.now() }));
        await saveMessage(myUsername, to, { fileUrl, fileType, fileName }, 'file');
        break;
      }

      case 'get_history': {
        const { withUser } = msg;
        if (!myUsername) return;
        const history = await getHistory(myUsername, withUser);
        ws.send(JSON.stringify({ type:'history', withUser, messages: history }));
        break;
      }

      case 'typing': {
        if (!myUsername || !msg.to) return;
        sendTo(msg.to, { type:'typing', from:myUsername, isTyping:msg.isTyping });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myUsername) {
      clients.delete(myUsername);
      broadcast({ type:'user_left', username:myUsername, users: getUserList() });
      console.log(`[-] ${myUsername} left. (${clients.size} online)`);
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n🔐 ToChat v3 running at http://localhost:${PORT}`);
  console.log(`   MongoDB: ${MONGODB_URI ? '✅' : '❌'} | Cloudinary: ${CLOUD_NAME ? '✅' : '❌'}\n`);
});
