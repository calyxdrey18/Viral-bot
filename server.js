const express = require("express");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// Bot state
let botStatus = {
  isActive: false,
  isWhatsAppConnected: false,
  pairingCode: null,
  qrCode: null,
  lastUpdate: new Date().toISOString(),
  uptime: 0,
  connectedPhone: null
};

// WhatsApp variables
let sock = null;
let pairingCode = null;
let connecting = false;

// Create necessary directories
function ensureDirectories() {
  if (!fs.existsSync("auth")) {
    fs.mkdirSync("auth", { recursive: true });
  }
  if (!fs.existsSync("temp")) {
    fs.mkdirSync("temp", { recursive: true });
  }
}

// Install WhatsApp dependencies if missing
async function ensureDependencies() {
  try {
    require("@whiskeysockets/baileys");
    require("pino");
    require("@hapi/boom");
    console.log("✅ WhatsApp dependencies found");
    return true;
  } catch (err) {
    console.log("📦 Installing WhatsApp dependencies...");
    
    return new Promise((resolve, reject) => {
      const npm = spawn('npm', ['install', '@whiskeysockets/baileys', 'pino', '@hapi/boom', '--no-save'], {
        stdio: 'inherit',
        shell: true
      });
      
      npm.on('close', (code) => {
        if (code === 0) {
          console.log("✅ Dependencies installed successfully");
          resolve(true);
        } else {
          console.error("❌ Failed to install dependencies");
          resolve(false);
        }
      });
      
      npm.on('error', (err) => {
        console.error("❌ Error installing dependencies:", err);
        resolve(false);
      });
    });
  }
}

// Start WhatsApp connection
async function startWhatsApp(phone = null) {
  if (connecting) {
    console.log("⚠️ WhatsApp connection already in progress...");
    return;
  }
  
  connecting = true;
  console.log(phone ? `🔗 Starting WhatsApp for phone: ${phone}` : "🔄 Starting WhatsApp connection...");
  
  try {
    // Ensure dependencies are installed
    const depsInstalled = await ensureDependencies();
    if (!depsInstalled) {
      throw new Error("Failed to install WhatsApp dependencies");
    }
    
    // Dynamically import after installation
    const { 
      default: makeWASocket, 
      useMultiFileAuthState, 
      fetchLatestBaileysVersion, 
      Browsers,
      DisconnectReason,
      delay 
    } = require("@whiskeysockets/baileys");
    const Pino = require("pino");
    const { Boom } = require("@hapi/boom");
    
    ensureDirectories();
    
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
        console.log("📱 QR Code received (not displayed in web)");
        botStatus.qrCode = qr;
      }
      
      if (connection === "open") {
        console.log("✅ WhatsApp CONNECTED AND ACTIVE");
        botStatus.isWhatsAppConnected = true;
        connecting = false;
        pairingCode = null;
        
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
        botStatus.isWhatsAppConnected = false;
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        console.log(`🔌 Connection closed, reason: ${reason}`);
        
        if (reason === DisconnectReason.loggedOut) {
          console.log("🚪 Logged out, clearing auth...");
          fs.rmSync("auth", { recursive: true, force: true });
          ensureDirectories();
        } else if (reason !== DisconnectReason.connectionClosed) {
          console.log("🔄 Reconnecting in 5 seconds...");
          connecting = false;
          setTimeout(() => startWhatsApp(), 5000);
        } else {
          connecting = false;
        }
      }
    });
    
    // Message handler
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
      
      // Auto-moderation settings
      const settings = {
        antilink: false,
        antisticker: false,
        antiaudio: false
      };
      
      // Auto-moderation for groups
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
          await sock.sendMessage(from, { text: `👑 *Owner Contact:*\nContact the bot owner for support or inquiries.` });
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
    
    // Request pairing code if phone provided
    if (phone && sock && !sock.authState?.creds?.registered) {
      console.log(`📱 Requesting pairing code for: ${phone}`);
      await delay(3000);
      
      try {
        pairingCode = await sock.requestPairingCode(phone);
        botStatus.pairingCode = pairingCode;
        botStatus.connectedPhone = phone;
        console.log(`✅ Pairing code generated: ${pairingCode}`);
      } catch (err) {
        console.log("❌ Error generating pairing code:", err.message);
        pairingCode = "FAILED";
        botStatus.pairingCode = "FAILED";
      }
    } else if (phone && sock.authState?.creds?.registered) {
      console.log("ℹ️ Already registered with WhatsApp");
      pairingCode = "ALREADY_REGISTERED";
      botStatus.pairingCode = "ALREADY_REGISTERED";
    }
    
  } catch (err) {
    console.log("❌ Error in startWhatsApp:", err.message);
    connecting = false;
    pairingCode = "FAILED";
    botStatus.pairingCode = "FAILED";
  }
}

// Serve the frontend
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check endpoint (required by Render)
app.get("/health", (req, res) => {
  botStatus.uptime = process.uptime();
  botStatus.lastUpdate = new Date().toISOString();
  
  res.status(200).json({ 
    status: "healthy",
    whatsapp: botStatus.isWhatsAppConnected ? "connected" : "disconnected",
    uptime: Math.floor(botStatus.uptime),
    timestamp: botStatus.lastUpdate,
    pairing_code: botStatus.pairingCode ? "available" : "none"
  });
});

// Bot status endpoint
app.get("/status", (req, res) => {
  botStatus.uptime = process.uptime();
  
  res.json({
    bot: {
      active: botStatus.isActive,
      whatsapp_connected: botStatus.isWhatsAppConnected,
      pairing_code: botStatus.pairingCode,
      connected_phone: botStatus.connectedPhone,
      uptime: `${Math.floor(botStatus.uptime)} seconds`
    },
    server: {
      platform: process.platform,
      node_version: process.version,
      memory: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`,
      uptime: `${Math.floor(process.uptime())}s`
    },
    endpoints: {
      "GET /": "Frontend interface",
      "POST /pair": "Get WhatsApp pairing code",
      "GET /health": "Health check",
      "GET /status": "This status page"
    }
  });
});

// Pairing endpoint
app.post("/pair", async (req, res) => {
  try {
    const phone = req.body.phone?.replace(/\D/g, "");
    
    if (!phone || phone.length < 10) {
      return res.status(400).json({ 
        code: "FAILED", 
        error: "Invalid phone number. Format: 2348100000000 (with country code, no +)" 
      });
    }

    console.log(`📞 Pairing request for: ${phone}`);
    
    // Reset pairing code
    pairingCode = null;
    botStatus.pairingCode = null;
    botStatus.connectedPhone = phone;
    
    // Start WhatsApp connection
    await startWhatsApp(phone);
    
    // Wait for pairing code with timeout
    let tries = 0;
    const maxTries = 30; // 30 seconds timeout
    
    const checkCode = setInterval(() => {
      if (pairingCode) {
        clearInterval(checkCode);
        console.log(`📱 Sending pairing code: ${pairingCode}`);
        
        if (pairingCode === "ALREADY_REGISTERED") {
          res.json({ 
            code: "ALREADY_REGISTERED",
            message: "This number is already registered with the bot.",
            note: "If you want to re-link, please logout from WhatsApp Web first."
          });
        } else if (pairingCode !== "FAILED") {
          res.json({ 
            code: pairingCode,
            phone: phone,
            timestamp: new Date().toISOString()
          });
        } else {
          res.json({ 
            code: "FAILED", 
            error: "Failed to generate pairing code" 
          });
        }
      } else if (++tries > maxTries) {
        clearInterval(checkCode);
        console.log("⏰ Pairing timeout");
        res.json({ 
          code: "FAILED", 
          error: "Timeout - Please try again in a moment" 
        });
      }
    }, 1000);
    
  } catch (err) {
    console.log("❌ Error in /pair endpoint:", err.message);
    res.status(500).json({ 
      code: "FAILED", 
      error: "Internal server error" 
    });
  }
});

// Reset endpoint (clear auth data)
app.post("/reset", (req, res) => {
  try {
    if (fs.existsSync("auth")) {
      fs.rmSync("auth", { recursive: true, force: true });
      ensureDirectories();
      console.log("🧹 Auth data cleared");
    }
    
    botStatus.pairingCode = null;
    botStatus.qrCode = null;
    botStatus.isWhatsAppConnected = false;
    botStatus.connectedPhone = null;
    sock = null;
    pairingCode = null;
    connecting = false;
    
    res.json({ 
      success: true,
      message: "Bot reset successfully. You can now pair a new number."
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: "Endpoint not found",
    available_endpoints: [
      { method: "GET", path: "/", description: "Frontend interface" },
      { method: "POST", path: "/pair", description: "Get WhatsApp pairing code" },
      { method: "GET", path: "/health", description: "Health check" },
      { method: "GET", path: "/status", description: "Bot status" },
      { method: "POST", path: "/reset", description: "Reset bot (clear auth)" }
    ]
  });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({ 
    error: "Internal server error",
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Initialize and start server
async function initializeServer() {
  try {
    ensureDirectories();
    botStatus.isActive = true;
    botStatus.startTime = new Date().toISOString();
    
    console.log(`
╔══════════════════════════════════════════╗
║        VIRAL-BOT WHATSAPP SERVER         ║
╠══════════════════════════════════════════╣
║                                          ║
║  🌐 Port: ${PORT}                              ║
║  🚀 Status: INITIALIZING...              ║
║  📍 Health: http://localhost:${PORT}/health     ║
║  📊 Status: http://localhost:${PORT}/status     ║
║                                          ║
╚══════════════════════════════════════════╝

📦 Checking dependencies...
    `);
    
    // Check if we have existing auth
    if (fs.existsSync("auth/creds.json")) {
      console.log("🔍 Existing auth found, auto-connecting to WhatsApp...");
      setTimeout(() => startWhatsApp(), 3000);
    } else {
      console.log("🔐 No auth found, ready for pairing...");
      console.log("\n👉 Open http://localhost:" + PORT + " to pair your WhatsApp");
    }
    
  } catch (err) {
    console.error("❌ Failed to initialize server:", err);
  }
}

// Start server
app.listen(PORT, () => {
  initializeServer();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  botStatus.isActive = false;
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received, shutting down...');
  botStatus.isActive = false;
  process.exit(0);
});

// Update status periodically
setInterval(() => {
  botStatus.uptime = process.uptime();
  botStatus.lastUpdate = new Date().toISOString();
}, 30000);
[file content end]