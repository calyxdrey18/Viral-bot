const express = require("express");
const path = require("path");
const Pino = require("pino");
const fs = require("fs");
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
app.use(express.static(__dirname));

let sock;
let pairingCode = null;
let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
};

// --- Bot Assets ---
const CONN_IMG = "https://i.ibb.co/V9X9X9/bot-connected.jpg";
const MENU_IMG = "https://i.ibb.co/K2Zz8Y7/menu-banner.jpg";

async function startWhatsApp(phone = null) {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: Pino({ level: "silent" }),
    browser: Browsers.ubuntu("Chrome"), // Required for stable pairing
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ WhatsApp LINKED SUCCESSFULLY");
      const botNumber = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      
      // Connection Success Message with Image
      await sock.sendMessage(botNumber, {
        image: { url: CONN_IMG },
        caption: "✅ *VIRAL-BOT LINKED SUCCESSFULLY*\n\nYour bot is now active and responding to commands. Type *.menu* to see available features."
      });
      pairingCode = null;
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason !== DisconnectReason.loggedOut) {
        console.log("🔄 Reconnecting...");
        startWhatsApp();
      }
    }
  });

  // --- Pairing Logic ---
  if (phone && !state.creds.registered) {
    await delay(5000); 
    try {
      pairingCode = await sock.requestPairingCode(phone);
    } catch (err) {
      console.error("Pairing Error:", err);
      pairingCode = "FAILED";
    }
  }

  // --- Message & Command Handler ---
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
    const type = Object.keys(msg.message)[0];

    // 1. Auto-Moderation (Group Only)
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

    // 2. Command Parsing
    if (!body.startsWith(".")) return;
    const args = body.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();

    // 3. Command List
    if (cmd === "menu") {
      const status = (k) => settings[k] ? "✅" : "❌";
      const helpText = `🌟 *VIRAL-BOT MINI MENU* 🌟\n\n` +
                       `*Admin Tools:*\n` +
                       `• .mute / .unmute\n` +
                       `• .tagall\n\n` +
                       `*Moderation Settings:*\n` +
                       `• .antilink [on/off] (${status('antilink')})\n` +
                       `• .antisticker [on/off] (${status('antisticker')})\n` +
                       `• .antiaudio [on/off] (${status('antiaudio')})`;
      
      await sock.sendMessage(from, { image: { url: MENU_IMG }, caption: helpText });
    }

    if (cmd === "mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement");
      await sock.sendMessage(from, { text: "🔇 *Group Muted.* Only admins can speak." });
    }

    if (cmd === "unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement");
      await sock.sendMessage(from, { text: "🔊 *Group Unmuted.* Everyone can speak." });
    }

    if (cmd === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from);
      const members = meta.participants.map(p => p.id);
      const tags = members.map(u => `@${u.split("@")[0]}`).join(" ");
      await sock.sendMessage(from, { text: `📢 *Attention Members:*\n\n${tags}`, mentions: members });
    }

    if (["antilink", "antisticker", "antiaudio"].includes(cmd)) {
      const mode = args[0]?.toLowerCase();
      if (mode === "on") {
        settings[cmd] = true;
        await sock.sendMessage(from, { text: `✅ *${cmd}* has been enabled.` });
      } else if (mode === "off") {
        settings[cmd] = false;
        await sock.sendMessage(from, { text: `❌ *${cmd}* has been disabled.` });
      }
    }
  });
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
    if (++tries > 25) {
      clearInterval(timer);
      res.json({ code: "FAILED" });
    }
  }, 1000);
});

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(3000, () => console.log("🌐 Server live at http://localhost:3000"));
