// server.js - Simple WhatsApp Bot with Ping Command (Deployable on Render)

const express = require('express');
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

app.use(express.json());

// Global state
let sock = null;
let isConnecting = false;
let pairingCode = null;
let connectedPhone = null;

// Ensure auth directory
async function ensureAuthDir() {
  try {
    await fs.mkdir('./auth', { recursive: true });
  } catch (err) {
    console.error('Failed to create auth dir:', err.message);
  }
}

// Connect to WhatsApp
async function connectWhatsApp(phone = null) {
  if (isConnecting) return;
  isConnecting = true;

  console.log(phone ? `Connecting with phone: ${phone}` : 'Restoring session...');

  try {
    await ensureAuthDir();

    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('✅ WhatsApp connected');
        isConnecting = false;
        pairingCode = null;
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        console.log(`Disconnected - reason: ${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Logged out - clearing auth');
          await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
          await ensureAuthDir();
        } else if (statusCode !== DisconnectReason.connectionClosed) {
          console.log('Reconnecting in 10s...');
          setTimeout(() => {
            isConnecting = false;
            connectWhatsApp();
          }, 10000);
        } else {
          isConnecting = false;
        }
      }
    });

    // Message handler - only .ping
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const body = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''
      ).trim().toLowerCase();

      if (body === '.ping') {
        try {
          await sock.sendMessage(from, { text: `Pong! Uptime: ${Math.floor(process.uptime())}s` });
        } catch (err) {
          console.error('Failed to send pong:', err.message);
        }
      }
    });

    // Pairing if phone provided
    if (phone && !state.creds.registered) {
      console.log(`Generating pairing code for ${phone}`);
      await delay(3000);
      try {
        pairingCode = await sock.requestPairingCode(phone);
        connectedPhone = phone;
        console.log(`Pairing code: ${pairingCode}`);
      } catch (err) {
        console.error('Pairing failed:', err.message);
        pairingCode = 'FAILED';
      }
    }

  } catch (err) {
    console.error('Connection error:', err.message);
    isConnecting = false;
    pairingCode = 'FAILED';
  }
}

// Routes for deployment
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    whatsapp: sock?.user ? 'connected' : 'disconnected',
    uptime: Math.floor(process.uptime())
  });
});

app.post('/pair', async (req, res) => {
  const phone = req.body.phone?.replace(/\D/g, '');

  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Invalid phone number (country code, no +)' });
  }

  pairingCode = null;
  connectedPhone = phone;

  await connectWhatsApp(phone);

  // Wait for code
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;
    if (pairingCode) {
      clearInterval(interval);
      if (pairingCode === 'FAILED') {
        return res.status(500).json({ error: 'Failed to generate code' });
      }
      return res.json({ code: pairingCode, phone });
    }
    if (attempts > 25) {
      clearInterval(interval);
      res.status(504).json({ error: 'Timeout' });
    }
  }, 1000);
});

app.post('/reset', async (req, res) => {
  try {
    await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
    await ensureAuthDir();
    sock?.end();
    sock = null;
    isConnecting = false;
    pairingCode = null;
    connectedPhone = null;
    res.json({ success: true, message: 'Reset complete' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server first, then WhatsApp
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);

  // Auto-connect if auth exists
  try {
    await ensureAuthDir();
    const hasAuth = await fs.stat('./auth/creds.json').catch(() => false);
    if (hasAuth) {
      console.log('Found auth - connecting...');
      await connectWhatsApp();
    } else {
      console.log('No auth - waiting for /pair');
    }
  } catch (err) {
    console.error('Startup error:', err.message);
  }
});