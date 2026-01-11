// server.js

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
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

// Global bot state
let sock = null;
let isConnecting = false;
let currentPairingCode = null;
let currentPairPhone = null;

// Main WhatsApp connection logic
async function connectToWhatsApp(phoneNumber = null) {
  if (isConnecting) return;
  isConnecting = true;
  currentPairingCode = null;
  currentPairPhone = null;

  console.log(
    phoneNumber
      ? `Starting pairing flow for: ${phoneNumber}`
      : 'Trying to restore previous session...'
  );

  try {
    await fs.mkdir('./auth', { recursive: true }).catch(() => {});
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['WhatsApp Pair Bot', 'Chrome', '131.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      shouldSyncHistoryMessage: () => false,
      defaultQueryTimeoutMs: 90000,
      connectTimeoutMs: 60000
    });

    sock.ev.on('creds.update', saveCreds);

    let socketReady = false;

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Ready to request pairing code
      if (qr || connection === 'connecting' || connection === 'open') {
        socketReady = true;
      }

      if (connection === 'open') {
        console.log('SUCCESS: WhatsApp connection established');
        isConnecting = false;
        currentPairingCode = null;
        currentPairPhone = null;

        try {
          const selfJid = sock.user?.id?.replace(/:d+/, '@s.whatsapp.net');
          if (selfJid) {
            await sock.sendMessage(selfJid, {
              text: 'Bot is now online ✓
Send .menu to see commands.'
            });
          }
        } catch (e) {
          console.error('Failed to send self-online message:', e.message);
        }
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
        } else {
          isConnecting = false;
        }
      }

      // Generate pairing code once socket is ready and not yet registered
      if (
        phoneNumber &&
        !state.creds.registered &&
        socketReady &&
        !currentPairingCode
      ) {
        console.log('Socket ready → requesting pairing code...');
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

    // Commands: .ping, .alive, .menu
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const msg = messages[0];
      if (!msg?.message || msg.key.fromMe) return;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';
      const body = text.trim();
      const lower = body.toLowerCase();
      const from = msg.key.remoteJid;

      const uptimeSec = Math.floor(process.uptime());
      const uptimeMin = Math.floor(uptimeSec / 60);

      if (lower === '.ping') {
        try {
          await sock.sendMessage(from, {
            text: `Pong!
Uptime: ${uptimeSec} seconds (${uptimeMin} minutes)`
          });
        } catch (err) {
          console.error('Failed to send ping reply:', err.message);
        }
      } else if (lower === '.alive') {
        try {
          await sock.sendMessage(from, {
            text:
              '*Bot Status: Alive ✅*

' +
              `Runtime: ${uptimeMin} minutes
` +
              `User: @${sock.user?.id?.split('@')[0] || 'bot'}

` +
              'Type .menu to see commands.'
          });
        } catch (err) {
          console.error('Failed to send alive reply:', err.message);
        }
      } else if (lower === '.menu') {
        const menuText =
          '*WhatsApp Pair Bot Menu*

' +
          '• .ping  → Check bot uptime
' +
          '• .alive → Show bot status
' +
          '• .menu  → Show this menu

' +
          'Pair your account from the web dashboard to use commands.';

        try {
          await sock.sendMessage(from, { text: menuText });
        } catch (err) {
          console.error('Failed to send menu reply:', err.message);
        }
      }
    });
  } catch (err) {
    console.error('Critical startup error:', err.message);
    isConnecting = false;
    currentPairingCode = 'ERROR';
  }
}

// Pairing API used by frontend
app.post('/pair', async (req, res) => {
  let phone = String(req.body?.phone || '').replace(/[^0-9]/g, '');

  if (!phone || phone.length < 10) {
    return res.status(400).json({
      success: false,
      error:
        'Invalid phone number. Use full international format like 2348012345678'
    });
  }

  // Optional Nigeria-style fix: 0xxxxxxxxxx → 234xxxxxxxxxx
  if (phone.startsWith('0')) {
    phone = '234' + phone.slice(1);
  }

  currentPairingCode = null;
  currentPairPhone = null;

  await connectToWhatsApp(phone);

  let attempts = 0;
  const maxAttempts = 40; // 40 seconds

  const interval = setInterval(() => {
    attempts++;

    if (currentPairingCode) {
      clearInterval(interval);

      if (
        currentPairingCode === 'ERROR' ||
        currentPairingCode === 'INVALID'
      ) {
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

    if (attempts >= maxAttempts) {
      clearInterval(interval);
      return res.status(504).json({
        success: false,
        error: 'Timeout waiting for pairing code'
      });
    }
  }, 1000);
});

// Start HTTP server
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Frontend available at: http://localhost:' + PORT);

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