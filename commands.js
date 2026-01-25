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

// --- Helper: Viral Box Formatter ---
const formatViralBox = (title, text) => {
    const lines = text.trim().split('\n');
    let box = `╭─📂 ${title.toUpperCase()}\n`;
    lines.forEach(line => {
        if (line.trim()) box += `│ ${line.trim()}\n`;
    });
    box += `╰──────────￫`;
    return box;
};

// --- Helper: Send Styled Reply (Image + Caption) ---
const sendReply = async (socket, from, text, ctx, options = {}) => {
    const { config, mongo } = ctx;
    const number = socket.user.id.split(':')[0];
    
    // Fetch user config for custom logo
    const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
    const imgSource = userCfg.logo || config.FREE_IMAGE;
    
    // Apply Viral Formatting
    const title = options.title || 'BOT NOTICE';
    const styledText = formatViralBox(title, text);

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
        caption: styledText,
        footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
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

                let menuText = formatViralBox('BOT INFO', 
`• Name: ${userCfg.botName || config.BOT_NAME}
• Owner: ${config.OWNER_NAME}
• Version: ${config.BOT_VERSION}
• Uptime: ${hours}h ${minutes}m ${seconds}s`
                );

                menuText += '\n\n';
                menuText += formatViralBox('CATEGORIES', 
`.user
.owner
.group
.tools`
                );

                menuText += '\n\nUse .help for the full command list.';

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
                    footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
                    buttons: buttons,
                    headerType: 4
                }, { quoted: fakevcard });
                break;
            }

            case 'owner': {
                const ownerText = formatViralBox('OWNER INFO',
`• Name: Wesley
• Age: 19
• No: +263786624966
• Dev: Calyx Drey`
                );

                const oButtons = [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" }, type: 1 }];
                await socket.sendMessage(from, {
                     text: ownerText,
                     footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
                     buttons: oButtons,
                     headerType: 1
                }, { quoted: fakevcard });
                break;
            }

            case 'ping': {
                const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
                const number = socket.user.id.split(':')[0];
                const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
                const botName = userCfg.botName || 'Viral-Bot-Mini';

                const pingText = formatViralBox('SYSTEM STATUS',
`• Bot: ${botName}
• Latency: ${latency}ms
• Server Time: ${new Date().toLocaleString()}`
                );

                const img = userCfg.logo || config.FREE_IMAGE;
                let pImage;
                if (String(img).startsWith('http')) pImage = { url: img };
                else try { pImage = fs.readFileSync(img); } catch (e) { pImage = { url: config.FREE_IMAGE }; }
                
                const pButtons = [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" }, type: 1 }];

                await socket.sendMessage(from, {
                    image: pImage,
                    caption: pingText,
                    footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
                    buttons: pButtons,
                    headerType: 4
                }, { quoted: fakevcard });
                break;
            }

            case 'help': {
                let helpText = '';
                
                helpText += formatViralBox('USER COMMANDS',
`.menu
.help
.user
.info
.ping
.runtime
.id
.profile`
                );
                
                helpText += '\n\n';

                helpText += formatViralBox('TOOL COMMANDS',
`.sticker
.toimg
.toaudio
.calc
.qr
.reverse
.repeat
.count
.password
.vv`
                );

                helpText += '\n\n';

                helpText += formatViralBox('OWNER COMMANDS',
`.restart
.anticall
.setname
.setbio
.setpp
.broadcast
.ban
.unban
.block
.unblock
.logs
.stats`
                );

                helpText += '\n\n';

                helpText += formatViralBox('GROUP COMMANDS',
`.mute
.unmute
.setdesc
.gsetname
.lock
.unlock
.rules
.setrules
.welcome
.goodbye`
                );

                helpText += '\n\n';

                helpText += formatViralBox('SECURITY',
`.antilink
.antisticker
.antiaudio
.antiimg
.antivideo
.antivv
.antifile
.antigcall`
                );

                await sendReply(socket, from, helpText, ctx, { title: 'FULL COMMAND LIST' });
                break;
            }

            case 'user':
            case 'tools':
                const userCmds = 
`.sticker
.toimg
.toaudio
.calc
.qr
.password
.vv`;
                await sendReply(socket, from, userCmds, ctx, { title: 'USER & TOOLS' });
                break;

            case 'sticker':
            case 's':
                if (!/image|video|webp/.test(mime)) return sendReply(socket, from, 'Reply to an image or video.', ctx, { title: 'ERROR' });
                const sbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { sticker: sbuffer }, { quoted: fakevcard });
                break;

            case 'toimg':
                if (!/webp/.test(mime)) return sendReply(socket, from, 'Reply to a sticker.', ctx, { title: 'ERROR' });
                const wbuffer = await downloadMedia(qmsg);
                const toImgCap = formatViralBox('SUCCESS', 'Sticker converted to image.');
                await socket.sendMessage(from, { image: wbuffer, caption: toImgCap }, { quoted: fakevcard });
                break;

            case 'toaudio':
                if (!/video/.test(mime)) return sendReply(socket, from, 'Reply to a video.', ctx, { title: 'ERROR' });
                const vbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { audio: vbuffer, mimetype: 'audio/mp4', ptt: false }, { quoted: fakevcard });
                break;

            case 'calc':
                if (!text) return sendReply(socket, from, 'Provide a math expression.', ctx, { title: 'ERROR' });
                try {
                    const stripped = text.replace(/[^0-9+\-*/().]/g, '');
                    const result = eval(stripped);
                    const calcRes = `Input: ${stripped}\nResult: ${result}`;
                    await sendReply(socket, from, calcRes, ctx, { title: 'CALCULATOR' });
                } catch { await sendReply(socket, from, 'Invalid math expression.', ctx, { title: 'ERROR' }); }
                break;

            case 'qr':
                if (!text) return sendReply(socket, from, 'Provide text for the QR code.', ctx, { title: 'ERROR' });
                await socket.sendMessage(from, { 
                    image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, 
                    caption: formatViralBox('QR GENERATOR', `Text: ${text}`),
                    footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ' 
                }, { quoted: fakevcard });
                break;

            case 'reverse':
                if (!text) return sendReply(socket, from, 'Provide text to reverse.', ctx, { title: 'ERROR' });
                await sendReply(socket, from, text.split('').reverse().join(''), ctx, { title: 'REVERSE' });
                break;

            case 'repeat':
                if (!text) return sendReply(socket, from, 'Provide text to repeat.', ctx, { title: 'ERROR' });
                await sendReply(socket, from, text.repeat(3), ctx, { title: 'REPEAT' });
                break;

            case 'count':
                if (!text) return sendReply(socket, from, 'Provide text to count.', ctx, { title: 'ERROR' });
                const countRes = `Chars: ${text.length}\nWords: ${text.split(' ').length}\nLines: ${text.split('\n').length}`;
                await sendReply(socket, from, countRes, ctx, { title: 'WORD COUNT' });
                break;

            case 'password':
                const pwd = crypto.randomBytes(8).toString('hex');
                await sendReply(socket, from, `Generated: ${pwd}`, ctx, { title: 'PASSWORD GEN' });
                break;

            case 'info':
                 const infoRes = `Name: ${config.BOT_NAME}\nOwner: ${config.OWNER_NAME}\nNumber: ${config.OWNER_NUMBER}\nVersion: ${config.BOT_VERSION}`;
                 await sendReply(socket, from, infoRes, ctx, { title: 'BOT INFO' });
                 break;

            case 'runtime':
                 const upt2 = process.uptime();
                 const d2 = Math.floor(upt2 / (3600*24));
                 const h2 = Math.floor(upt2 % (3600*24) / 3600);
                 const m2 = Math.floor(upt2 % 3600 / 60);
                 const s2 = Math.floor(upt2 % 60);
                 await sendReply(socket, from, `${d2}d ${h2}h ${m2}m ${s2}s`, ctx, { title: 'RUNTIME' });
                 break;

            case 'id':
                 await sendReply(socket, from, `Chat: ${from}\nUser: ${sender}`, ctx, { title: 'ID INFO' });
                 break;

            case 'vv': // Get ViewOnce
                if (!quoted.message.viewOnceMessageV2 && !quoted.message.viewOnceMessage) return sendReply(socket, from, 'Reply to a ViewOnce message.', ctx, { title: 'ERROR' });
                const viewMedia = await downloadContentFromMessage(quoted.message.viewOnceMessageV2?.message?.imageMessage || quoted.message.viewOnceMessage?.message?.imageMessage || quoted.message.viewOnceMessageV2?.message?.videoMessage, quoted.message.viewOnceMessageV2?.message?.videoMessage ? 'video' : 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of viewMedia) buffer = Buffer.concat([buffer, chunk]);
                
                const cap = formatViralBox('SUCCESS', 'ViewOnce Recovered');
                if (quoted.message.viewOnceMessageV2?.message?.videoMessage) {
                    await socket.sendMessage(from, { video: buffer, caption: cap }, { quoted: fakevcard });
                } else {
                    await socket.sendMessage(from, { image: buffer, caption: cap }, { quoted: fakevcard });
                }
                break;

            // --- Owner ---
            case 'restart':
                if (!isOwner) return;
                await sendReply(socket, from, 'Restarting system...', ctx, { title: 'SYSTEM' });
                process.exit(1);
                break;

            case 'setname':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide a new name.', ctx, { title: 'ERROR' });
                await socket.updateProfileName(text);
                await sendReply(socket, from, 'Bot name updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'setbio':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide a new bio.', ctx, { title: 'ERROR' });
                await socket.updateProfileStatus(text);
                await sendReply(socket, from, 'Bio updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'ban':
                if (!isOwner) return;
                const banTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!banTarget) return sendReply(socket, from, 'Tag or reply to a user.', ctx, { title: 'ERROR' });
                bannedUsers.set(banTarget, true);
                await sendReply(socket, from, `Banned @${banTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [banTarget] });
                break;
            
            case 'unban':
                if (!isOwner) return;
                const unbanTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!unbanTarget) return sendReply(socket, from, 'Tag or reply to a user.', ctx, { title: 'ERROR' });
                bannedUsers.delete(unbanTarget);
                await sendReply(socket, from, `Unbanned @${unbanTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [unbanTarget] });
                break;

            case 'broadcast':
                if (!isOwner) return;
                if (!text) return sendReply(socket, from, 'Provide text to broadcast.', ctx, { title: 'ERROR' });
                const allNums = await mongo.getAllNumbersFromMongo();
                for (let n of allNums) {
                    await socket.sendMessage(n + '@s.whatsapp.net', { text: `*📢 BROADCAST*\n\n${text}` }).catch(()=>{});
                }
                await sendReply(socket, from, `Broadcast sent to ${allNums.length} users.`, ctx, { title: 'SUCCESS' });
                break;

            case 'logs':
                if (!isOwner) return;
                await sendReply(socket, from, commandLogs.join('\n') || 'No logs available.', ctx, { title: 'SYSTEM LOGS' });
                break;

            case 'stats':
                if (!isOwner) return;
                const count = ctx.store.activeSockets.size;
                const statsMsg = `Sessions: ${count}\nBanned: ${bannedUsers.size}\nUptime: ${process.uptime().toFixed(0)}s`;
                await sendReply(socket, from, statsMsg, ctx, { title: 'SYSTEM STATS' });
                break;

            // --- Group ---
            case 'mute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { muted: true });
                await sendReply(socket, from, 'Group muted. Only admins can speak.', ctx, { title: 'SUCCESS' });
                break;

            case 'unmute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { muted: false });
                await sendReply(socket, from, 'Group unmuted. Everyone can speak.', ctx, { title: 'SUCCESS' });
                break;

            case 'antilink':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const set = await mongo.getGroupSettings(from);
                const newVal = !set.anti.link;
                await mongo.updateGroupSettings(from, { 'anti.link': newVal });
                await sendReply(socket, from, `Anti-link is now ${newVal ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            default:
                break;
        }

    } catch (err) {
        console.error('Command handler error:', err);
        try { 
            const errorMsg = formatViralBox('SYSTEM ERROR', err.message);
            await socket.sendMessage(from, { text: errorMsg }); 
        } catch (e) { }
    }
};