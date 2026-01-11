// server.js
// Reliable WhatsApp pairing-code bot + frontend serving
// January 2026 best practices

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

app.use(express.json());
app.use(express.static(path.join(__dirname))); // serves index.html & other static files

// Root route → your beautiful frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check endpoint (Render & monitoring)
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Bot state
let sock = null;
let isConnecting = false;
let currentPairingCode = null;
let currentPairPhone = null;

// ── Main WhatsApp connection logic ───────────────────────────────────────
async function connectToWhatsApp(phoneNumber = null) {
  if (isConnecting) return;
  isConnecting = true;
  currentPairingCode = null;
  currentPairPhone = null;

  console.log(phoneNumber
    ? `Starting pairing flow for: ${phoneNumber}`
    : 'Trying to restore previous session...');

  try {
    await fs.mkdir('./auth', { recursive: true }).catch(() => {});

    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhatsApp', 'Chrome', '131.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      shouldSyncHistoryMessage: () => false,
      defaultQueryTimeoutMs: 90000,
      connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    // ── State tracking for safe pairing code timing ──────────────────────
    let socketReady = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Any of these signals usually means we can safely request pairing code
      if (qr || connection === 'connecting' || connection === 'open') {
        socketReady = true;
      }

      if (connection === 'open') {
        console.log('SUCCESS: WhatsApp connection established');
        isConnecting = false;
        currentPairingCode = null;
        currentPairPhone = null;

        try {
          const selfJid = sock.user?.id?.replace(/:\d+/, '@s.whatsapp.net');
          if (selfJid) {
            await sock.sendMessage(selfJid, { text: 'Bot is now online ✓' });
          }
        } catch {}
      }

      if (connection === 'close') {
        const reasonCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed - reason: ${reasonCode || 'unknown'}`);

        if (reasonCode === DisconnectReason.loggedOut) {
          console.log('Logged out → clearing auth files');
          await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
        } else if (reasonCode !== DisconnectReason.connectionClosed) {
          console.log('Will attempt reconnect in 12 seconds...');
          setTimeout(() => {
            isConnecting = false;
            connectToWhatsApp();
          }, 12000);
        }
        isConnecting = false;
      }

      // Generate pairing code only when socket signals readiness
      if (phoneNumber && !state.creds.registered && socketReady && !currentPairingCode) {
        console.log('Socket appears ready → requesting pairing code...');
        await delay(2000);

        try {
          const code = await sock.requestPairingCode(phoneNumber);
          if (code && code.length >= 6 && /^[A-Za-z0-9]+$/.test(code)) {
            currentPairingCode = code;
            currentPairPhone = phoneNumber;
            console.log(`VALID pairing code generated: ${code}`);
          } else {
            console.log('Generated code looks invalid:', code);
            currentPairingCode = 'INVALID';
          }
        } catch (err) {
          console.error('requestPairingCode failed:', err.message);
          currentPairingCode = 'ERROR';
        }
      }
    });

    // ── Message handler - only ping command ──────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;

      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const text = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ''
      ).trim().toLowerCase();

      if (text === '.ping') {
        try {
          await sock.sendMessage(msg.key.remoteJid, {
            text: `Pong! Bot uptime: ${Math.floor(process.uptime())} seconds`
          });
        } catch (err) {
          console.error('Failed to send ping reply:', err.message);
        }
      }
    });

  } catch (err) {
    console.error('Critical startup error:', err.message);
    isConnecting = false;
    currentPairingCode = 'ERROR';
  }
}

// ── API endpoint for frontend ────────────────────────────────────────────
app.post('/pair', async (req, res) => {
  let phone = String(req.body?.phone || '').replace(/[^0-9]/g, '');

  if (!phone || phone.length < 10) {
    return res.status(400).json({
      success: false,
      error: 'Invalid phone number. Use format like 2348012345678'
    });
  }

  // Quick Nigeria common fix
  if (phone.startsWith('0')) {
    phone = '234' + phone.slice(1);
  }

  currentPairingCode = null;
  currentPairPhone = null;

  await connectToWhatsApp(phone);

  // Wait for code (max 40 seconds timeout)
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;

    if (currentPairingCode) {
      clearInterval(interval);

      if (currentPairingCode === 'ERROR' || currentPairingCode === 'INVALID') {
        return res.status(500).json({
          success: false,
          error: 'Failed to generate valid pairing code. Please try again.'
        });
      }

      return res.json({
        success: true,
        code: currentPairingCode,
        phone: currentPairPhone
      });
    }

    if (attempts >= 40) {
      clearInterval(interval);
      res.status(504).json({
        success: false,
        error: 'Timeout waiting for pairing code'
      });
    }
  }, 1000);
});

// ── Start server ─────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Frontend should be available at: http://localhost:' + PORT);

  // Auto-reconnect if we have previous credentials
  try {
    const hasCreds = await fs.stat('./auth/creds.json').catch(() => false);
    if (hasCreds) {
      console.log('Found previous credentials → auto connecting...');
      await connectToWhatsApp();
    } else {
      console.log('No previous session found. Waiting for pairing request.');
    }
  } catch (err) {
    console.error('Startup session check failed:', err.message);
  }
});