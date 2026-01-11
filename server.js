const express = require("express");
const path = require("path");
const fs = require("fs").promises;
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  delay
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const { Boom } = require("@hapi/boom");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // ← put your frontend files in /public folder

// ── Bot State ───────────────────────────────────────────────
const botStatus = {
  isActive: true,
  isWhatsAppConnected: false,
  pairingCode: null,
  connectedPhone: null,
  lastUpdate: new Date().toISOString(),
  uptime: 0
};

let sock = null;
let connecting = false;

// In-memory group settings (reset on restart - normal for Render free tier)
const groupSettings = new Map(); // groupJid → { antilink: bool, antisticker: bool, antiaudio: bool }

// Ensure auth folder exists
async function ensureDirectories() {
  try {
    await fs.mkdir("auth", { recursive: true });
  } catch (err) {
    console.error("Failed to create auth directory:", err);
  }
}

// ── WhatsApp Connection Logic ───────────────────────────────
async function startWhatsApp(requestedPhone = null) {
  if (connecting) return;
  connecting = true;

  console.log(requestedPhone
    ? `Starting WhatsApp connection for ${requestedPhone}`
    : "Starting WhatsApp connection...");

  try {
    await ensureDirectories();

    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      emitOwnEvents: false,
      defaultQueryTimeoutMs: 60000,
      shouldSyncHistoryMessage: () => false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[QR] QR received (sent to frontend only)");
        botStatus.qrCode = qr; // optional - if you want to show QR too
      }

      if (connection === "open") {
        console.log("✅ WHATSAPP CONNECTED");
        botStatus.isWhatsAppConnected = true;
        botStatus.pairingCode = null;
        connecting = false;

        try {
          const botJid = sock.user.id.replace(/:\d+/, "@s.whatsapp.net");
          await sock.sendMessage(botJid, {
            text: "✅ *VIRAL-BOT IS ONLINE*\n\nType *.menu* to see commands!\nMade with ❤️"
          });
        } catch {}
      }

      if (connection === "close") {
        botStatus.isWhatsAppConnected = false;
        const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;

        console.log(`Connection closed - reason: ${statusCode}`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log("Logged out → deleting auth session");
          await fs.rm("auth", { recursive: true, force: true }).catch(() => {});
          await ensureDirectories();
        } else if (statusCode !== DisconnectReason.connectionClosed) {
          console.log("Reconnecting in 10 seconds...");
          setTimeout(() => {
            connecting = false;
            startWhatsApp();
          }, 10000);
        } else {
          connecting = false;
        }
      }
    });

    // ── Message Handler ─────────────────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;

      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith("@g.us");

      let body = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        msg.message.videoMessage?.caption ||
        ""
      ).trim();

      const msgType = Object.keys(msg.message)[0];

      // Get / create group settings
      if (!groupSettings.has(from)) {
        groupSettings.set(from, { antilink: false, antisticker: false, antiaudio: false });
      }
      const settings = groupSettings.get(from);

      // Auto moderation (only groups)
      if (isGroup) {
        try {
          if (settings.antilink && /https?:\/\/|www\./i.test(body)) {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: "⚠️ Link removed - not allowed here" });
            return;
          }

          if (settings.antisticker && msgType === "stickerMessage") {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: "⚠️ Sticker removed - not allowed" });
            return;
          }

          if (settings.antiaudio && msgType === "audioMessage") {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: "⚠️ Voice note removed - not allowed" });
            return;
          }
        } catch (e) {
          console.error("Auto-mod error:", e.message);
        }
      }

      if (!body.startsWith(".")) return;

      const args = body.slice(1).trim().split(/ +/);
      const cmd = args.shift()?.toLowerCase();

      console.log(`Command: .${cmd} from ${from}`);

      try {
        switch (cmd) {
          case "menu":
            await sock.sendMessage(from, {
              text: `🌟 *VIRAL-BOT MENU*\n\n` +
                    `*Group Admin:*\n• .mute / .unmute\n• .tagall\n\n` +
                    `*Moderation:*\n• .antilink [on/off]\n• .antisticker [on/off]\n• .antiaudio [on/off]\n\n` +
                    `*Others:*\n• .ping\n• .owner`
            });
            break;

          case "ping":
            await sock.sendMessage(from, {
              text: `🏓 PONG!\nUptime: ${Math.floor(process.uptime())}s`
            });
            break;

          case "owner":
            await sock.sendMessage(from, { text: "👑 Contact owner: (put your contact here)" });
            break;

          case "tagall":
            if (!isGroup) return;
            try {
              const meta = await sock.groupMetadata(from);
              const mentions = meta.participants.map(p => p.id);
              const text = `📢 *Attention Everyone!*\n\n${mentions.map(m => `@${m.split("@")[0]}`).join(" ")}`;
              await sock.sendMessage(from, { text, mentions });
            } catch (e) {
              await sock.sendMessage(from, { text: "❌ I need to be admin in this group" });
            }
            break;

          case "mute":
          case "unmute":
            if (!isGroup) return;
            try {
              await sock.groupSettingUpdate(from, cmd === "mute" ? "announcement" : "not_announcement");
              await sock.sendMessage(from, {
                text: `🔇 Group ${cmd === "mute" ? "MUTED" : "UNMUTED"}`
              });
            } catch {
              await sock.sendMessage(from, { text: "❌ Bot needs admin rights!" });
            }
            break;

          case "antilink":
          case "antisticker":
          case "antiaudio":
            if (args.length === 0) {
              const status = settings[cmd] ? "ON ✅" : "OFF ❌";
              await sock.sendMessage(from, { text: `${cmd} is currently ${status}` });
            } else if (["on", "off"].includes(args[0]?.toLowerCase())) {
              settings[cmd] = args[0].toLowerCase() === "on";
              await sock.sendMessage(from, {
                text: `${cmd} turned ${settings[cmd] ? "ON" : "OFF"}`
              });
            } else {
              await sock.sendMessage(from, { text: `Usage: .${cmd} [on/off]` });
            }
            break;

          default:
            // unknown command → optional: reply or ignore
        }
      } catch (err) {
        console.error("Command error:", err.message);
        await sock.sendMessage(from, { text: "❌ Error processing command" }).catch(() => {});
      }
    });

    // Pairing code request (only if not registered yet)
    if (requestedPhone && !state.creds.registered) {
      console.log(`Requesting pairing code for ${requestedPhone}...`);
      await delay(4000);
      try {
        const code = await sock.requestPairingCode(requestedPhone);
        botStatus.pairingCode = code;
        botStatus.connectedPhone = requestedPhone;
        console.log(`Pairing code: ${code}`);
      } catch (e) {
        console.error("Pairing code failed:", e.message);
        botStatus.pairingCode = "FAILED";
      }
    }

  } catch (err) {
    console.error("Critical WhatsApp start error:", err);
    connecting = false;
    botStatus.pairingCode = "FAILED";
  }
}

// ── Routes ──────────────────────────────────────────────────

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "healthy",
    whatsapp: botStatus.isWhatsAppConnected ? "connected" : "disconnected",
    uptime: Math.floor(process.uptime())
  });
});

app.get("/status", (req, res) => {
  res.json({
    bot: {
      whatsapp_connected: botStatus.isWhatsAppConnected,
      pairing_code: botStatus.pairingCode,
      connected_phone: botStatus.connectedPhone,
      uptime_seconds: Math.floor(process.uptime())
    }
  });
});

app.post("/pair", async (req, res) => {
  const phone = String(req.body.phone || "").replace(/\D/g, "");

  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: "Invalid phone number (use country code, no +)" });
  }

  botStatus.pairingCode = null;
  botStatus.connectedPhone = phone;

  await startWhatsApp(phone);

  // Wait for code (max ~25 seconds)
  let attempts = 0;
  const interval = setInterval(() => {
    attempts++;

    if (botStatus.pairingCode) {
      clearInterval(interval);

      if (botStatus.pairingCode === "FAILED") {
        return res.status(500).json({ error: "Failed to generate pairing code" });
      }

      return res.json({
        code: botStatus.pairingCode,
        phone,
        message: "Use this code in WhatsApp → Link with phone number"
      });
    }

    if (attempts > 25) {
      clearInterval(interval);
      res.status(504).json({ error: "Timeout waiting for pairing code" });
    }
  }, 1000);
});

app.post("/reset", async (req, res) => {
  try {
    if (await fs.stat("auth").catch(() => false)) {
      await fs.rm("auth", { recursive: true, force: true });
    }
    await ensureDirectories();

    botStatus.pairingCode = null;
    botStatus.isWhatsAppConnected = false;
    botStatus.connectedPhone = null;
    sock?.end();
    sock = null;
    connecting = false;

    res.json({ success: true, message: "Session reset. Ready to pair again." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ── Start Server ────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`═══════════════════════════════════════`);
  console.log(`     VIRAL-BOT SERVER @ port ${PORT}    `);
  console.log(`═══════════════════════════════════════`);

  await ensureDirectories();

  // Auto connect if we have previous session
  if (await fs.stat("auth/creds.json").catch(() => false)) {
    console.log("Found previous session → auto connecting...");
    setTimeout(startWhatsApp, 3000);
  } else {
    console.log("No session found → waiting for /pair request");
  }
});