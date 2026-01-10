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

const app = express()
app.use(express.json())

let sock = null
let pairCode = null

// Settings for the bot
let settings = {
  antilink: false,
  antisticker: false,
  antiaudio: false
}

async function startBot(phone) {
  const { state, saveCreds } = await useMultiFileAuthState("auth")
  const { version } = await fetchLatestBaileysVersion()

  // Clean up existing socket if any
  if (sock) {
    sock.ev.removeAllListeners()
    sock.terminate()
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger: Pino({ level: "silent" }),
    printQRInTerminal: false,
    // CRITICAL: Precise browser string for pairing stability
    browser: Browsers.ubuntu("Chrome") 
  })

  // Pairing Logic - Triggered when the socket is ready
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update

    // 1. Generate Pairing Code only when the connection is "ready"
    if (!state.creds.registered && phone && !pairCode) {
        // Short delay to ensure socket readiness
        await delay(3000) 
        try {
            const cleanPhone = phone.replace(/[^0-9]/g, "")
            pairCode = await sock.requestPairingCode(cleanPhone)
            console.log(`🔑 PAIRING CODE GENERATED: ${pairCode}`)
        } catch (err) {
            console.error("Pairing Request Failed:", err)
            pairCode = "FAILED"
        }
    }

    if (connection === "open") {
      console.log("✅ WhatsApp CONNECTED")
      const user = sock.user.id.split(":")[0] + "@s.whatsapp.net"
      
      // Connection Image & Message
      await sock.sendMessage(user, { 
        image: { url: "https://i.ibb.co/V9X9X9/bot-connected.jpg" }, 
        caption: "✅ *VIRAL-BOT LINKED SUCCESSFULLY*\n\nYour bot is now active and ready. Type *.menu* to begin." 
      })
      pairCode = null
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode
      console.log(`❌ Connection Closed: ${reason}`)
      if (reason !== DisconnectReason.loggedOut) {
        startBot() // Auto-reconnect if not a logout
      }
    }
  })

  sock.ev.on("creds.update", saveCreds)

  // Message Handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const from = msg.key.remoteJid
    const body = msg.message.conversation || msg.message.extendedTextMessage?.text || ""
    
    if (!body.startsWith(".")) return
    const args = body.slice(1).trim().split(/ +/)
    const command = args.shift().toLowerCase()

    if (command === "menu") {
      const helpText = `🌟 *VIRAL-BOT MENU* 🌟\n\n` +
                       `• .mute / .unmute\n` +
                       `• .tagall\n` +
                       `• .antilink on/off`
      
      await sock.sendMessage(from, { 
        image: { url: "https://i.ibb.co/K2Zz8Y7/menu-banner.jpg" }, 
        caption: helpText 
      })
    }
    
    // Additional command logic (tagall, mute, etc.) goes here
  })
}

// API Routes
app.post("/pair", async (req, res) => {
  const { phone } = req.body
  if (!phone) return res.status(400).json({ error: "Phone required" })
  
  pairCode = null 
  await startBot(phone)
  
  // Wait for the async code generation in the event listener
  let tries = 0
  const interval = setInterval(() => {
    if (pairCode) {
      clearInterval(interval)
      res.json({ code: pairCode })
    } else if (tries > 25) { // 25 second timeout
      clearInterval(interval)
      res.json({ code: "FAILED" })
    }
    tries++
  }, 1000)
})

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log("🌐 Server active on port", PORT))
