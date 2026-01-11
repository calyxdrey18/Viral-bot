// server.js
// Minimal WhatsApp bot with pairing code + .ping command
// Designed for Render deployment (Web Service)

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

// ── Simple root route so "Cannot GET /" disappears ───────────────────────
app.get('/', (req, res) => {
  res.type('text/html').send(`
    <h2>WhatsApp Pairing Bot</h2>
    <p>Status: <strong>running</strong></p>
    <p>Use POST <code>/pair</code> with JSON body:</p>
    <pre>
{
  "phone": "234xxxxxxxxxx"
}
    </pre>
    <p><a href="/health">Check health</a></p>
    <small>Render • ${new Date().toISOString()}</small>
  `);
});

// Health check – Render likes this
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// ── Bot state ─────────────────────────────────────────────────────────────
let sock = null;
let isConnecting = false;
let currentPairingCode = null;
let currentPairPhone = null;

// ── Core connection logic ─────────────────────────────────────────────────
async function startWhatsAppConnection(phone = null) {
  if (isConnecting) return;
  isConnecting = true;

  console.log(phone
    ? `→ Starting new pairing session for ${phone}`
    : '→ Attempting to restore previous session');

  try {
    // Make sure auth directory exists
    await fs.mkdir('./auth', { recursive: true }).catch(() => {});

    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhatsApp Bot', 'Chrome', '126.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      shouldSyncHistoryMessage: () => false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === 'open') {
        console.log('✓ Successfully connected to WhatsApp');
        isConnecting = false;
        currentPairingCode = null;
        currentPairPhone = null;

        // Optional: send welcome message to self
        try {
          const selfJid = sock.user.id.replace(/:\d+/, '@s.whatsapp.net');
          await sock.sendMessage(selfJid, { text: 'Bot online ✓' });
        } catch {}
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed (code: ${statusCode || 'unknown'})`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('Logged out → clearing credentials');
          await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
        } else if (statusCode !== DisconnectReason.connectionClosed) {
          console.log('Will try to reconnect in 10 seconds...');
          setTimeout(() => {
            isConnecting = false;
            startWhatsAppConnection();
          }, 10000);
        }
        isConnecting = false;
      }
    });

    // ── Only generate pairing code when explicitly requested ──────────────
    if (phone && !state.creds.registered) {
      console.log(`Generating pairing code for ${phone}...`);
      await delay(4500); // give socket time to initialize

      try {
        const code = await sock.requestPairingCode(phone);
        currentPairingCode = code;
        currentPairPhone = phone;
        console.log(`Pairing code created: ${code}`);
      } catch (err) {
        console.error('Pairing code generation failed:', err.message);
        currentPairingCode = 'ERROR';
      }
    }

    // ── Minimal command handler ── only .ping ─────────────────────────────
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
            text: `Pong! ${Math.floor(process.uptime())}s`
          });
        } catch (e) {
          console.error('Could not send pong:', e.message);
        }
      }
    });

  } catch (err) {
    console.error('Critical connection error:', err.message);
    isConnecting = false;
    currentPairingCode = 'ERROR';
  }
}

// ── Pairing endpoint ──────────────────────────────────────────────────────
app.post('/pair', async (req, res) => {
  const phone = String(req.body?.phone || '').replace(/[^0-9]/g, '');

  if (!phone || phone.length < 10) {
    return res.status(400).json({
      error: 'Invalid phone number. Use international format without + (e.g. 2348012345678)'
    });
  }

  currentPairingCode = null;
  currentPairPhone = null;

  await startWhatsAppConnection(phone);

  // Wait for pairing code (max ~30 seconds)
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;

    if (currentPairingCode) {
      clearInterval(interval);

      if (currentPairingCode === 'ERROR') {
        return res.status(500).json({ error: 'Failed to generate pairing code' });
      }

      return res.json({
        success: true,
        pairing_code: currentPairingCode,
        phone: currentPairPhone,
        instruction: 'WhatsApp → Settings → Linked Devices → Link with phone number'
      });
    }

    if (attempts >= 30) {
      clearInterval(interval);
      res.status(504).json({ error: 'Timeout waiting for pairing code' });
    }
  }, 1000);
});

// ── Start everything ──────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server listening on port ${PORT}`);

  // Try to restore previous session if exists
  try {
    const hasCreds = await fs.stat('./auth/creds.json').catch(() => false);
    if (hasCreds) {
      console.log('Found previous session → auto connecting...');
      await startWhatsAppConnection();
    } else {
      console.log('No previous session. Use POST /pair to connect.');
    }
  } catch (err) {
    console.error('Startup check failed:', err.message);
  }
});