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
        browser: Browsers.ubuntu("Chrome") // Fixes some pairing issues
    });

    sock.ev.on("creds.update", saveCreds);

    // Pairing Logic
    if (phone && !state.creds.registered) {
        setTimeout(async () => {
            try {
                pairCode = await sock.requestPairingCode(phone.replace(/[^0-9]/g, ""));
            } catch (err) {
                console.error("Pairing Error:", err);
                pairCode = "FAILED";
            }
        }, 2000);
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) 
                ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut 
                : true;
            if (shouldReconnect) startBot(); // Auto-reconnect
        } else if (connection === "open") {
            console.log("✅ Bot Connected Successfully");
            pairCode = null;
        }
    });

    // Integrated Group Management Logic
    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

        if (isGroup) {
            // Auto-Mod Features
            if (settings.antilink && (text.includes("http") || text.includes("https"))) {
                await sock.sendMessage(from, { delete: msg.key });
            }
            if (settings.antisticker && msg.message.stickerMessage) {
                await sock.sendMessage(from, { delete: msg.key });
            }

            // Commands
            if (text.startsWith(".")) {
                const cmd = text.toLowerCase();
                if (cmd === ".mute") await sock.groupSettingUpdate(from, "announcement");
                if (cmd === ".unmute") await sock.groupSettingUpdate(from, "not_announcement");
                if (cmd === ".tagall") {
                    const meta = await sock.groupMetadata(from);
                    const members = meta.participants.map(p => p.id);
                    await sock.sendMessage(from, { text: "📢 *Attention Everyone!*", mentions: members });
                }
            }
        }
    });
}

// Start immediately to resume session if exists
startBot();

app.post("/pair", async (req, res) => {
    const { phone } = req.body;
    await startBot(phone);
    let tries = 0;
    const interval = setInterval(() => {
        if (pairCode || tries > 20) {
            clearInterval(interval);
            res.json({ code: pairCode });
        }
        tries++;
    }, 500);
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server live on port ${PORT}`));
