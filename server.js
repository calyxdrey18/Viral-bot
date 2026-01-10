const express = require("express")
const path = require("path")
const Pino = require("pino")
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  Browsers,
  delay,
  DisconnectReason
} = require("@whiskeysockets/baileys")
const { Boom } = require("@hapi/boom")
const fs = require('fs')

const app = express()
app.use(express.json())

let sock = null
let pairCode = null

// Bot Settings
let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
}

// Bot Image Assets
const BOT_IMG = "https://i.ibb.co/V9X9X9/bot-connected.jpg" 
const MENU_IMG = "https://i.ibb.co/K2Zz8Y7/menu-banner.jpg"

async function startBot(phone) {
  // Clear old session if connection is failing
  if (phone && fs.existsSync('./auth')) {
      // Note: In a production environment, you might want to manage folders carefully
  }

  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    // CRITICAL: Precise browser identification for pairing stability
    browser: Browsers.ubuntu("Chrome") 
  })

  sock.ev.on("creds.update", saveCreds)

  // CONNECTION HANDLER
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED")
      const user = sock.user.id.split(":")[0] + "@s.whatsapp.net"
      
      // Connection Success Message with Image
      await sock.sendMessage(user, { 
        image: { url: BOT_IMG },
        caption: "✅ *VIRAL-BOT LINKED SUCCESSFULLY*\n\nYour bot is now active. Type *.menu* to see available commands." 
      })
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode
      console.log(`❌ Connection Closed: ${reason}`)
      if (reason !== DisconnectReason.loggedOut) {
        startBot() // Auto-reconnect
      }
    }
  })

  // PAIRING LOGIC
  if (phone && !state.creds.registered) {
    await delay(5000) // Wait for socket stabilization
    try {
      const cleanPhone = phone.replace(/[^0-9]/g, "")
      pairCode = await sock.requestPairingCode(cleanPhone)
      console.log(`🔑 PAIRING CODE: ${pairCode}`)
    } catch (err) {
      console.error("Pairing Error:", err)
      pairCode = "FAILED"
    }
  }

  // MESSAGE HANDLER
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || ""
    const type = Object.keys(msg.message)[0]

    // --- AUTO MODERATION ---
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

    // --- COMMAND PARSER ---
    if (!body.startsWith(".")) return
    const args = body.slice(1).trim().split(/ +/)
    const command = args.shift().toLowerCase()

    // --- COMMAND LIST ---
    if (command === "menu") {
      const status = (key) => settings[key] ? "✅" : "❌"
      const help = `🌟 *VIRAL-BOT MINI MENU* 🌟\n\n` +
                   `*Group Admin Tools:*\n` +
                   `• .mute - Close group chat\n` +
                   `• .unmute - Open group chat\n` +
                   `• .tagall - Mention all members\n\n` +
                   `*Security Settings:*\n` +
                   `• .antilink on/off [${status('antilink')}]\n` +
                   `• .antisticker on/off [${status('antisticker')}]\n` +
                   `• .antiaudio on/off [${status('antiaudio')}]`
      
      await sock.sendMessage(from, { image: { url: MENU_IMG }, caption: help })
    }

    if (command === "mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement")
      await sock.sendMessage(from, { text: "🔇 *Group has been muted. Only admins can send messages.*" })
    }

    if (command === "unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement")
      await sock.sendMessage(from, { text: "🔊 *Group has been unmuted. Everyone can send messages.*" })
    }

    if (command === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from)
      const members = meta.participants.map(p => p.id)
      const tags = members.map(u => `@${u.split("@")[0]}`).join(" ")
      await sock.sendMessage(from, { text: `📢 *Attention Members:*\n\n${tags}`, mentions: members })
    }

    if (["antilink", "antisticker", "antiaudio"].includes(command)) {
      const mode = args[0]?.toLowerCase()
      if (mode === "on") {
        settings[command] = true
        await sock.sendMessage(from, { text: `✅ *${command}* is now active.` })
      } else if (mode === "off") {
        settings[command] = false
        await sock.sendMessage(from, { text: `❌ *${command}* has been disabled.` })
      }
    }
  })
}

// API Endpoints
app.post("/pair", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: "Phone required" })
  
  pairCode = null 
  await startBot(phone)
  
  // Polling for the pair code
  let tries = 0
  const interval = setInterval(() => {
    if (pairCode) {
      clearInterval(interval)
      res.json({ code: pairCode })
    } else if (tries > 30) { 
      clearInterval(interval)
      res.json({ code: "FAILED" })
    }
    tries++
  }, 1000)
})

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`🌐 Server running on http://localhost:${PORT}`))
