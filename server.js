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

let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
};

async function startBot(phone) {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome") 
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED");
      const user = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      await sock.sendMessage(user, { 
        image: { url: "https://i.ibb.co/V9X9X9/bot-connected.jpg" },
        caption: "✅ *VIRAL-BOT ACTIVE*\n\nCommands are now live. Type *.menu* to start." 
      });
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      if (reason !== DisconnectReason.loggedOut) startBot();
    }
  });

  // Pairing Logic
  if (phone && !state.creds.registered) {
    await delay(3000);
    try {
      pairCode = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ""));
    } catch (err) {
      pairCode = "FAILED";
    }
  }

  // --- MESSAGE HANDLER ---
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || "";
    const type = Object.keys(msg.message)[0];

    // Auto-Mod Logic
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
    const command = args.shift().toLowerCase();

    // Command Logic
    if (command === "menu") {
      const status = (k) => settings[k] ? "✅" : "❌";
      const text = `🌟 *VIRAL-BOT MENU* 🌟\n\n` +
                   `• .mute / .unmute\n` +
                   `• .tagall\n` +
                   `• .antilink [on/off] ${status('antilink')}\n` +
                   `• .antisticker [on/off] ${status('antisticker')}\n` +
                   `• .antiaudio [on/off] ${status('antiaudio')}`;
      await sock.sendMessage(from, { image: { url: "https://i.ibb.co/K2Zz8Y7/menu-banner.jpg" }, caption: text });
    }

    if (command === "mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement");
      await sock.sendMessage(from, { text: "🔇 Group Muted." });
    }

    if (command === "unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement");
      await sock.sendMessage(from, { text: "🔊 Group Unmuted." });
    }

    if (command === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from);
      const members = meta.participants.map(p => p.id);
      const tags = members.map(u => `@${u.split("@")[0]}`).join(" ");
      await sock.sendMessage(from, { text: `📢 *Attention:*\n\n${tags}`, mentions: members });
    }

    if (["antilink", "antisticker", "antiaudio"].includes(command)) {
      settings[command] = args[0] === "on";
      await sock.sendMessage(from, { text: `✅ ${command} set to ${args[0]}.` });
    }
  });
}

app.post("/pair", async (req, res) => {
  const { phone } = req.body;
  pairCode = null;
  await startBot(phone);
  let tries = 0;
  const interval = setInterval(() => {
    if (pairCode || tries > 20) {
      clearInterval(interval);
      res.json({ code: pairCode || "FAILED" });
    }
    tries++;
  }, 1000);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(3000, () => console.log("Server live on 3000"));
