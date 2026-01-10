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
let pairCode = null;
let isStarting = false;

// Bot settings
const settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
};

async function startBot(phone) {
  if (isStarting) return;
  isStarting = true;

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    auth: state,
    version,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome")
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ WhatsApp Connected");
      pairCode = null;
      isStarting = false;
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      console.log("❌ Disconnected:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        await delay(3000);
        startBot();
      }
    }
  });

  // Pairing
  if (phone && !state.creds.registered) {
    await delay(4000);
    try {
      pairCode = await sock.requestPairingCode(phone.replace(/\D/g, ""));
      console.log("🔑 Pair Code:", pairCode);
    } catch {
      pairCode = "FAILED";
    }
  }

  // Message handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");

    const body =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    if (!body.startsWith(".")) return;

    const [command, ...args] = body.slice(1).trim().split(" ");

    if (command === "menu") {
      await sock.sendMessage(from, {
        text:
`🌟 *VIRAL BOT MENU*

• .menu
• .tagall
• .mute / .unmute

Security:
• .antilink on/off
• .antisticker on/off
• .antiaudio on/off`
      });
    }

    if (command === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from);
      const members = meta.participants.map(p => p.id);
      await sock.sendMessage(from, {
        text: members.map(u => `@${u.split("@")[0]}`).join(" "),
        mentions: members
      });
    }

    if (command === "mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement");
      await sock.sendMessage(from, { text: "🔇 Group muted" });
    }

    if (command === "unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement");
      await sock.sendMessage(from, { text: "🔊 Group unmuted" });
    }

    if (["antilink", "antisticker", "antiaudio"].includes(command)) {
      settings[command] = args[0] === "on";
      await sock.sendMessage(from, {
        text: `✅ ${command} ${args[0]}`
      });
    }
  });
}

// API
app.post("/pair", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.json({ code: "FAILED" });

  pairCode = null;
  await startBot(phone);

  let tries = 0;
  const timer = setInterval(() => {
    if (pairCode) {
      clearInterval(timer);
      res.json({ code: pairCode });
    }
    if (tries++ > 25) {
      clearInterval(timer);
      res.json({ code: "FAILED" });
    }
  }, 1000);
});

app.get("/", (_, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

app.listen(3000, () =>
  console.log("🌐 Server running on http://localhost:3000")
);