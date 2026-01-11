// server.js - Fixed version with proper pairing code timing + static frontend serving

const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files (put index.html in the same folder as server.js or in /public)
app.use(express.static(path.join(__dirname)));
app.use(express.json());

// Root → serve the nice frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Simple health check for Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Global state
let sock = null;
let isConnecting = false;
let pairingCode = null;
let pairingPhone = null;

// ── Core WhatsApp connection logic ──────────────────────────────────────
async function connectWhatsApp(requestedPhone = null) {
  if (isConnecting) return;
  isConnecting = true;
  pairingCode = null;

  console.log(requestedPhone ? `→ Pairing request for ${requestedPhone}` : '→ Restoring session...');

  try {
    await fs.mkdir('./auth', { recursive: true }).catch(() => {});

    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhatsApp', 'Chrome', '130.0'], // Important: realistic browser helps pairing
      syncFullHistory: false,
      markOnlineOnConnect: true,
      shouldSyncHistoryMessage: () => false,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    // Wait for connection to be ready before generating pairing code
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (connection === 'open') {
        console.log('✓ WhatsApp CONNECTED');
        isConnecting = false;
        pairingCode = null;
        pairingPhone = null;

        try {
          const self = sock.user.id.replace(/:\d+/, '@s.whatsapp.net');
          await sock.sendMessage(self, { text: 'Bot is now online ✓' });
        } catch {}
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        console.log(`Disconnected → code: ${code || 'unknown'}`);

        if (code === DisconnectReason.loggedOut) {
          console.log('Logged out → clearing auth');
          await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
        } else if (code !== DisconnectReason.connectionClosed) {
          setTimeout(() => {
            isConnecting = false;
            connectWhatsApp();
          }, 12000);
        }
        isConnecting = false;
      }

      // Critical: wait for socket to be ready (connecting/qr event) before pairing
      if ((connection === 'connecting' || qr) && requestedPhone && !state.creds.registered) {
        console.log('Socket ready → generating pairing code...');
        await delay(2000); // small safety delay

        try {
          pairingCode = await sock.requestPairingCode(requestedPhone);
          pairingPhone = requestedPhone;
          console.log(`Pairing code generated: ${pairingCode}`);
        } catch (err) {
          console.error('Pairing code FAILED:', err.message);
          pairingCode = 'ERROR';
        }
      }
    });

    // Minimal .ping command
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim().toLowerCase();

      if (text === '.ping') {
        await sock.sendMessage(msg.key.remoteJid, {
          text: `Pong! Uptime: ${Math.floor(process.uptime())}s`
        }).catch(() => {});
      }
    });

  } catch (err) {
    console.error('Critical error:', err.message);
    isConnecting = false;
    pairingCode = 'ERROR';
  }
}

// ── Pair endpoint (called from frontend) ────────────────────────────────
app.post('/pair', async (req, res) => {
  let phone = String(req.body?.phone || '').replace(/[^0-9]/g, '');

  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Invalid phone number (use format: 234xxxxxxxxxx)' });
  }

  // Normalize phone format (Baileys expects no +)
  if (phone.startsWith('0')) phone = '234' + phone.slice(1); // common Nigeria fix

  pairingCode = null;
  pairingPhone = null;

  await connectWhatsApp(phone);

  // Wait for code (max 35 seconds)
  let tries = 0;
  const check = setInterval(() => {
    tries++;

    if (pairingCode) {
      clearInterval(check);

      if (pairingCode === 'ERROR') {
        return res.status(500).json({ error: 'Failed to generate code - try again later' });
      }

      return res.json({
        success: true,
        code: pairingCode,
        phone: pairingPhone
      });
    }

    if (tries >= 35) {
      clearInterval(check);
      res.status(504).json({ error: 'Timeout generating pairing code' });
    }
  }, 1000);
});

// Start server + try auto-restore session
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running → http://localhost:${PORT}`);

  try {
    const hasSession = await fs.stat('./auth/creds.json').catch(() => false);
    if (hasSession) {
      console.log('Previous session found → connecting...');
      await connectWhatsApp();
    } else {
      console.log('No session → waiting for /pair request');
    }
  } catch (e) {
    console.error('Startup error:', e.message);
  }
});