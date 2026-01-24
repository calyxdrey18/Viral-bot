const { 
    getContentType, 
    downloadContentFromMessage, 
    jidNormalizedUser 
} = require('baileys');
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment-timezone');
const crypto = require('crypto');
const { exec } = require('child_process');

// 🔹 Fake contact with dynamic bot name
const fakevcard = {
    key: {
        remoteJid: "status@broadcast",
        participant: "0@s.whatsapp.net",
        fromMe: false,
        id: "META_AI_FAKE_ID"
    },
    message: {
        contactMessage: {
            displayName: "Viral-Bot-Mini",
            vcard: `BEGIN:VCARD
VERSION:3.0
N:Mini;;;;
FN:Meta
ORG:Calyx Studio
TEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002
END:VCARD`
        }
    }
};

// --- Helper: Download Media ---
const downloadMedia = async (msg) => {
    try {
        const type = Object.keys(msg)[0];
        const stream = await downloadContentFromMessage(msg[type], type.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (e) { return null; }
};

// --- Helper: Send Reply with Box ---
const sendReply = async (socket, from, text, options = {}) => {
    const boxText = `╭─❒「 ${options.title || 'BOT'} 」\n│ ${text.replace(/\n/g, '\n│ ')}\n╰───────────`;
    return socket.sendMessage(from, { text: boxText }, { quoted: options.quoted });
};

/**
 * Main Command Handler Function
 * @param {Object} socket - The Baileys socket instance
 * @param {Object} msg - The raw message object
 * @param {Object} ctx - Context object containing config, helpers, and global state
 */
module.exports = async function handleCommand(socket, msg, ctx) {
    const { config, mongo, store } = ctx;
    const { bannedUsers, callBlockers, activeSockets, socketCreationTime, commandLogs } = store;

    if (!msg.message) return;

    // 1. Message Normalization
    const messageContent = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
    const type = getContentType(messageContent);
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');

    // 2. Sender Identification
    const sender = isGroup ? (msg.key.participant || msg.participant) : msg.key.remoteJid;
    const senderNumber = sender.split('@')[0];
    const isOwner = senderNumber === config.OWNER_NUMBER.replace(/[^0-9]/g, '');

    // 3. Body Extraction
    const body = (type === 'conversation') ? messageContent.conversation :
        (type === 'extendedTextMessage') ? messageContent.extendedTextMessage.text :
        (type === 'imageMessage') ? messageContent.imageMessage.caption :
        (type === 'videoMessage') ? messageContent.videoMessage.caption :
        (type === 'buttonsResponseMessage') ? messageContent.buttonsResponseMessage?.selectedButtonId :
        (type === 'listResponseMessage') ? messageContent.listResponseMessage?.singleSelectReply?.selectedRowId :
        (type === 'viewOnceMessage') ? (messageContent.viewOnceMessage?.message?.imageMessage?.caption || '') : '';

    if (!body || typeof body !== 'string') return;

    // 4. Command Parsing
    const prefix = config.PREFIX;
    const isCmd = body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
    const args = body.trim().split(/ +/).slice(1);
    const text = args.join(" ");
    
    // 5. Quoted Message Helper
    const quoted = msg.quoted ? msg.quoted : msg;
    const qmsg = (msg.quoted ? msg.quoted.message : messageContent);
    const mime = (qmsg.msg || qmsg).mimetype || '';

    // --- LOGGING ---
    if (isCmd) {
        const logEntry = `[${moment().format('HH:mm:ss')}] CMD: ${command} FROM: ${senderNumber} IN: ${isGroup ? 'Group' : 'DM'}`;
        console.log(logEntry);
        commandLogs.push(logEntry);
        if (commandLogs.length > 15) commandLogs.shift();
    }

    // --- CHECKS ---
    if (bannedUsers.has(sender)) return;

    // Group Settings Checks (Anti-link, Mute, etc.)
    if (isGroup) {
        const settings = await mongo.getGroupSettings(from);
        const isAd = await mongo.isGroupAdmin(socket, from, sender);
        const isBotAd = await mongo.isBotAdmin(socket, from);

        // Mute check
        if (settings.muted && !isCmd && !isAd) return;

        // Anti-Link
        if (settings.anti.link && !isAd) {
            if (body.match(/(chat.whatsapp.com\/|whatsapp.com\/channel\/)/gi)) {
                await socket.sendMessage(from, { delete: msg.key });
                if (isBotAd) await socket.sendMessage(from, { text: `🚫 @${senderNumber}, Links are not allowed!`, mentions: [sender] });
            }
        }
        
        // Anti-Media checks (simplified for brevity)
        if (!isAd) {
            if ((settings.anti.image && type === 'imageMessage') || 
                (settings.anti.video && type === 'videoMessage')) {
                await socket.sendMessage(from, { delete: msg.key });
            }
        }
    }

    if (!isCmd) return;

    // ================= START OF COMMANDS SWITCH =================
    try {
        switch (command) {

            case 'menu': {
                try { await socket.sendMessage(from, { react: { text: "📂", key: msg.key } }); } catch (e) { }
                
                // Fetch dynamic data
                const number = socket.user.id.split(':')[0];
                const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
                
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                const menuText = `
╭────────￫
│  • ɴᴀᴍᴇ: ${userCfg.botName || config.BOT_NAME}
│  • ᴏᴡɴᴇʀ: ${config.OWNER_NAME}
│  • ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}
│  • ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
╰────────￫

╭─📂 𝐂𝐀𝐓𝐄𝐆𝐎𝐑𝐈𝐄𝐒
│ .user     - User Commands
│ .owner    - Owner Commands
│ .group    - Group Commands
│ .tools    - Tool Commands
╰──────────￫

Use ${prefix}help for a full list.
`;
                const img = userCfg.logo || config.FREE_IMAGE;
                let imagePayload;
                if (String(img).startsWith('http')) imagePayload = { url: img };
                else try { imagePayload = fs.readFileSync(img); } catch (e) { imagePayload = { url: config.FREE_IMAGE }; }

                const buttons = [
                    { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: "👑 ᴏᴡɴᴇʀ" }, type: 1 }
                ];

                await socket.sendMessage(from, {
                    image: imagePayload,
                    caption: menuText,
                    footer: config.BOT_FOOTER,
                    buttons: buttons,
                    headerType: 4
                }, { quoted: fakevcard });
                break;
            }

            case 'owner': {
                const ownerText = `
 \`👑 𝐎𝐖𝐍𝐄𝐑 𝐈𝐍𝐅𝐎 👑\`

╭─ 🧑‍💼 𝐃𝐄𝐓𝐀𝐈𝐋𝐒
│
│ ✦ 𝐍𝐚𝐦𝐞 : Wesley
│ ✦ 𝐀𝐠𝐞  : 19
│ ✦ 𝐍𝐨.  : +263786624966
│ ✦ 𝐃𝐞𝐯  : Calyx Drey
│
╰────────✧
`;
                const oButtons = [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" }, type: 1 }];
                await socket.sendMessage(from, {
                    text: ownerText,
                    footer: "👑 𝘖𝘸𝘯𝘦𝘳 𝘐𝘯𝘧𝘰𝘳𝘮𝘢𝘵𝘪𝘰𝘯",
                    buttons: oButtons
                }, { quoted: fakevcard });
                break;
            }

            case 'ping': {
                const start = Date.now();
                const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
                const number = socket.user.id.split(':')[0];
                const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
                const botName = userCfg.botName || 'Viral-Bot-Mini';

                const pingText = `
*📡 ${botName} ᴘɪɴɢ ɴᴏᴡ*

*◈ 🛠️ 𝐋atency :*  ${latency}ms
*◈ 🕢 𝐒erver 𝐓ime :* ${new Date().toLocaleString()}
`;
                const pButtons = [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" }, type: 1 }];
                const img = userCfg.logo || config.FREE_IMAGE;
                let pImage;
                if (String(img).startsWith('http')) pImage = { url: img };
                else try { pImage = fs.readFileSync(img); } catch (e) { pImage = { url: config.FREE_IMAGE }; }

                await socket.sendMessage(from, {
                    image: pImage,
                    caption: pingText,
                    footer: `*${botName} ᴘɪɴɢ*`,
                    buttons: pButtons,
                    headerType: 4
                }, { quoted: fakevcard });
                break;
            }

            case 'help': {
                const helpText = `
*📋 ALL COMMANDS*

*👤 User:* menu, help, user, info, ping, runtime, id, profile
*🛠️ Tools:* sticker, toimg, toaudio, calc, qr, reverse, repeat, count, password, vv
*👑 Owner:* restart, anticall, setname, setbio, setpp, broadcast, ban, unban, block, unblock, logs, stats
*👥 Group:* mute, unmute, setdesc, gsetname, lock, unlock, rules, setrules, welcome, goodbye
*🛡️ Security:* antilink, antisticker, antiaudio, antiimg, antivideo, antivv, antifile, antigcall
`;
                await sendReply(socket, from, helpText, { title: 'HELP MENU', quoted: fakevcard });
                break;
            }

            // --- Tools ---
            case 'sticker':
            case 's':
                if (!/image|video|webp/.test(mime)) return sendReply(socket, from, 'Reply to an image/video.', { quoted: fakevcard });
                const sbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { sticker: sbuffer }, { quoted: fakevcard });
                break;

            case 'toimg':
                if (!/webp/.test(mime)) return sendReply(socket, from, 'Reply to a sticker.', { quoted: fakevcard });
                const wbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { image: wbuffer, caption: 'Converted to Image' }, { quoted: fakevcard });
                break;

            case 'vv': // Get ViewOnce
                if (!quoted.message.viewOnceMessageV2 && !quoted.message.viewOnceMessage) return sendReply(socket, from, 'Reply to a ViewOnce message.', { quoted: fakevcard });
                const viewMedia = await downloadContentFromMessage(quoted.message.viewOnceMessageV2?.message?.imageMessage || quoted.message.viewOnceMessage?.message?.imageMessage || quoted.message.viewOnceMessageV2?.message?.videoMessage, quoted.message.viewOnceMessageV2?.message?.videoMessage ? 'video' : 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of viewMedia) buffer = Buffer.concat([buffer, chunk]);
                
                if (quoted.message.viewOnceMessageV2?.message?.videoMessage) {
                    await socket.sendMessage(from, { video: buffer, caption: '✅ Recovered ViewOnce' }, { quoted: fakevcard });
                } else {
                    await socket.sendMessage(from, { image: buffer, caption: '✅ Recovered ViewOnce' }, { quoted: fakevcard });
                }
                break;

            // --- Owner ---
            case 'restart':
                if (!isOwner) return;
                await sendReply(socket, from, 'Restarting...', { quoted: fakevcard });
                process.exit(1);
                break;

            case 'setname':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide name.', { quoted: fakevcard });
                await socket.updateProfileName(text);
                await sendReply(socket, from, 'Bot name updated.', { quoted: fakevcard });
                break;

            case 'ban':
                if (!isOwner) return;
                const banTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!banTarget) return sendReply(socket, from, 'Tag or reply to user.', { quoted: fakevcard });
                bannedUsers.set(banTarget, true);
                await sendReply(socket, from, `Banned @${banTarget.split('@')[0]}`, { mentions: [banTarget], quoted: fakevcard });
                break;
            
            case 'unban':
                if (!isOwner) return;
                const unbanTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!unbanTarget) return sendReply(socket, from, 'Tag or reply to user.', { quoted: fakevcard });
                bannedUsers.delete(unbanTarget);
                await sendReply(socket, from, `Unbanned @${unbanTarget.split('@')[0]}`, { mentions: [unbanTarget], quoted: fakevcard });
                break;

            case 'logs':
                if (!isOwner) return;
                await sendReply(socket, from, commandLogs.join('\n') || 'No logs yet.', { title: 'SYSTEM LOGS', quoted: fakevcard });
                break;

            // --- Group ---
            case 'mute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', { quoted: fakevcard });
                await mongo.updateGroupSettings(from, { muted: true });
                await sendReply(socket, from, '🔇 Group muted.', { quoted: fakevcard });
                break;

            case 'unmute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', { quoted: fakevcard });
                await mongo.updateGroupSettings(from, { muted: false });
                await sendReply(socket, from, '🔉 Group unmuted.', { quoted: fakevcard });
                break;

            case 'antilink':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', { quoted: fakevcard });
                const set = await mongo.getGroupSettings(from);
                const newVal = !set.anti.link;
                await mongo.updateGroupSettings(from, { 'anti.link': newVal });
                await sendReply(socket, from, `Anti-link is now ${newVal ? 'ON' : 'OFF'}`, { quoted: fakevcard });
                break;

            default:
                break;
        }

    } catch (err) {
        console.error('Command handler error:', err);
        try { await socket.sendMessage(from, { text: `❌ ERROR: ${err.message}` }); } catch (e) { }
    }
};