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

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

let sock;
let pairingCode = null;
let connecting = false;

let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
};

async function startWhatsApp(phone = null) {
  if (connecting && !phone) return;
  connecting = true;

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: Pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"),
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ WhatsApp LINKED AND ACTIVE");
      pairingCode = null;
      connecting = false;
      
      const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      await sock.sendMessage(botId, { 
        image: { url: "https://i.ibb.co/V9X9X9/bot-connected.jpg" },
        caption: "✅ *VIRAL-BOT IS ONLINE*\n\nCommands are now active. Type *.menu* in any chat to begin." 
      });
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      connecting = false;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconnecting socket...");
        startWhatsApp();
      }
    }
  });

  // MESSAGE HANDLER
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
    const type = Object.keys(msg.message)[0];

    // Auto-Moderation
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

    if (!body.startsWith(".")) return;
    const args = body.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    if (cmd === "menu") {
      const help = `🌟 *VIRAL-BOT MENU* 🌟\n\n• .mute / .unmute\n• .tagall\n• .antilink [on/off]\n• .antisticker [on/off]\n• .antiaudio [on/off]`;
      await sock.sendMessage(from, { 
        image: { url: "https://i.ibb.co/K2Zz8Y7/menu-banner.jpg" }, 
        caption: help 
      });
    }

    if (cmd === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from);
      const tags = meta.participants.map(p => p.id);
      const msgText = `📢 *Attention:*\n\n` + tags.map(t => `@${t.split("@")[0]}`).join(" ");
      await sock.sendMessage(from, { text: msgText, mentions: tags });
    }

    if (cmd === "mute" && isGroup) {
      try {
        await sock.groupSettingUpdate(from, "announcement");
        await sock.sendMessage(from, { text: "🔇 *Group Muted*" });
      } catch {
        await sock.sendMessage(from, { text: "❌ Error: I need Admin rights." });
      }
    }

    if (cmd === "unmute" && isGroup) {
      try {
        await sock.groupSettingUpdate(from, "not_announcement");
        await sock.sendMessage(from, { text: "🔊 *Group Unmuted*" });
      } catch {
        await sock.sendMessage(from, { text: "❌ Error: I need Admin rights." });
      }
    }

    if (["antilink", "antisticker", "antiaudio"].includes(cmd)) {
      settings[cmd] = args[0] === "on";
      await sock.sendMessage(from, { text: `✅ *${cmd}* is now ${args[0]}.` });
    }
  });

  // Pairing Code Request
  if (phone && !sock.authState.creds.registered) {
    await delay(6000);
    try {
      pairingCode = await sock.requestPairingCode(phone);
    } catch (err) {
      pairingCode = "FAILED";
    }
  }
}

app.post("/pair", async (req, res) => {
  const phone = req.body.phone?.replace(/\D/g, "");
  if (!phone) return res.json({ code: "FAILED" });
  
  pairingCode = null;
  await startWhatsApp(phone);

  let tries = 0;
  const timer = setInterval(() => {
    if (pairingCode) {
      clearInterval(timer);
      res.json({ code: pairingCode });
    }
    if (++tries > 20) {
      clearInterval(timer);
      res.json({ code: "FAILED" });
    }
  }, 1000);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(3000, () => console.log("Server listening on port 3000"));
