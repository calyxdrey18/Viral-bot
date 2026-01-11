// server.js
import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    Browsers,
    delay
} from '@whiskeysockets/baileys';
import pino from 'pino';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public'))); // serve frontend from /public folder

// ── Global state ───────────────────────────────────────────────
const botState = {
    isConnected: false,
    pairingCode: null,
    connectedNumber: null,
    lastActivity: new Date().toISOString()
};

let sock = null;
let isConnecting = false;

// In-memory group settings (reset on restart - typical for Render free tier)
const groupSettings = new Map(); // jid → { antilink: boolean, antisticker: boolean, antiaudio: boolean }

// ── Utils ──────────────────────────────────────────────────────
async function ensureAuthDir() {
    try {
        await fs.mkdir('./auth', { recursive: true });
    } catch (e) {
        console.error('Cannot create auth directory:', e.message);
    }
}

// ── WhatsApp connection ────────────────────────────────────────
async function connectToWhatsApp(targetPhone = null) {
    if (isConnecting) return;
    isConnecting = true;

    console.log(targetPhone 
        ? `Connecting with pairing code request for ${targetPhone}`
        : 'Attempting to restore previous session...');

    try {
        await ensureAuthDir();

        const { state, saveCreds } = await useMultiFileAuthState('./auth');
        const { version } = await fetchLatestBaileysVersion();

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            browser: Browsers.ubuntu('Chrome'),
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: true,
            shouldSyncHistoryMessage: () => false,
            defaultQueryTimeoutMs: 60000
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('[QR] QR code generated (only available via pairing code method)');
            }

            if (connection === 'open') {
                console.log('✓ WhatsApp connection established');
                botState.isConnected = true;
                botState.pairingCode = null;
                isConnecting = false;

                // Optional: send welcome message to self
                try {
                    const self = sock.user.id.replace(/:\d+/, '@s.whatsapp.net');
                    await sock.sendMessage(self, { text: 'Bot is now online ✓' });
                } catch {}
            }

            if (connection === 'close') {
                botState.isConnected = false;
                const statusCode = (lastDisconnect?.error)?.output?.statusCode;

                console.log(`Connection lost - reason: ${statusCode || 'unknown'}`);

                if (statusCode === DisconnectReason.loggedOut) {
                    console.log('Logged out → clearing session');
                    await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
                    await ensureAuthDir();
                } else if (statusCode !== DisconnectReason.connectionClosed) {
                    console.log('Will try to reconnect in 12 seconds...');
                    setTimeout(() => {
                        isConnecting = false;
                        connectToWhatsApp();
                    }, 12000);
                } else {
                    isConnecting = false;
                }
            }
        });

        // ── Pairing code (only on first connect / when requested) ───────
        if (targetPhone && !state.creds.registered) {
            console.log(`Generating pairing code for: ${targetPhone}`);
            await delay(3000);
            try {
                const code = await sock.requestPairingCode(targetPhone);
                botState.pairingCode = code;
                botState.connectedNumber = targetPhone;
                console.log(`Pairing code: ${code}`);
            } catch (e) {
                console.error('Pairing code generation failed:', e.message);
                botState.pairingCode = 'ERROR';
            }
        }

        // ── Message handler ────────────────────────────────────────────
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            const msg = messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');

            let text = (
                msg.message.conversation ||
                msg.message.extendedTextMessage?.text ||
                msg.message.imageMessage?.caption ||
                msg.message.videoMessage?.caption ||
                ''
            ).trim();

            const msgType = Object.keys(msg.message)[0] || '';

            // Initialize group settings if needed
            if (isGroup && !groupSettings.has(from)) {
                groupSettings.set(from, { antilink: false, antisticker: false, antiaudio: false });
            }
            const settings = groupSettings.get(from) || {};

            // Simple auto-moderation
            if (isGroup) {
                if (settings.antilink && /https?:\/\/|www\./i.test(text)) {
                    await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
                    await sock.sendMessage(from, { text: 'Link deleted • not allowed' });
                    return;
                }
                if (settings.antisticker && msgType === 'stickerMessage') {
                    await sock.sendMessage(from, { delete: msg.key }).catch(() => {});
                    await sock.sendMessage(from, { text: 'Sticker deleted • not allowed' });
                    return;
                }
            }

            if (!text.startsWith('.')) return;

            const args = text.slice(1).trim().split(/\s+/);
            const cmd = args.shift()?.toLowerCase();

            try {
                switch (cmd) {
                    case 'menu':
                        await sock.sendMessage(from, {
                            text: `✨ *BOT MENU* ✨\n\n` +
                                  `• .menu\n` +
                                  `• .ping\n` +
                                  `• .antilink [on/off]\n` +
                                  `• .antisticker [on/off]\n\n` +
                                  `(group only commands)\n` +
                                  `• .mute  • .unmute\n` +
                                  `• .tagall`
                        });
                        break;

                    case 'ping':
                        await sock.sendMessage(from, {
                            text: `Pong! ${Math.floor(process.uptime())}s`
                        });
                        break;

                    case 'tagall':
                        if (!isGroup) return;
                        try {
                            const meta = await sock.groupMetadata(from);
                            const mentions = meta.participants.map(p => p.id);
                            await sock.sendMessage(from, {
                                text: `Attention everyone!\n\n${mentions.map(m => `@${m.split('@')[0]}`).join(' ')}`,
                                mentions
                            });
                        } catch {
                            await sock.sendMessage(from, { text: 'Need admin rights' });
                        }
                        break;

                    case 'mute':
                    case 'unmute':
                        if (!isGroup) return;
                        try {
                            await sock.groupSettingUpdate(from, cmd === 'mute' ? 'announcement' : 'not_announcement');
                            await sock.sendMessage(from, { text: `Group ${cmd === 'mute' ? 'muted' : 'unmuted'}` });
                        } catch {
                            await sock.sendMessage(from, { text: 'Need admin permission' });
                        }
                        break;

                    case 'antilink':
                    case 'antisticker':
                        if (!isGroup) return;
                        if (!args.length) {
                            const status = settings[cmd] ? 'ON' : 'OFF';
                            await sock.sendMessage(from, { text: `${cmd} is ${status}` });
                        } else if (['on','off'].includes(args[0].toLowerCase())) {
                            settings[cmd] = args[0].toLowerCase() === 'on';
                            await sock.sendMessage(from, { text: `${cmd} turned ${settings[cmd] ? 'ON' : 'OFF'}` });
                        }
                        break;

                    default:
                        // silent ignore or you can add help message
                }
            } catch (err) {
                console.error('Command error:', err.message);
            }
        });

    } catch (err) {
        console.error('Critical connection error:', err);
        isConnecting = false;
    }
}

// ── Routes ─────────────────────────────────────────────────────

app.get('/health', (_, res) => {
    res.status(200).json({
        status: 'alive',
        whatsapp: botState.isConnected ? 'connected' : 'disconnected',
        uptime: Math.floor(process.uptime())
    });
});

app.get('/status', (_, res) => {
    res.json({
        connected: botState.isConnected,
        pairingCode: botState.pairingCode,
        number: botState.connectedNumber,
        uptimeSeconds: Math.floor(process.uptime())
    });
});

app.post('/pair', async (req, res) => {
    const phone = String(req.body.phone || '').replace(/\D/g, '');

    if (!phone || phone.length < 10) {
        return res.status(400).json({ error: 'Invalid phone number (use country code, no +)' });
    }

    botState.pairingCode = null;
    botState.connectedNumber = phone;

    await connectToWhatsApp(phone);

    // Wait for pairing code (up to ~25s)
    let tries = 0;
    const check = setInterval(() => {
        tries++;
        if (botState.pairingCode) {
            clearInterval(check);

            if (botState.pairingCode === 'ERROR') {
                return res.status(500).json({ error: 'Failed to generate pairing code' });
            }

            return res.json({
                pairingCode: botState.pairingCode,
                phone,
                message: 'Enter this code in WhatsApp → Link with phone number'
            });
        }
        if (tries >= 25) {
            clearInterval(check);
            res.status(504).json({ error: 'Timeout waiting for pairing code' });
        }
    }, 1000);
});

app.post('/reset', async (_, res) => {
    try {
        await fs.rm('./auth', { recursive: true, force: true }).catch(() => {});
        await ensureAuthDir();

        botState.pairingCode = null;
        botState.isConnected = false;
        botState.connectedNumber = null;
        sock?.end?.();
        sock = null;
        isConnecting = false;

        res.json({ success: true, message: 'Session cleared. Ready for new pairing.' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Catch-all for frontend
app.get('*', (_, res) => {
    res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
});

// ── Start everything ───────────────────────────────────────────

(async () => {
    // Start HTTP server first
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server listening on port ${PORT}`);
    });

    // Then try to restore previous session
    try {
        const hasCreds = await fs.stat('./auth/creds.json').catch(() => false);
        if (hasCreds) {
            console.log('Found previous session → connecting...');
            await connectToWhatsApp();
        } else {
            console.log('No previous session → waiting for /pair request');
        }
    } catch (e) {
        console.error('Startup error:', e.message);
    }
})();