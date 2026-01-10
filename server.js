const express = require("express")
const path = require("path")
const Pino = require("pino")

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers
} = require("@whiskeysockets/baileys")

const app = express()
app.use(express.json())

let sock = null
let pairCode = null
let pairingInProgress = false

// Initial Settings
let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
}

async function startBot(phone) {
  if (pairingInProgress) return
  pairingInProgress = true

  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome") 
  })

  sock.ev.on("creds.update", saveCreds)

  // Request Pair Code
  setTimeout(async () => {
    if (!state.creds.registered && phone) {
      try {
        pairCode = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ""))
        console.log("✅ PAIR CODE:", pairCode)
      } catch (err) {
        console.error("❌ Pair code error:", err.message)
        pairCode = "FAILED"
      }
    }
  }, 2000)

  sock.ev.on("connection.update", async ({ connection }) => {
    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED")
      pairingInProgress = false
      pairCode = null
      
      // Notify user of successful connection
      const user = sock.user.id.split(":")[0] + "@s.whatsapp.net"
      await sock.sendMessage(user, { text: "✅ *CONNECTED TO VIRAL-BOT MINI*\n\nYour bot is now active and ready to manage groups." })
    }
  })

  /* ================= MESSAGE HANDLER ================= */

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    const type = Object.keys(msg.message)[0]

    // --- AUTO-MODERATION LOGIC ---
    if (isGroup) {
      if (settings.antilink && (body.includes("http://") || body.includes("https://"))) {
        await sock.sendMessage(from, { delete: msg.key })
      }
      if (settings.antisticker && type === 'stickerMessage') {
        await sock.sendMessage(from, { delete: msg.key })
      }
      if (settings.antiaudio && type === 'audioMessage') {
        await sock.sendMessage(from, { delete: msg.key })
      }
    }

    // --- COMMAND HANDLER ---
    if (!body.startsWith(".")) return
    const args = body.slice(1).trim().split(/ +/)
    const command = args.shift().toLowerCase()

    // 1. MENU COMMAND
    if (command === "menu") {
      const menuText = `
🌟 *VIRAL-BOT MINI MENU* 🌟

*Admin Commands:*
• .mute - Close group
• .unmute - Open group
• .tagall - Mention everyone

*Settings:*
• .antilink on/off [Current: ${settings.antilink ? '✅' : '❌'}]
• .antisticker on/off [Current: ${settings.antisticker ? '✅' : '❌'}]
• .antiaudio on/off [Current: ${settings.antiaudio ? '✅' : '❌'}]

_Powered by Viral-Bot_`
      await sock.sendMessage(from, { text: menuText })
    }

    // 2. GROUP MANAGEMENT
    if (command === "mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement")
      await sock.sendMessage(from, { text: "🔇 *Group Muted:* Only admins can send messages." })
    }

    if (command === "unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement")
      await sock.sendMessage(from, { text: "🔊 *Group Unmuted:* Everyone can now send messages." })
    }

    if (command === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from)
      const members = meta.participants.map(p => p.id)
      const tags = members.map(u => `@${u.split("@")[0]}`).join(" ")
      await sock.sendMessage(from, { text: `📢 *TAG ALL*\n\n${tags}`, mentions: members })
    }

    // 3. SETTINGS TOGGLES
    if (command === "antilink") {
      settings.antilink = args[0] === "on"
      await sock.sendMessage(from, { text: `Anti-Link is now *${settings.antilink ? "ON" : "OFF"}*` })
    }

    if (command === "antisticker") {
      settings.antisticker = args[0] === "on"
      await sock.sendMessage(from, { text: `Anti-Sticker is now *${settings.antisticker ? "ON" : "OFF"}*` })
    }

    if (command === "antiaudio") {
      settings.antiaudio = args[0] === "on"
      await sock.sendMessage(from, { text: `Anti-Audio is now *${settings.antiaudio ? "ON" : "OFF"}*` })
    }
  })
}

/* ================= API & SERVER ================= */

app.post("/pair", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ error: "Phone number required" })
  
  // Clean phone and start
  await startBot(phone)

  let tries = 0
  const interval = setInterval(() => {
    if (pairCode || tries > 20) {
      clearInterval(interval)
      res.json({ code: pairCode || "FAILED" })
    }
    tries++
  }, 1000)
})

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log("🌐 Server live on port", PORT))
