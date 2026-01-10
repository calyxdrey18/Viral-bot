const express = require("express")
const path = require("path")
const Pino = require("pino")

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys")

const app = express()
app.use(express.json())

let sock = null
let pairCode = null
let pairingInProgress = false

/* ================= BOT SETTINGS ================= */

let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
}

/* ================= START BOT ================= */

async function startBot(phone) {
  if (pairingInProgress) return
  pairingInProgress = true

  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false
  })

  sock.ev.on("creds.update", saveCreds)

  // 🔥 WAIT A MOMENT, THEN REQUEST PAIR CODE
  setTimeout(async () => {
    if (!state.creds.registered) {
      try {
        pairCode = await sock.requestPairingCode(phone)
        console.log("✅ PAIR CODE:", pairCode)
      } catch (err) {
        console.error("❌ Pair code error:", err.message)
        pairCode = null
      }
    }
  }, 1200)

  sock.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED")
      pairingInProgress = false
      pairCode = null
    }
  })

  /* ================= MESSAGE HANDLER ================= */

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      ""

    if (isGroup) {
      if (settings.antilink && text.includes("http")) {
        await sock.sendMessage(from, { delete: msg.key })
      }
      if (settings.antisticker && msg.message.stickerMessage) {
        await sock.sendMessage(from, { delete: msg.key })
      }
      if (settings.antiaudio && msg.message.audioMessage) {
        await sock.sendMessage(from, { delete: msg.key })
      }
    }

    if (!text.startsWith(".")) return
    const cmd = text.toLowerCase()

    if (cmd === ".mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement")
      sock.sendMessage(from, { text: "🔇 Group muted" })
    }

    if (cmd === ".unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement")
      sock.sendMessage(from, { text: "🔊 Group unmuted" })
    }

    if (cmd === ".tagall" && isGroup) {
      const meta = await sock.groupMetadata(from)
      const members = meta.participants.map(p => p.id)
      const tags = members.map(u => `@${u.split("@")[0]}`).join(" ")
      sock.sendMessage(from, { text: tags, mentions: members })
    }

    if (cmd === ".antilink on") settings.antilink = true
    if (cmd === ".antilink off") settings.antilink = false
    if (cmd === ".antisticker on") settings.antisticker = true
    if (cmd === ".antisticker off") settings.antisticker = false
    if (cmd === ".antiaudio on") settings.antiaudio = true
    if (cmd === ".antiaudio off") settings.antiaudio = false
  })
}

/* ================= API ================= */

app.post("/pair", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ error: "Phone number required" })

  if (!sock) await startBot(phone)

  // wait until pair code is ready
  let tries = 0
  const interval = setInterval(() => {
    if (pairCode || tries > 10) {
      clearInterval(interval)
      res.json({ code: pairCode || "FAILED" })
    }
    tries++
  }, 500)
})

/* ================= FRONTEND ================= */

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

/* ================= SERVER ================= */

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log("🌐 Server running on port", PORT)
})
