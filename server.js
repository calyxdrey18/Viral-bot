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

// URL for the bot image - You can replace this with your own link
const BOT_IMAGE = "https://i.imgur.com/your-image-link.jpg" 

let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
}

async function startBot(phone) {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  // Prevent duplicate connections
  if (sock) {
    try { sock.logout(); } catch (e) {}
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome") 
  })

  sock.ev.on("creds.update", saveCreds)

  // Pairing Logic
  if (phone && !state.creds.registered) {
    setTimeout(async () => {
      try {
        // Clean phone number: remove any non-digit characters
        const cleanPhone = phone.replace(/[^0-9]/g, "")
        pairCode = await sock.requestPairingCode(cleanPhone)
        console.log("✅ PAIR CODE:", pairCode)
      } catch (err) {
        console.error("Pairing Error:", err)
        pairCode = "FAILED"
      }
    }, 3000) // Increased delay for stability
  }

  sock.ev.on("connection.update", async ({ connection }) => {
    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED")
      const user = sock.user.id.split(":")[0] + "@s.whatsapp.net"
      
      // Connection Success Message with Image
      await sock.sendMessage(user, { 
        image: { url: "https://i.ibb.co/V9X9X9/bot-connected.jpg" }, // Default connection image
        caption: "✅ *CONNECTED TO VIRAL-BOT MINI*\n\nYour bot is now active. Type *.menu* to see commands." 
      })
      pairCode = null
    }
    
    if (connection === "close") {
        console.log("❌ Connection closed. Restarting logic handled by Baileys...")
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    
    const body = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || ""
    
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

    // --- COMMANDS ---
    if (!body.startsWith(".")) return
    const args = body.slice(1).trim().split(/ +/)
    const command = args.shift().toLowerCase()

    if (command === "menu") {
      const status = (key) => settings[key] ? "✅" : "❌"
      const help = `🌟 *VIRAL-BOT MINI MENU* 🌟\n\n` +
                   `*Group Controls:*\n` +
                   `• .mute / .unmute\n` +
                   `• .tagall\n\n` +
                   `*Settings:*\n` +
                   `• .antilink on/off [${status('antilink')}]\n` +
                   `• .antisticker on/off [${status('antisticker')}]\n` +
                   `• .antiaudio on/off [${status('antiaudio')}]`
      
      // Menu with Image
      await sock.sendMessage(from, { 
        image: { url: "https://i.ibb.co/K2Zz8Y7/menu-banner.jpg" }, // Use a different image for the menu
        caption: help 
      })
    }

    if (command === "mute" && isGroup) {
      await sock.groupSettingUpdate(from, "announcement")
      await sock.sendMessage(from, { text: "🔇 *Group Muted*" })
    }

    if (command === "unmute" && isGroup) {
      await sock.groupSettingUpdate(from, "not_announcement")
      await sock.sendMessage(from, { text: "🔊 *Group Unmuted*" })
    }

    if (command === "tagall" && isGroup) {
      const meta = await sock.groupMetadata(from)
      const members = meta.participants.map(p => p.id)
      const tags = members.map(u => `@${u.split("@")[0]}`).join(" ")
      await sock.sendMessage(from, { text: `📢 *Attention:*\n\n${tags}`, mentions: members })
    }

    if (["antilink", "antisticker", "antiaudio"].includes(command)) {
      const mode = args[0]?.toLowerCase()
      if (mode === "on") {
        settings[command] = true
        await sock.sendMessage(from, { text: `✅ *${command}* enabled.` })
      } else if (mode === "off") {
        settings[command] = false
        await sock.sendMessage(from, { text: `❌ *${command}* disabled.` })
      }
    }
  })
}

app.post("/pair", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: "Phone required" })
  
  pairCode = null // Reset before starting
  await startBot(phone)
  
  let tries = 0
  const interval = setInterval(() => {
    if (pairCode) {
      clearInterval(interval)
      res.json({ code: pairCode })
    } else if (tries > 20) {
      clearInterval(interval)
      res.json({ code: "FAILED" })
    }
    tries++
  }, 1000)
})

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log("🌐 Server live on port", PORT))
