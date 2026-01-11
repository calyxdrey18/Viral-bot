const express = require("express");
const path = require("path");
const Pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  DisconnectReason,
  delay
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

let sock = null;
let pairingCode = null;
let connecting = false;
let isConnected = false;

let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
};

// Ensure auth directory exists
if (!fs.existsSync("auth")) {
  fs.mkdirSync("auth", { recursive: true });
}

async function startWhatsApp(phone = null) {
  if (connecting) {
    console.log("⚠️ Already connecting, please wait...");
    return;
  }
  
  connecting = true;
  console.log(phone ? `🔗 Starting WhatsApp with phone: ${phone}` : "🔄 Starting WhatsApp connection...");

  try {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      auth: state,
      version,
      logger: Pino({ level: "silent" }),
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      emitOwnEvents: false,
      defaultQueryTimeoutMs: 60000
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("📱 QR Code received");
      }

      if (connection === "open") {
        console.log("✅ WhatsApp LINKED AND ACTIVE");
        isConnected = true;
        connecting = false;
        
        try {
          const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
          await sock.sendMessage(botId, { 
            text: "✅ *VIRAL-BOT IS ONLINE*\n\nCommands are now active. Type *.menu* in any chat to begin.\n\nMade with ❤️ by Viral-Bot Team" 
          });
          console.log("📤 Startup message sent to bot");
        } catch (err) {
          console.log("⚠️ Could not send startup message:", err.message);
        }
      }

      if (connection === "close") {
        isConnected = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`🔌 Connection closed, reason: ${reason}`);
        
        if (reason === DisconnectReason.loggedOut) {
          console.log("🚪 Logged out, clearing auth...");
          // Clear auth directory on logout
          fs.rmSync("auth", { recursive: true, force: true });
          fs.mkdirSync("auth", { recursive: true });
        } else if (reason !== DisconnectReason.connectionClosed) {
          console.log("🔄 Reconnecting socket...");
          connecting = false;
          setTimeout(() => startWhatsApp(), 5000);
        } else {
          connecting = false;
        }
      }
    });

    // MESSAGE HANDLER
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;

      const from = msg.key.remoteJid;
      const isGroup = from.endsWith("@g.us");
      const body = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   msg.message.imageMessage?.caption ||
                   msg.message.videoMessage?.caption ||
                   "";

      const typeMsg = Object.keys(msg.message)[0];

      // Auto-Moderation - only for groups
      if (isGroup) {
        try {
          if (settings.antilink && (body.includes("http://") || body.includes("https://") || body.includes("www."))) {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: `⚠️ *Link removed*\nLinks are not allowed in this group.` });
            return;
          }
          
          if (settings.antisticker && typeMsg === 'stickerMessage') {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: `⚠️ *Sticker removed*\nStickers are not allowed in this group.` });
            return;
          }
          
          if (settings.antiaudio && typeMsg === 'audioMessage') {
            await sock.sendMessage(from, { delete: msg.key });
            await sock.sendMessage(from, { text: `⚠️ *Audio removed*\nAudio messages are not allowed in this group.` });
            return;
          }
        } catch (err) {
          console.log("⚠️ Error in auto-moderation:", err.message);
        }
      }

      if (!body.startsWith(".")) return;
      
      const args = body.slice(1).trim().split(/ +/);
      const cmd = args.shift().toLowerCase();
      console.log(`Command received: .${cmd} from ${from}`);

      try {
        // MENU COMMAND
        if (cmd === "menu") {
          const help = `🌟 *VIRAL-BOT MENU* 🌟\n\n*Admin Commands:*\n• .mute - Mute group\n• .unmute - Unmute group\n• .tagall - Mention all members\n\n*Auto-Moderation:*\n• .antilink [on/off]\n• .antisticker [on/off]\n• .antiaudio [on/off]\n\n*Info:*\n• .ping - Check bot status\n• .owner - Contact owner`;
          await sock.sendMessage(from, { text: help });
        }

        // PING COMMAND
        if (cmd === "ping") {
          await sock.sendMessage(from, { text: `🏓 *PONG!*\nBot is active and responding!\nUptime: ${process.uptime().toFixed(0)}s` });
        }

        // OWNER COMMAND
        if (cmd === "owner") {
          await sock.sendMessage(from, { text: `👑 *Owner Contact:*\nYou can contact the bot owner for support or inquiries.` });
        }

        // TAGALL COMMAND
        if (cmd === "tagall" && isGroup) {
          try {
            const meta = await sock.groupMetadata(from);
            const tags = meta.participants.map(p => p.id);
            const msgText = `📢 *Attention All Members!*\n\n` + tags.map(t => `@${t.split("@")[0]}`).join(" ");
            await sock.sendMessage(from, { text: msgText, mentions: tags });
          } catch (err) {
            await sock.sendMessage(from, { text: "❌ Error: I need to be a participant in this group." });
          }
        }

        // MUTE/UNMUTE COMMANDS
        if ((cmd === "mute" || cmd === "unmute") && isGroup) {
          try {
            const isAnnouncement = cmd === "mute";
            await sock.groupSettingUpdate(from, isAnnouncement ? "announcement" : "not_announcement");
            await sock.sendMessage(from, { text: `🔇 *Group ${cmd === 'mute' ? 'Muted' : 'Unmuted'}*\nOnly admins can send messages now.` });
          } catch (err) {
            await sock.sendMessage(from, { text: "❌ Error: I need Admin rights to perform this action." });
          }
        }

        // AUTO-MODERATION SETTINGS
        if (["antilink", "antisticker", "antiaudio"].includes(cmd)) {
          if (args.length === 0) {
            const status = settings[cmd] ? "ON ✅" : "OFF ❌";
            await sock.sendMessage(from, { text: `📊 *${cmd}* status: ${status}` });
          } else if (args[0] === "on" || args[0] === "off") {
            settings[cmd] = args[0] === "on";
            await sock.sendMessage(from, { text: `✅ *${cmd}* is now ${args[0] === 'on' ? 'ENABLED' : 'DISABLED'}.` });
          } else {
            await sock.sendMessage(from, { text: `❌ Usage: .${cmd} [on/off]` });
          }
        }
      } catch (err) {
        console.log("❌ Error processing command:", err.message);
        await sock.sendMessage(from, { text: "❌ Error processing command. Please try again." });
      }
    });

    // Pairing Code Request
    if (phone && sock && !sock.authState?.creds?.registered) {
      console.log(`📱 Requesting pairing code for: ${phone}`);
      await delay(3000);
      
      try {
        pairingCode = await sock.requestPairingCode(phone);
        console.log(`✅ Pairing code generated: ${pairingCode}`);
      } catch (err) {
        console.log("❌ Error generating pairing code:", err.message);
        pairingCode = "FAILED";
      }
    } else if (phone) {
      console.log("ℹ️ Already registered, no pairing needed");
      pairingCode = "ALREADY_REGISTERED";
    }

  } catch (err) {
    console.log("❌ Error in startWhatsApp:", err.message);
    connecting = false;
    pairingCode = "FAILED";
  }
}

// API endpoint for pairing
app.post("/pair", async (req, res) => {
  try {
    const phone = req.body.phone?.replace(/\D/g, "");
    
    if (!phone || phone.length < 10) {
      return res.json({ code: "FAILED", error: "Invalid phone number" });
    }

    console.log(`📞 Pair request for: ${phone}`);
    pairingCode = null;
    
    // Start WhatsApp connection
    await startWhatsApp(phone);

    // Wait for pairing code with timeout
    let tries = 0;
    const maxTries = 30; // 30 seconds timeout
    
    return new Promise((resolve) => {
      const checkCode = setInterval(() => {
        if (pairingCode) {
          clearInterval(checkCode);
          console.log(`📱 Sending code: ${pairingCode}`);
          res.json({ code: pairingCode });
          resolve();
        } else if (++tries > maxTries) {
          clearInterval(checkCode);
          console.log("⏰ Pairing timeout");
          res.json({ code: "FAILED", error: "Timeout - try again" });
          resolve();
        }
      }, 1000);
    });
    
  } catch (err) {
    console.log("❌ Error in /pair endpoint:", err.message);
    res.json({ code: "FAILED", error: err.message });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    connected: isConnected,
    pairingActive: !!pairingCode,
    uptime: process.uptime()
  });
});

// Bot status endpoint
app.get("/status", (req, res) => {
  res.json({
    botStatus: isConnected ? "ONLINE ✅" : "OFFLINE ❌",
    pairingCode: pairingCode || "None",
    settings,
    uptime: `${Math.floor(process.uptime())} seconds`
  });
});

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
  console.log(`🌐 Web interface: http://localhost:${PORT}`);
  console.log(`📱 Health check: http://localhost:${PORT}/health`);
  console.log(`🤖 Bot status: http://localhost:${PORT}/status`);
  
  // Auto-start WhatsApp connection if already authenticated
  if (fs.existsSync("auth/creds.json")) {
    console.log("🔍 Existing auth found, auto-connecting...");
    setTimeout(() => startWhatsApp(), 3000);
  } else {
    console.log("🔐 No auth found, ready for pairing...");
  }
});

// Handle process termination
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down...');
  process.exit(0);
});
[file content end]