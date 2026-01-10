const express = require("express");
const path = require("path");
const Pino = require("pino");
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    fetchLatestBaileysVersion, 
    DisconnectReason,
    Browsers 
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");

const app = express();
app.use(express.json());

let sock = null;
let pairCode = null;
let settings = { antilink: false, antisticker: false, antiaudio: false };

async function startBot(phone = null) {
    const { state, saveCreds } = await useMultiFileAuthState("auth");
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: state,
        logger: Pino({ level: "silent" }),
        printQRInTerminal: false,
        // CRITICAL FIX: Identifying as a real browser ensures WhatsApp accepts the link
        browser: Browsers.ubuntu("Chrome"), 
        syncFullHistory: false
    });

    sock.ev.on("creds.update", saveCreds);

    if (phone && !state.creds.registered) {
        setTimeout(async () => {
            try {
                // Remove any non-numeric characters from phone
                const cleanedPhone = phone.replace(/[^0-9]/g, "");
                pairCode = await sock.requestPairingCode(cleanedPhone);
                console.log(`✅ PAIR CODE GENERATED: ${pairCode}`);
            } catch (err) {
                console.error("❌ Pair code error:", err.message);
                pairCode = "FAILED";
            }
        }, 3000);
    }

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut 
                : true;
            if (shouldReconnect) startBot();
        } else if (connection === "open") {
            console.log("✅ WhatsApp CONNECTED");
            const userJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
            await sock.sendMessage(userJid, { text: "✅ *CONNECTED TO VIRAL-BOT MINI*\n\nYour bot is now active. Type *.menu* in any group to see commands." });
            pairCode = null;
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        const type = Object.keys(msg.message)[0];

        // Anti-Mod Logic
        if (isGroup) {
            if (settings.antilink && (body.includes("http://") || body.includes("https://"))) {
                await sock.sendMessage(from, { delete: msg.key });
            }
            if (settings.antisticker && type === 'stickerMessage') {
                await sock.sendMessage(from, { delete: msg.key });
            }
        }

        // Commands
        if (!body.startsWith(".")) return;
        const args = body.slice(1).trim().split(/ +/);
        const command = args.shift().toLowerCase();

        if (command === "menu") {
            const menu = `🌟 *VIRAL-BOT MINI*\n\n*Admin:*\n.mute / .unmute\n.tagall\n\n*Settings:*\n.antilink on/off\n.antisticker on/off`;
            await sock.sendMessage(from, { text: menu });
        }
        
        if (command === "antilink") {
            settings.antilink = args[0] === "on";
            await sock.sendMessage(from, { text: `Anti-Link: ${settings.antilink ? "✅" : "❌"}` });
        }
    });
}

startBot();

app.post("/pair", async (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.json({ error: "Phone required" });
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
app.listen(process.env.PORT || 3000);
