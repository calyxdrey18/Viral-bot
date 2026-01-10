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

let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
}

async function startBot(phone) {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome") // Essential for stable pairing
  })

  sock.ev.on("creds.update", saveCreds)

  // Pairing Logic
  if (phone && !state.creds.registered) {
    setTimeout(async () => {
      try {
        pairCode = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ""))
        console.log("✅ PAIR CODE:", pairCode)
      } catch (err) {
        pairCode = "FAILED"
      }
    }, 2000)
  }

  sock.ev.on("connection.update", async ({ connection }) => {
    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED")
      const user = sock.user.id.split(":")[0] + "@s.whatsapp.net"
      await sock.sendMessage(user, { text: "✅ *CONNECTED TO VIRAL-BOT MINI*\n\nType *.menu* to start." })
      pairCode = null
    }
  })

  /* ================= FIXED MESSAGE HANDLER ================= */
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const isGroup = from.endsWith("@g.us")
    
    // Improved text extraction
    const body = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || 
                 msg.message.imageMessage?.caption || ""
    
    const type = Object.keys(msg.message)[0]

    // --- 1. AUTO MODERATION (Fixed checks) ---
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

    // --- 2. COMMAND PARSER ---
    if (!body.startsWith(".")) return
    
    // Split command and arguments
    const args = body.slice(1).trim().split(/ +/)
    const command = args.shift().toLowerCase()

    // --- 3. COMMANDS ---
    
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
      await sock.sendMessage(from, { text: help })
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

    // --- 4. SETTINGS HANDLER ---
    if (["antilink", "antisticker", "antiaudio"].includes(command)) {
      const mode = args[0]?.toLowerCase()
      if (mode === "on") {
        settings[command] = true
        await sock.sendMessage(from, { text: `✅ *${command}* has been enabled.` })
      } else if (mode === "off") {
        settings[command] = false
        await sock.sendMessage(from, { text: `❌ *${command}* has been disabled.` })
      }
    }
  })
}

app.post("/pair", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.json({ error: "Phone required" })
  await startBot(phone)
  let tries = 0
  const interval = setInterval(() => {
    if (pairCode || tries > 15) {
      clearInterval(interval)
      res.json({ code: pairCode || "FAILED" })
    }
    tries++
  }, 1000)
})

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log("🌐 Server live on", PORT))
