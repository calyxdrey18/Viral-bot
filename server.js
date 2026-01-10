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

let sock
let pairCode = ""

/* ================= BOT SETTINGS ================= */

let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
}

/* ================= START BOT ================= */

async function startBot(phone) {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" })
  })

  sock.ev.on("creds.update", saveCreds)

  if (!state.creds.registered) {
    pairCode = await sock.requestPairingCode(phone)
    console.log("PAIR CODE:", pairCode)
  }

  sock.ev.on("connection.update", ({ connection }) => {
    if (connection === "open") {
      console.log("✅ WhatsApp connected")
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

    /* ===== ANTI FEATURES ===== */

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

    /* ===== GROUP COMMANDS ===== */

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

      sock.sendMessage(from, {
        text: tags,
        mentions: members
      })
    }

    /* ===== TOGGLES ===== */

    if (cmd === ".antilink on") {
      settings.antilink = true
      sock.sendMessage(from, { text: "✅ Anti-link ON" })
    }

    if (cmd === ".antilink off") {
      settings.antilink = false
      sock.sendMessage(from, { text: "❌ Anti-link OFF" })
    }

    if (cmd === ".antisticker on") {
      settings.antisticker = true
      sock.sendMessage(from, { text: "✅ Anti-sticker ON" })
    }

    if (cmd === ".antisticker off") {
      settings.antisticker = false
      sock.sendMessage(from, { text: "❌ Anti-sticker OFF" })
    }

    if (cmd === ".antiaudio on") {
      settings.antiaudio = true
      sock.sendMessage(from, { text: "✅ Anti-audio ON" })
    }

    if (cmd === ".antiaudio off") {
      settings.antiaudio = false
      sock.sendMessage(from, { text: "❌ Anti-audio OFF" })
    }
  })
}

/* ================= API ================= */

app.post("/pair", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ error: "Phone number required" })

  await startBot(phone)
  setTimeout(() => res.json({ code: pairCode }), 1500)
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
