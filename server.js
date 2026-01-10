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
let state;
let saveCreds;
let pairingCode = null;
let connecting = false;

/* ---------------- START WHATSAPP ---------------- */
async function startWhatsApp() {
  if (connecting) return;
  connecting = true;

  const auth = await useMultiFileAuthState("auth");
  state = auth.state;
  saveCreds = auth.saveCreds;

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
      console.log("✅ WhatsApp LINKED");
      pairingCode = null;
      connecting = false;
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log("❌ Disconnected:", reason);

      if (reason !== DisconnectReason.loggedOut) {
        await delay(3000);
        startWhatsApp();
      }
    }
  });

  /* ---------------- COMMANDS ---------------- */
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const isGroup = from.endsWith("@g.us");

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      "";

    if (!text.startsWith(".")) return;

    const cmd = text.slice(1).trim().toLowerCase();

    if (cmd === "menu") {
      return sock.sendMessage(from, {
        text:
`🤖 *BOT COMMANDS*

• .menu
• .mute   → close group
• .unmute → open group`
      });
    }

    if (!isGroup) {
      return sock.sendMessage(from, {
        text: "❌ Group-only command."
      });
    }

    if (cmd === "mute") {
      try {
        await sock.groupSettingUpdate(from, "announcement");
        await sock.sendMessage(from, {
          text: "🔇 *Group closed*\nOnly admins can send messages."
        });
      } catch {
        await sock.sendMessage(from, {
          text: "❌ I must be an admin."
        });
      }
    }

    if (cmd === "unmute") {
      try {
        await sock.groupSettingUpdate(from, "not_announcement");
        await sock.sendMessage(from, {
          text: "🔊 *Group opened*\nEveryone can send messages."
        });
      } catch {
        await sock.sendMessage(from, {
          text: "❌ I must be an admin."
        });
      }
    }
  });
}

/* ---------------- PAIR CODE ROUTE ---------------- */
app.post("/pair", async (req, res) => {
  const phone = req.body.phone?.replace(/\D/g, "");
  if (!phone) return res.json({ code: "FAILED" });

  if (!sock || !state?.creds?.registered) {
    await startWhatsApp();

    // 🔑 CRITICAL WAIT (DO NOT REMOVE)
    await delay(6000);

    try {
      pairingCode = await sock.requestPairingCode(phone);
      console.log("🔑 PAIR CODE:", pairingCode);
    } catch (err) {
      console.error("Pair error:", err);
      return res.json({ code: "FAILED" });
    }
  }

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

/* ---------------- SERVER ---------------- */
app.get("/", (_, res) =>
  res.sendFile(path.join(__dirname, "index.html"))
);

app.listen(3000, () =>
  console.log("🌐 http://localhost:3000")
);