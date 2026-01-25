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

// 🔹 Fake contact with dynamic bot name (Global Constant)
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

// --- Helper: Send Styled Reply (Image + Caption) ---
const sendReply = async (socket, from, text, ctx, options = {}) => {
    const { config, mongo } = ctx;
    const number = socket.user.id.split(':')[0];
    
    // Fetch user config for custom logo
    const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
    const imgSource = userCfg.logo || config.FREE_IMAGE;
    
    let imagePayload;
    if (String(imgSource).startsWith('http')) {
        imagePayload = { url: imgSource };
    } else {
        try { 
            imagePayload = fs.readFileSync(imgSource); 
        } catch (e) { 
            imagePayload = { url: config.FREE_IMAGE }; 
        }
    }

    return socket.sendMessage(from, { 
        image: imagePayload,
        caption: text,
        footer: config.BOT_FOOTER,
        headerType: 4
    }, { quoted: options.quoted || fakevcard });
};

/**
 * Main Command Handler Function
 */
module.exports = async function handleCommand(socket, msg, ctx) {
    const { config, mongo, store } = ctx;
    const { bannedUsers, callBlockers, socketCreationTime, commandLogs } = store;

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

    // Group Settings Checks
    if (isGroup) {
        const settings = await mongo.getGroupSettings(from);
        const isAd = await mongo.isGroupAdmin(socket, from, sender);
        const isBotAd = await mongo.isBotAdmin(socket, from);

        if (settings.muted && !isCmd && !isAd) return;

        if (settings.anti.link && !isAd) {
            if (body.match(/(chat.whatsapp.com\/|whatsapp.com\/channel\/)/gi)) {
                await socket.sendMessage(from, { delete: msg.key });
                if (isBotAd) await socket.sendMessage(from, { text: `🚫 @${senderNumber}, Links are not allowed!`, mentions: [sender] });
            }
        }
        
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
                // Use sendReply for consistency, but menu usually has specific buttons
                // So we manually build it to include the specific menu buttons
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
                // Manually sending to include specific buttons
                await socket.sendMessage(from, {
                     text: ownerText, // Text message with buttons (caption not valid for text)
                     footer: config.BOT_FOOTER,
                     buttons: oButtons,
                     headerType: 1
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
                // Using sendReply logic but manually for buttons
                const img = userCfg.logo || config.FREE_IMAGE;
                let pImage;
                if (String(img).startsWith('http')) pImage = { url: img };
                else try { pImage = fs.readFileSync(img); } catch (e) { pImage = { url: config.FREE_IMAGE }; }
                
                const pButtons = [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" }, type: 1 }];

                await socket.sendMessage(from, {
                    image: pImage,
                    caption: pingText,
                    footer: config.BOT_FOOTER,
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
                await sendReply(socket, from, helpText, ctx);
                break;
            }

            // --- Tools ---
            case 'sticker':
            case 's':
                if (!/image|video|webp/.test(mime)) return sendReply(socket, from, 'Reply to an image/video.', ctx);
                const sbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { sticker: sbuffer }, { quoted: fakevcard });
                break;

            case 'toimg':
                if (!/webp/.test(mime)) return sendReply(socket, from, 'Reply to a sticker.', ctx);
                const wbuffer = await downloadMedia(qmsg);
                await sendReply(socket, from, 'Converted to Image', ctx); // Using helper, will send image of bot + caption? No, needs real image.
                // Special case: sending the converted media
                await socket.sendMessage(from, { image: wbuffer, caption: 'Converted to Image' }, { quoted: fakevcard });
                break;

            case 'user':
            case 'tools':
                const userCmds = `*👤 USER & TOOLS*\n\n.sticker - Image to Sticker\n.toimg - Sticker to Image\n.toaudio - Video to Audio\n.calc <math> - Calculate\n.qr <text> - Get QR Code\n.password - Gen Password\n.vv - Get ViewOnce`;
                await sendReply(socket, from, userCmds, ctx);
                break;

            case 'toaudio':
                if (!/video/.test(mime)) return sendReply(socket, from, 'Reply to a video.', ctx);
                const vbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { audio: vbuffer, mimetype: 'audio/mp4', ptt: false }, { quoted: fakevcard });
                break;

            case 'calc':
                if (!text) return sendReply(socket, from, 'Provide math expression.', ctx);
                try {
                    const stripped = text.replace(/[^0-9+\-*/().]/g, '');
                    const result = eval(stripped);
                    await sendReply(socket, from, `*Expression:* ${stripped}\n*Result:* ${result}`, ctx);
                } catch { await sendReply(socket, from, 'Invalid math expression.', ctx); }
                break;

            case 'qr':
                if (!text) return sendReply(socket, from, 'Provide text for QR.', ctx);
                // Send specific image
                await socket.sendMessage(from, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, caption: 'Here is your QR Code' }, { quoted: fakevcard });
                break;

            case 'reverse':
                if (!text) return sendReply(socket, from, 'Provide text.', ctx);
                await sendReply(socket, from, text.split('').reverse().join(''), ctx);
                break;

            case 'repeat':
                if (!text) return sendReply(socket, from, 'Provide text.', ctx);
                await sendReply(socket, from, text.repeat(3), ctx);
                break;

            case 'count':
                if (!text) return sendReply(socket, from, 'Provide text.', ctx);
                await sendReply(socket, from, `Chars: ${text.length}\nWords: ${text.split(' ').length}\nLines: ${text.split('\n').length}`, ctx);
                break;

            case 'password':
                const pwd = crypto.randomBytes(8).toString('hex');
                await sendReply(socket, from, `🔑 Password: ${pwd}`, ctx);
                break;

            case 'info':
                 await sendReply(socket, from, `*Name:* ${config.BOT_NAME}\n*Owner:* ${config.OWNER_NAME}\n*Number:* ${config.OWNER_NUMBER}\n*Version:* ${config.BOT_VERSION}`, ctx);
                 break;

            case 'runtime':
                 const upt2 = process.uptime();
                 const d2 = Math.floor(upt2 / (3600*24));
                 const h2 = Math.floor(upt2 % (3600*24) / 3600);
                 const m2 = Math.floor(upt2 % 3600 / 60);
                 const s2 = Math.floor(upt2 % 60);
                 await sendReply(socket, from, `${d2}d ${h2}h ${m2}m ${s2}s`, ctx);
                 break;

            case 'id':
                 await sendReply(socket, from, `*Chat ID:* ${from}\n*User ID:* ${sender}`, ctx);
                 break;

            // --- Owner ---
            case 'restart':
                if (!isOwner) return;
                await sendReply(socket, from, 'Restarting...', ctx);
                process.exit(1);
                break;

            case 'setname':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide name.', ctx);
                await socket.updateProfileName(text);
                await sendReply(socket, from, 'Bot name updated.', ctx);
                break;

            case 'setbio':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide bio.', ctx);
                await socket.updateProfileStatus(text);
                await sendReply(socket, from, 'Bio updated.', ctx);
                break;

            case 'ban':
                if (!isOwner) return;
                const banTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!banTarget) return sendReply(socket, from, 'Tag or reply to user.', ctx);
                bannedUsers.set(banTarget, true);
                await sendReply(socket, from, `Banned @${banTarget.split('@')[0]}`, ctx);
                break;
            
            case 'unban':
                if (!isOwner) return;
                const unbanTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!unbanTarget) return sendReply(socket, from, 'Tag or reply to user.', ctx);
                bannedUsers.delete(unbanTarget);
                await sendReply(socket, from, `Unbanned @${unbanTarget.split('@')[0]}`, ctx);
                break;

            case 'broadcast':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide text.', ctx);
                const allNums = await mongo.getAllNumbersFromMongo();
                for (let n of allNums) {
                    await socket.sendMessage(n + '@s.whatsapp.net', { text: `*📢 BROADCAST*\n\n${text}` }).catch(()=>{});
                }
                await sendReply(socket, from, `Broadcast sent to ${allNums.length} sessions.`, ctx);
                break;

            case 'logs':
                if (!isOwner) return;
                await sendReply(socket, from, commandLogs.join('\n') || 'No logs yet.', ctx);
                break;

            case 'stats':
                if (!isOwner) return;
                const count = ctx.store.activeSockets.size;
                await sendReply(socket, from, `Sessions: ${count}\nBanned: ${bannedUsers.size}\nUptime: ${process.uptime().toFixed(0)}s`, ctx);
                break;

            // --- Group ---
            case 'mute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', ctx);
                await mongo.updateGroupSettings(from, { muted: true });
                await sendReply(socket, from, '🔇 Group muted.', ctx);
                break;

            case 'unmute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', ctx);
                await mongo.updateGroupSettings(from, { muted: false });
                await sendReply(socket, from, '🔉 Group unmuted.', ctx);
                break;

            case 'antilink':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', ctx);
                const set = await mongo.getGroupSettings(from);
                const newVal = !set.anti.link;
                await mongo.updateGroupSettings(from, { 'anti.link': newVal });
                await sendReply(socket, from, `Anti-link is now ${newVal ? 'ON' : 'OFF'}`, ctx);
                break;

            // Add other toggles (antisticker, antiimg, etc.) similarly...

            default:
                break;
        }

    } catch (err) {
        console.error('Command handler error:', err);
        try { await socket.sendMessage(from, { text: `❌ ERROR: ${err.message}` }); } catch (e) { }
    }
};