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

// ---------------- FONT HELPERS ----------------

const toBoldSans = (text) => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const bold = "𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃𝘄𝘅𝘆𝘇𝟬𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵";
    return text.split('').map(c => {
        const i = chars.indexOf(c);
        return i !== -1 ? bold.substr(i * 2, 2) : c; // Bold sans chars are mostly 2 bytes/surrogates
    }).join('');
};

// Simplified Bold Sans map for standard regex replacement to ensure stability
const fontBoldSans = (text) => {
    const map = {
        'A': '𝗔', 'B': '𝗕', 'C': '𝗖', 'D': '𝗗', 'E': '𝗘', 'F': '𝗙', 'G': '𝗚', 'H': '𝗛', 'I': '𝗜', 'J': '𝗝', 'K': '𝗞', 'L': '𝗟', 'M': '𝗠', 'N': '𝗡', 'O': '𝗢', 'P': '𝗣', 'Q': '𝗤', 'R': '𝗥', 'S': '𝗦', 'T': '𝗧', 'U': '𝗨', 'V': '𝗩', 'W': '𝗪', 'X': '𝗫', 'Y': '𝗬', 'Z': '𝗭',
        'a': '𝗮', 'b': '𝗯', 'c': '𝗰', 'd': '𝗱', 'e': '𝗲', 'f': '𝗳', 'g': '𝗴', 'h': '𝗵', 'i': '𝗶', 'j': '𝗷', 'k': '𝗸', 'l': '𝗹', 'm': '𝗺', 'n': '𝗻', 'o': '𝗼', 'p': '𝗽', 'q': '𝗾', 'r': '𝗿', 's': '𝘀', 't': '𝘁', 'u': '𝘂', 'v': '𝘃', 'w': '𝘄', 'x': '𝘅', 'y': '𝘆', 'z': '𝘇',
        '0': '𝟬', '1': '𝟭', '2': '𝟮', '3': '𝟯', '4': '𝟰', '5': '𝟱', '6': '𝟲', '7': '𝟳', '8': '𝟴', '9': '𝟵'
    };
    return text.split('').map(char => map[char] || char).join('');
};

const toSmallCaps = (text) => {
    const map = {
        'a': 'ᴀ', 'b': 'ʙ', 'c': 'ᴄ', 'd': 'ᴅ', 'e': 'ᴇ', 'f': 'ғ', 'g': 'ɢ', 'h': 'ʜ', 'i': 'ɪ', 'j': 'ᴊ', 'k': 'ᴋ', 'l': 'ʟ', 'm': 'ᴍ', 'n': 'ɴ', 'o': 'ᴏ', 'p': 'ᴘ', 'q': 'ǫ', 'r': 'ʀ', 's': 's', 't': 'ᴛ', 'u': 'ᴜ', 'v': 'ᴠ', 'w': 'ᴡ', 'x': 'x', 'y': 'ʏ', 'z': 'ᴢ',
        'A': 'ᴀ', 'B': 'ʙ', 'C': 'ᴄ', 'D': 'ᴅ', 'E': 'ᴇ', 'F': 'ғ', 'G': 'ɢ', 'H': 'ʜ', 'I': 'ɪ', 'J': 'ᴊ', 'K': 'ᴋ', 'L': 'ʟ', 'M': 'ᴍ', 'N': 'ɴ', 'O': 'ᴏ', 'P': 'ᴘ', 'Q': 'ǫ', 'R': 'ʀ', 'S': 's', 'T': 'ᴛ', 'U': 'ᴜ', 'V': 'ᴠ', 'W': 'ᴡ', 'X': 'x', 'Y': 'ʏ', 'Z': 'ᴢ'
    };
    return text.split('').map(char => map[char] || char).join('');
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

// --- Helper: Viral Box Formatter ---
const formatViralBox = (title, lines) => {
    const header = `╭─📂 ${fontBoldSans(title.toUpperCase())}`;
    let content = '';
    
    // Check if lines is array or string
    const linesArray = Array.isArray(lines) ? lines : lines.split('\n');
    
    linesArray.forEach(line => {
        if (line.trim()) content += `│ ${line.trim()}\n`;
    });
    
    const footer = `╰──────────￫`;
    return `${header}\n${content}${footer}`;
};

// --- Helper: Send Styled Reply ---
const sendReply = async (socket, from, text, ctx, options = {}) => {
    const { config, mongo } = ctx;
    const number = socket.user.id.split(':')[0];
    
    // Fetch user config for custom logo
    const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
    const imgSource = userCfg.logo || config.FREE_IMAGE;
    
    // Create Viral Styled Text
    let styledText = "";
    if (options.isRaw) {
        styledText = text; // Pass through already formatted text
    } else {
        const title = options.title || 'BOT NOTICE';
        styledText = formatViralBox(title, text);
    }

    // Determine if we need an image (always for menu/help/info, optional for others)
    const useImage = options.useImage !== false; 

    if (useImage) {
        let imagePayload;
        if (String(imgSource).startsWith('http')) {
            imagePayload = { url: imgSource };
        } else {
            try { imagePayload = fs.readFileSync(imgSource); } 
            catch (e) { imagePayload = { url: config.FREE_IMAGE }; }
        }

        return socket.sendMessage(from, { 
            image: imagePayload,
            caption: styledText,
            footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
            buttons: options.buttons || [],
            headerType: 4
        }, { quoted: options.quoted || fakevcard });
    } else {
        // Text-only reply (for simple errors or short confirmations)
        return socket.sendMessage(from, { 
            text: styledText + '\n\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ'
        }, { quoted: options.quoted || fakevcard });
    }
};

/**
 * Main Command Handler Function
 */
module.exports = async function handleCommand(socket, msg, ctx) {
    const { config, mongo, store } = ctx;
    const { bannedUsers, socketCreationTime, commandLogs } = store;

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
        const logEntry = `[${moment().format('HH:mm:ss')}] CMD: ${command} FROM: ${senderNumber}`;
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
                if (isBotAd) await socket.sendMessage(from, { text: `🚫 @${senderNumber}, Links!` });
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

            // ================= MENU & INFO =================
            case 'menu': {
                try { await socket.sendMessage(from, { react: { text: "📂", key: msg.key } }); } catch (e) { }
                
                const number = socket.user.id.split(':')[0];
                const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
                
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                let menuText = formatViralBox('BOT INFO', 
`. ${toSmallCaps('Name')}: ${userCfg.botName || config.BOT_NAME}
. ${toSmallCaps('Owner')}: ${config.OWNER_NAME}
. ${toSmallCaps('Version')}: ${config.BOT_VERSION}
. ${toSmallCaps('Uptime')}: ${hours}h ${minutes}m ${seconds}s`
                );

                menuText += '\n\n';
                menuText += `*🎯 ${toSmallCaps('Select a category below')}*`;

                const buttons = [
                    { buttonId: `${config.PREFIX}user`, buttonText: { displayText: "𝗨𝗦𝗘𝗥" }, type: 1 },
                    { buttonId: `${config.PREFIX}tools`, buttonText: { displayText: "𝗧𝗢𝗢𝗟𝗦" }, type: 1 },
                    { buttonId: `${config.PREFIX}group`, buttonText: { displayText: "𝗚𝗥𝗢𝗨𝗣" }, type: 1 }
                ];

                await sendReply(socket, from, menuText, ctx, { isRaw: true, buttons: buttons, useImage: true });
                break;
            }

            case 'user': {
                const cmdList = ['.menu', '.help', '.user', '.info', '.ping', '.runtime', '.id', '.profile'];
                const formatted = cmdList.map(c => c.replace('.', '.') + toSmallCaps(c.substring(1))).join('\n');
                
                await sendReply(socket, from, formatted, ctx, { title: 'USER COMMANDS', useImage: true });
                break;
            }

            case 'tools': {
                const cmdList = ['.sticker', '.toimg', '.toaudio', '.calc', '.qr', '.reverse', '.repeat', '.count', '.password', '.vv'];
                const formatted = cmdList.map(c => c.replace('.', '.') + toSmallCaps(c.substring(1))).join('\n');
                
                await sendReply(socket, from, formatted, ctx, { title: 'TOOL COMMANDS', useImage: true });
                break;
            }

            case 'group': {
                const cmdList = ['.mute', '.unmute', '.setdesc', '.gsetname', '.lock', '.unlock', '.rules', '.setrules', '.welcome', '.goodbye'];
                const formatted = cmdList.map(c => c.replace('.', '.') + toSmallCaps(c.substring(1))).join('\n');
                
                await sendReply(socket, from, formatted, ctx, { title: 'GROUP COMMANDS', useImage: true });
                break;
            }

            case 'owner': {
                const ownerText = `
. ${toSmallCaps('Name')}: Wesley
. ${toSmallCaps('Age')}: 19
. ${toSmallCaps('Contact')}: +263786624966
. ${toSmallCaps('Dev')}: Calyx Drey
`;
                const oButtons = [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" }, type: 1 }];
                await sendReply(socket, from, ownerText, ctx, { title: 'OWNER INFO', buttons: oButtons, useImage: true });
                break;
            }

            case 'ping': {
                const start = Date.now();
                const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
                const number = socket.user.id.split(':')[0];
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = process.uptime().toFixed(0);

                const pingText = `
. ${toSmallCaps('Latency')}: ${latency}ms
. ${toSmallCaps('Uptime')}: ${uptime}s
. ${toSmallCaps('Date')}: ${new Date().toLocaleDateString()}
`;
                await sendReply(socket, from, pingText, ctx, { title: 'SYSTEM STATUS', useImage: false });
                break;
            }

            case 'help': {
                // Combined lists for help
                const helpText = formatViralBox('USER', `.menu\n.ping\n.info\n.runtime`) + "\n\n" +
                                 formatViralBox('TOOLS', `.sticker\n.toimg\n.toaudio\n.qr`) + "\n\n" +
                                 formatViralBox('OWNER', `.restart\n.broadcast\n.ban\n.unban`) + "\n\n" +
                                 formatViralBox('GROUP', `.mute\n.unmute\n.lock\n.unlock`);
                                 
                await sendReply(socket, from, helpText, ctx, { isRaw: true, useImage: true });
                break;
            }

            // ================= TOOLS =================
            case 'sticker':
            case 's':
                if (!/image|video|webp/.test(mime)) return sendReply(socket, from, 'Reply to image/video', ctx, { title: 'ERROR' });
                const sbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { sticker: sbuffer }, { quoted: fakevcard });
                break;

            case 'toimg':
                if (!/webp/.test(mime)) return sendReply(socket, from, 'Reply to sticker', ctx, { title: 'ERROR' });
                const wbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { image: wbuffer, caption: formatViralBox('SUCCESS', toSmallCaps('Sticker converted')) }, { quoted: fakevcard });
                break;

            case 'toaudio':
                if (!/video/.test(mime)) return sendReply(socket, from, 'Reply to video', ctx, { title: 'ERROR' });
                const vbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { audio: vbuffer, mimetype: 'audio/mp4', ptt: false }, { quoted: fakevcard });
                break;

            case 'calc':
                if (!text) return sendReply(socket, from, 'Provide expression', ctx, { title: 'ERROR' });
                try {
                    const stripped = text.replace(/[^0-9+\-*/().]/g, '');
                    const result = eval(stripped);
                    await sendReply(socket, from, `. ${toSmallCaps('Input')}: ${stripped}\n. ${toSmallCaps('Result')}: ${result}`, ctx, { title: 'CALCULATOR' });
                } catch { await sendReply(socket, from, 'Invalid math', ctx, { title: 'ERROR' }); }
                break;

            case 'qr':
                if (!text) return sendReply(socket, from, 'Provide text', ctx, { title: 'ERROR' });
                await socket.sendMessage(from, { 
                    image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, 
                    caption: formatViralBox('QR CODE', toSmallCaps('Here is your QR')),
                    footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ' 
                }, { quoted: fakevcard });
                break;

            case 'reverse':
                if (!text) return sendReply(socket, from, 'Provide text', ctx, { title: 'ERROR' });
                await sendReply(socket, from, text.split('').reverse().join(''), ctx, { title: 'REVERSE' });
                break;

            case 'repeat':
                if (!text) return sendReply(socket, from, 'Provide text to repeat', ctx, { title: 'ERROR' });
                // Repeats text 3 times separated by newlines
                const repeated = `${text}\n${text}\n${text}`;
                await sendReply(socket, from, repeated, ctx, { title: 'REPEAT', useImage: false });
                break;

            case 'count':
                if (!text) return sendReply(socket, from, 'Provide text', ctx, { title: 'ERROR' });
                const countRes = `. Chars: ${text.length}\n. Words: ${text.split(' ').length}`;
                await sendReply(socket, from, countRes, ctx, { title: 'COUNT', useImage: false });
                break;

            case 'password':
                const pwd = crypto.randomBytes(8).toString('hex');
                await sendReply(socket, from, `. ${toSmallCaps('Pass')}: ${pwd}`, ctx, { title: 'PASSWORD' });
                break;

            case 'info':
                 const infoRes = `. Name: ${config.BOT_NAME}\n. Owner: ${config.OWNER_NAME}`;
                 await sendReply(socket, from, infoRes, ctx, { title: 'INFO' });
                 break;

            case 'runtime':
                 const upt = process.uptime();
                 const d = Math.floor(upt / (3600*24));
                 const h = Math.floor(upt % (3600*24) / 3600);
                 const m = Math.floor(upt % 3600 / 60);
                 await sendReply(socket, from, `${d}d ${h}h ${m}m`, ctx, { title: 'RUNTIME' });
                 break;

            case 'id':
                 await sendReply(socket, from, `. Chat: ${from}\n. User: ${sender}`, ctx, { title: 'ID INFO' });
                 break;

            case 'profile':
                 try {
                    const pp = await socket.profilePictureUrl(sender, 'image');
                    await socket.sendMessage(from, { image: { url: pp }, caption: formatViralBox('PROFILE', toSmallCaps('Here is your profile')) }, { quoted: fakevcard });
                 } catch {
                    await sendReply(socket, from, 'No profile pic', ctx, { title: 'ERROR' });
                 }
                 break;

            case 'vv': 
                if (!quoted.message.viewOnceMessageV2 && !quoted.message.viewOnceMessage) return sendReply(socket, from, 'Reply ViewOnce', ctx, { title: 'ERROR' });
                const media = await downloadContentFromMessage(quoted.message.viewOnceMessageV2?.message?.imageMessage || quoted.message.viewOnceMessage?.message?.imageMessage || quoted.message.viewOnceMessageV2?.message?.videoMessage, quoted.message.viewOnceMessageV2?.message?.videoMessage ? 'video' : 'image');
                let buff = Buffer.from([]);
                for await (const chunk of media) buff = Buffer.concat([buff, chunk]);
                
                const vvCap = formatViralBox('SUCCESS', toSmallCaps('ViewOnce Recovered'));
                if (quoted.message.viewOnceMessageV2?.message?.videoMessage) {
                    await socket.sendMessage(from, { video: buff, caption: vvCap }, { quoted: fakevcard });
                } else {
                    await socket.sendMessage(from, { image: buff, caption: vvCap }, { quoted: fakevcard });
                }
                break;

            // ================= OWNER =================
            case 'restart':
                if (!isOwner) return;
                await sendReply(socket, from, 'Restarting...', ctx, { title: 'SYSTEM' });
                process.exit(1);
                break;

            case 'setname':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide name', ctx, { title: 'ERROR' });
                await socket.updateProfileName(text);
                await sendReply(socket, from, 'Name updated', ctx, { title: 'SUCCESS' });
                break;

            case 'setbio':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide bio', ctx, { title: 'ERROR' });
                await socket.updateProfileStatus(text);
                await sendReply(socket, from, 'Bio updated', ctx, { title: 'SUCCESS' });
                break;

            case 'broadcast':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide text', ctx, { title: 'ERROR' });
                const nums = await mongo.getAllNumbersFromMongo();
                for (let n of nums) await socket.sendMessage(n + '@s.whatsapp.net', { text: `*📢 BROADCAST*\n\n${text}` }).catch(()=>{});
                await sendReply(socket, from, `Sent to ${nums.length} users`, ctx, { title: 'SUCCESS' });
                break;

            case 'ban':
                if (!isOwner) return;
                const bT = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!bT) return sendReply(socket, from, 'Tag user', ctx, { title: 'ERROR' });
                bannedUsers.set(bT, true);
                await sendReply(socket, from, `Banned @${bT.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [bT] });
                break;
            
            case 'unban':
                if (!isOwner) return;
                const uT = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!uT) return sendReply(socket, from, 'Tag user', ctx, { title: 'ERROR' });
                bannedUsers.delete(uT);
                await sendReply(socket, from, `Unbanned @${uT.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [uT] });
                break;

            case 'logs':
                if (!isOwner) return;
                await sendReply(socket, from, commandLogs.join('\n') || 'No logs', ctx, { title: 'LOGS' });
                break;

            case 'stats':
                if (!isOwner) return;
                const c = ctx.store.activeSockets.size;
                await sendReply(socket, from, `. Sessions: ${c}\n. Banned: ${bannedUsers.size}`, ctx, { title: 'STATS' });
                break;

            // ================= GROUP =================
            case 'mute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { muted: true });
                await sendReply(socket, from, 'Group muted', ctx, { title: 'SUCCESS' });
                break;

            case 'unmute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { muted: false });
                await sendReply(socket, from, 'Group unmuted', ctx, { title: 'SUCCESS' });
                break;

            case 'lock':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                await socket.groupSettingUpdate(from, 'announcement');
                await mongo.updateGroupSettings(from, { locked: true });
                await sendReply(socket, from, 'Group locked', ctx, { title: 'SUCCESS' });
                break;

            case 'unlock':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                await socket.groupSettingUpdate(from, 'not_announcement');
                await mongo.updateGroupSettings(from, { locked: false });
                await sendReply(socket, from, 'Group unlocked', ctx, { title: 'SUCCESS' });
                break;

            case 'setdesc':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                if (!text) return sendReply(socket, from, 'Provide description', ctx, { title: 'ERROR' });
                await socket.groupUpdateDescription(from, text);
                await sendReply(socket, from, 'Description updated', ctx, { title: 'SUCCESS' });
                break;

            case 'gsetname':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                if (!text) return sendReply(socket, from, 'Provide name', ctx, { title: 'ERROR' });
                await socket.groupUpdateSubject(from, text);
                await sendReply(socket, from, 'Subject updated', ctx, { title: 'SUCCESS' });
                break;

            case 'welcome':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                const wSet = await mongo.getGroupSettings(from);
                await mongo.updateGroupSettings(from, { welcome: !wSet.welcome });
                await sendReply(socket, from, `Welcome is ${!wSet.welcome ? 'ON' : 'OFF'}`, ctx, { title: 'SUCCESS' });
                break;

            case 'goodbye':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                const gSet = await mongo.getGroupSettings(from);
                await mongo.updateGroupSettings(from, { goodbye: !gSet.goodbye });
                await sendReply(socket, from, `Goodbye is ${!gSet.goodbye ? 'ON' : 'OFF'}`, ctx, { title: 'SUCCESS' });
                break;

            case 'antilink':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only', ctx, { title: 'ERROR' });
                const set = await mongo.getGroupSettings(from);
                const newVal = !set.anti.link;
                await mongo.updateGroupSettings(from, { 'anti.link': newVal });
                await sendReply(socket, from, `Anti-link is ${newVal ? 'ON' : 'OFF'}`, ctx, { title: 'SECURITY' });
                break;

            // Add other toggles (antisticker, antiimg, etc.) similarly...

            default:
                break;
        }

    } catch (err) {
        console.error('Command handler error:', err);
        try { 
            const errorMsg = formatViralBox('ERROR', err.message);
            await socket.sendMessage(from, { text: errorMsg }); 
        } catch (e) { }
    }
};
