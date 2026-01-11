const express = require('express');
const fs = require('fs/promises');
const path = require('path');
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

// Simple root page so "Cannot GET /" disappears
app.get('/', (req, res) => {
  res.send(`
    <h1>WhatsApp Pairing Bot</h1>
    <p>Use POST <code>/pair</code> endpoint with JSON body: <code>{"phone": "234xxxxxxxxxx"}</code></p>
    <p>Health check: <a href="/health">/health</a></p>
    <p><small>Running on Render • ${new Date().toISOString()}</small></p>
  `);
});

// Health check (Render likes this)
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    time: new Date().toISOString()
  });
});

let sock = null;
let isConnecting = false;
let lastPairingCode = null;
let lastPhone = null;

// ── WhatsApp Connection ───────────────────────────────────────
async function connectToWhatsApp(phoneNumber = null) {
  if (isConnecting) return false;
  isConnecting = true;

  console.log(phoneNumber 
    ? `Starting connection with pairing request for ${phoneNumber}`
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
      browser: ['WhatsApp Bot', 'Chrome', '120.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('CONNECTED TO WHATSAPP SUCCESSFULLY');
        isConnecting = false;
        lastPairingCode = null;
        lastPhone = null;

        // Optional: notify yourself
        const self = sock.user?.id?.replace(/:\d+/, '@s.whatsapp.net');
        if (self) {
          await sock.sendMessage(self, { text: 'Bot is now online!' }).catch(() => {});
        }
      }

      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed - reason: ${reason || 'unknown'}`);

        if (reason === DisconnectReason.loggedOut) {
          console.log('Logged out → clearing session');
          await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
        } else if (reason !== DisconnectReason.connectionClosed) {
          setTimeout(() => {
            isConnecting = false;
            connectToWhatsApp();
          }, 10000);
        }
        isConnecting = false;
      }
    });

    // Only generate pairing code when explicitly requested
    if (phoneNumber && !state.creds.registered) {
      console.log(`Generating pairing code for ${phoneNumber}...`);
      await delay(4000); // Give socket time to initialize
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        lastPairingCode = code;
        lastPhone = phoneNumber;
        console.log(`Pairing code generated: ${code}`);
      } catch (err) {
        console.error('Pairing code error:', err.message);
        lastPairingCode = 'ERROR';
      }
    }

    // Basic ping command
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (text.trim().toLowerCase() === '.ping') {
        await sock.sendMessage(msg.key.remoteJid, {
          text: `Pong! ${Math.floor(process.uptime())} seconds`
        }).catch(() => {});
      }
    });

  } catch (err) {
    console.error('Critical startup error:', err.message);
    isConnecting = false;
  }

  return true;
}

// ── Pairing endpoint ──────────────────────────────────────────
app.post('/pair', async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/[^0-9]/g, '');

  if (!phone || phone.length < 10) {
    return res.status(400).json({
      error: 'Invalid phone number. Send in international format without + (example: 2348012345678)'
    });
  }

  lastPairingCode = null;
  lastPhone = null;

  await connectToWhatsApp(phone);

  // Wait for code (max 30 seconds)
  let attempts = 0;
  const checkInterval = setInterval(() => {
    attempts++;

    if (lastPairingCode) {
      clearInterval(checkInterval);

      if (lastPairingCode === 'ERROR') {
        return res.status(500).json({ error: 'Failed to generate pairing code' });
      }

      return res.json({
        success: true,
        pairing_code: lastPairingCode,
        phone: lastPhone,
        instruction: 'Open WhatsApp → Settings → Linked Devices → Link with phone number → Enter code'
      });
    }

    if (attempts >= 30) {
      clearInterval(checkInterval);
      res.status(504).json({ error: 'Timeout waiting for pairing code' });
    }
  }, 1000);
});

// Start server FIRST, then try to restore session
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server started on port ${PORT}`);

  // Try to restore previous session automatically
  const hasCreds = await fs.stat('./auth/creds.json').catch(() => false);
  if (hasCreds) {
    console.log('Found previous credentials → connecting...');
    await connectToWhatsApp();
  } else {
    console.log('No previous session found. Use POST /pair to connect.');
  }
});