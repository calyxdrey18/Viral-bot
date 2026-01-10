const express = require("express");
const path = require("path");
const Pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json());

let sock = null;
let pairCode = null;

// Bot Settings
let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
};

async function startBot(phone = null) {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  // If a socket already exists, terminate it cleanly first
  if (sock) {
    try { sock.logout(); } catch (e) {}
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome") // REQUIRED: Prevents "device not recognized" errors
  });

  sock.ev.on("creds.update", saveCreds);

  // --- CONNECTION HANDLER ---
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED");
      const user = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      
      // Success Message with Image
      await sock.sendMessage(user, { 
        image: { url: "https://i.ibb.co/V9X9X9/bot-connected.jpg" },
        caption: "✅ *VIRAL-BOT LINKED SUCCESSFULLY*\n\nYour bot is now active. Type *.menu* to see available commands." 
      });
      pairCode = null; // Reset for next session
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      console.log(`❌ Connection Closed: ${reason}`);
      if (reason !== DisconnectReason.loggedOut) {
        startBot(); // Re-establish if not a manual logout
      }
    }
  });

  // --- PAIRING LOGIC (Wait for socket to be ready) ---
  if (phone && !state.creds.registered) {
    await delay(5000); // 5 second delay is vital for pairing stability
    try {
      const cleanPhone = phone.replace(/[^0-9]/g, "");
      pairCode = await sock.requestPairingCode(cleanPhone);
      console.log(`🔑 PAIRING CODE: ${pairCode}`);
    } catch (err) {
      console.error("Pairing Error:", err);
      pairCode = "FAILED";
    }
  }

  // --- MESSAGE HANDLER (All Commands) ---
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
    const type = Object.keys(msg.message)[0];

    // 1. Group Auto-Moderation
    if (isGroup) {
      if (settings.antilink && (body.includes("http://") || body.includes("https://"))) {
        await sock.sendMessage(from, { delete: msg.key });
      }
      if (settings.antisticker && type === 'stickerMessage') {
        await sock.sendMessage(from, { delete: msg.key });
      }
      if (settings.antiaudio && type === 'audioMessage') {
        await sock.sendMessage(from, { delete: msg.key });
      }
    }

    // 2. Command Processing
    if (!body.startsWith(".")) return;
    const args = body.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === "menu") {
      const status = (k) => settings[k] ? "✅" : "❌";
      const help = `🌟 *VIRAL-BOT MENU* 🌟\n\n` +
                   `• .mute / .unmute\n` +
                   `• .tagall\n\n` +
                   `*Security:* \n` +
                   `• .antilink on/off [${status('antilink')}]\n` +
                   `• .antisticker on/off [${status('antisticker')}]\n` +
                   `• .antiaudio on/off [${status('antiaudio')}]`;
      
      await sock.sendMessage(from, { 
        image: { url: "https://i.ibb.co/K2Zz8Y7/menu-banner.jpg" },
        caption: help 
      });
    }

    if (command === "mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement");
      await sock.sendMessage(from, { text: "🔇 *Group Muted.* Only admins can talk." });
    }

    if (command === "unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement");
      await sock.sendMessage(from, { text: "🔊 *Group Unmuted.* Everyone can talk." });
    }

    if (command === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from);
      const members = meta.participants.map(p => p.id);
      const tags = members.map(u => `@${u.split("@")[0]}`).join(" ");
      await sock.sendMessage(from, { text: `📢 *Attention:*\n\n${tags}`, mentions: members });
    }

    if (["antilink", "antisticker", "antiaudio"].includes(command)) {
      settings[command] = args[0] === "on";
      await sock.sendMessage(from, { text: `✅ *${command}* is now ${args[0]}.` });
    }
  });
}

// API Route for Frontend
app.post("/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "Phone required" });
  
  pairCode = null;
  await startBot(phone);
  
  let tries = 0;
  const interval = setInterval(() => {
    if (pairCode) {
      clearInterval(interval);
      res.json({ code: pairCode });
    } else if (tries > 25) { 
      clearInterval(interval);
      res.json({ code: "FAILED" });
    }
    tries++;
  }, 1000);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(3000, () => console.log("🌐 Server live on 3000"));
