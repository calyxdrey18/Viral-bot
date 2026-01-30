const { 
    getContentType, 
    downloadContentFromMessage,
    downloadContentFromMessage: downloadMediaContent
} = require('baileys');
const fs = require('fs-extra');
const crypto = require('crypto');

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
        const stream = await downloadMediaContent(msg[type], type.replace('Message', ''));
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (e) { 
        console.error('Download media error:', e);
        return null; 
    }
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
    const { config } = ctx;
    
    // Apply Viral Formatting
    const title = options.title || 'BOT NOTICE';
    const styledText = formatViralBox(title, text);

    let imagePayload;
    if (String(config.FREE_IMAGE).startsWith('http')) {
        imagePayload = { url: config.FREE_IMAGE };
    } else {
        try { 
            imagePayload = fs.readFileSync(config.FREE_IMAGE); 
        } catch (e) { 
            imagePayload = { url: config.FREE_IMAGE }; 
        }
    }

    return socket.sendMessage(from, { 
        image: imagePayload,
        caption: styledText,
        footer: config.BOT_FOOTER,
        headerType: 4
    }, { quoted: options.quoted || fakevcard });
};

// --- Helper: Send Text Only Reply ---
const sendTextReply = async (socket, from, text, ctx, options = {}) => {
    const { config } = ctx;
    const title = options.title || 'BOT NOTICE';
    const styledText = formatViralBox(title, text);
    
    return socket.sendMessage(from, { 
        text: styledText,
        footer: config.BOT_FOOTER,
        headerType: 1
    }, { quoted: options.quoted || fakevcard });
};

// --- Helper: Send Category Menu (with image) ---
const sendCategoryMenu = async (socket, from, category, commands, ctx) => {
    const { config } = ctx;
    
    const categoryText = formatViralBox(category.toUpperCase() + ' COMMANDS', commands);
    
    let imagePayload;
    if (String(config.FREE_IMAGE).startsWith('http')) imagePayload = { url: config.FREE_IMAGE };
    else try { imagePayload = fs.readFileSync(config.FREE_IMAGE); } catch (e) { imagePayload = { url: config.FREE_IMAGE }; }
    
    const buttons = [
        { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
        { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
        { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 },
        { buttonId: `${config.PREFIX}groupmenu`, buttonText: { displayText: "👥 ɢʀᴏᴜᴘ" }, type: 1 }
    ];

    await socket.sendMessage(from, {
        image: imagePayload,
        caption: categoryText,
        footer: config.BOT_FOOTER,
        buttons: buttons,
        headerType: 4
    }, { quoted: fakevcard });
};

// Simple in-memory storage
class SimpleStorage {
    constructor() {
        this.bannedUsers = new Set();
        this.callBlockers = new Set();
        this.commandLogs = [];
        this.activeSockets = new Map();
        this.groupSettings = new Map();
        this.socketCreationTime = new Map();
    }

    // Group settings management
    getGroupSettings(groupId) {
        if (!this.groupSettings.has(groupId)) {
            this.groupSettings.set(groupId, {
                muted: false,
                anti: {
                    link: false,
                    image: false,
                    video: false,
                    audio: false,
                    sticker: false,
                    vv: false,
                    file: false,
                    gcall: false
                },
                welcome: '',
                goodbye: '',
                rules: ''
            });
        }
        return this.groupSettings.get(groupId);
    }

    updateGroupSettings(groupId, updates) {
        const current = this.getGroupSettings(groupId);
        this.groupSettings.set(groupId, { ...current, ...updates });
    }
}

// Group admin check functions
async function isGroupAdmin(socket, groupId, userId) {
    try {
        const metadata = await socket.groupMetadata(groupId);
        const participants = metadata.participants || [];
        const user = participants.find(p => p.id === userId);
        return user ? (user.admin === 'admin' || user.admin === 'superadmin') : false;
    } catch (error) {
        console.error('Admin check error:', error);
        return false;
    }
}

async function isBotAdmin(socket, groupId) {
    try {
        const botId = socket.user.id;
        return await isGroupAdmin(socket, groupId, botId);
    } catch (error) {
        return false;
    }
}

/**
 * Main Command Handler Function
 */
module.exports = async function handleCommand(socket, msg, ctx) {
    const { config } = ctx;
    const store = new SimpleStorage();
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
        const timestamp = new Date().toLocaleTimeString();
        const logEntry = `[${timestamp}] CMD: ${command} FROM: ${senderNumber} IN: ${isGroup ? 'Group' : 'DM'}`;
        console.log(logEntry);
        commandLogs.push(logEntry);
        if (commandLogs.length > 15) commandLogs.shift();
    }

    // --- CHECKS ---
    if (bannedUsers.has(sender)) return;

    // Group Settings Checks
    if (isGroup) {
        const settings = store.getGroupSettings(from);
        const isAd = await isGroupAdmin(socket, from, sender);
        const isBotAd = await isBotAdmin(socket, from);

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
                
                const startTime = socketCreationTime.get(number) || Date.now();
                const uptime = Math.floor((Date.now() - startTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = Math.floor(uptime % 60);

                let menuText = formatViralBox('BOT INFO', 
`• ɴᴀᴍᴇ: ${config.BOT_NAME}
• ᴏᴡɴᴇʀ: ${config.OWNER_NAME}
• ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}
• ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s`
                );

                menuText += '\n\n';
                menuText += formatViralBox('AVAILABLE CATEGORIES', 
`👤 ᴜsᴇʀ ᴄᴏᴍᴍᴀɴᴅs
🛠️ ᴛᴏᴏʟs ᴄᴏᴍᴍᴀɴᴅs
👥 ɢʀᴏᴜᴘ ᴄᴏᴍᴍᴀɴᴅs
👑 ᴏᴡɴᴇʀ ᴄᴏᴍᴍᴀɴᴅs`
                );

                menuText += '\n\nᴜsᴇ ʙᴜᴛᴛᴏɴs ʙᴇʟᴏᴡ ᴛᴏ ɴᴀᴠɪɢᴀᴛᴇ';

                let imagePayload;
                if (String(config.FREE_IMAGE).startsWith('http')) imagePayload = { url: config.FREE_IMAGE };
                else try { imagePayload = fs.readFileSync(config.FREE_IMAGE); } catch (e) { imagePayload = { url: config.FREE_IMAGE }; }

                const buttons = [
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 },
                    { buttonId: `${config.PREFIX}groupmenu`, buttonText: { displayText: "👥 ɢʀᴏᴜᴘ" }, type: 1 },
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

            case 'usermenu': {
                await sendCategoryMenu(socket, from, 'USER',
`.menu
.help
.info
.ping
.runtime
.id
.profile
.user
.owner`, ctx);
                break;
            }

            case 'toolsmenu': {
                await sendCategoryMenu(socket, from, 'TOOLS',
`.sticker
.toimg
.toaudio
.calc
.qr
.reverse
.repeat
.count
.password
.vv`, ctx);
                break;
            }

            case 'groupmenu': {
                await sendCategoryMenu(socket, from, 'GROUP',
`.mute
.unmute
.setdesc
.gsetname
.lock
.unlock
.rules
.setrules
.welcome
.goodbye
.antilink
.antisticker
.antiaudio
.antiimg
.antivideo
.antivv
.antifile
.antigcall`, ctx);
                break;
            }

            case 'owner': {
                const ownerText = formatViralBox('OWNER INFO',
`• ɴᴀᴍᴇ: Wesley
• ᴀɢᴇ: 19
• ɴᴜᴍʙᴇʀ: +263786624966
• ᴅᴇᴠᴇʟᴏᴘᴇʀ: Calyx Drey`
                );

                const buttons = [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 },
                    { buttonId: `${config.PREFIX}groupmenu`, buttonText: { displayText: "👥 ɢʀᴏᴜᴘ" }, type: 1 }
                ];
                
                await socket.sendMessage(from, {
                     text: ownerText,
                     footer: config.BOT_FOOTER,
                     buttons: buttons,
                     headerType: 1
                }, { quoted: fakevcard });
                break;
            }

            case 'ping': {
                const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());

                const pingText = formatViralBox('SYSTEM STATUS',
`• ʙᴏᴛ: ${config.BOT_NAME}
• ʟᴀᴛᴇɴᴄʏ: ${latency}ms
• sᴇʀᴠᴇʀ ᴛɪᴍᴇ: ${new Date().toLocaleString()}`
                );

                let pImage;
                if (String(config.FREE_IMAGE).startsWith('http')) pImage = { url: config.FREE_IMAGE };
                else try { pImage = fs.readFileSync(config.FREE_IMAGE); } catch (e) { pImage = { url: config.FREE_IMAGE }; }
                
                const buttons = [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 }
                ];

                await socket.sendMessage(from, {
                    image: pImage,
                    caption: pingText,
                    footer: config.BOT_FOOTER,
                    buttons: buttons,
                    headerType: 4
                }, { quoted: fakevcard });
                break;
            }

            case 'help': {
                let helpText = '';
                
                helpText += formatViralBox('USER COMMANDS',
`.menu
.help
.info
.ping
.runtime
.id
.profile
.user
.owner`
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
.goodbye
.antilink
.antisticker
.antiaudio
.antiimg
.antivideo
.antivv
.antifile
.antigcall`
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

                let imagePayload;
                if (String(config.FREE_IMAGE).startsWith('http')) imagePayload = { url: config.FREE_IMAGE };
                else try { imagePayload = fs.readFileSync(config.FREE_IMAGE); } catch (e) { imagePayload = { url: config.FREE_IMAGE }; }

                const buttons = [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 },
                    { buttonId: `${config.PREFIX}groupmenu`, buttonText: { displayText: "👥 ɢʀᴏᴜᴘ" }, type: 1 }
                ];

                await socket.sendMessage(from, {
                    image: imagePayload,
                    caption: helpText,
                    footer: config.BOT_FOOTER,
                    buttons: buttons,
                    headerType: 4
                }, { quoted: fakevcard });
                break;
            }

            case 'user':
                await sendCategoryMenu(socket, from, 'USER',
`.menu
.help
.info
.ping
.runtime
.id
.profile
.user
.owner`, ctx);
                break;

            case 'tools':
                await sendCategoryMenu(socket, from, 'TOOLS',
`.sticker
.toimg
.toaudio
.calc
.qr
.reverse
.repeat
.count
.password
.vv`, ctx);
                break;

            case 'sticker':
            case 's':
                if (!/image|video|webp/.test(mime)) return sendTextReply(socket, from, 'Reply to an image or video.', ctx, { title: 'ERROR' });
                const sbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { sticker: sbuffer }, { quoted: fakevcard });
                break;

            case 'toimg':
                if (!/webp/.test(mime)) return sendTextReply(socket, from, 'Reply to a sticker.', ctx, { title: 'ERROR' });
                const wbuffer = await downloadMedia(qmsg);
                const toImgCap = formatViralBox('SUCCESS', 'Sticker converted to image.');
                await socket.sendMessage(from, { image: wbuffer, caption: toImgCap }, { quoted: fakevcard });
                break;

            case 'toaudio':
                if (!/video/.test(mime)) return sendTextReply(socket, from, 'Reply to a video.', ctx, { title: 'ERROR' });
                const vbuffer = await downloadMedia(qmsg);
                await socket.sendMessage(from, { audio: vbuffer, mimetype: 'audio/mp4', ptt: false }, { quoted: fakevcard });
                break;

            case 'calc':
                if (!text) return sendTextReply(socket, from, 'Provide a math expression.', ctx, { title: 'ERROR' });
                try {
                    const stripped = text.replace(/[^0-9+\-*/().]/g, '');
                    const result = eval(stripped);
                    const calcRes = `ɪɴᴘᴜᴛ: ${stripped}\nʀᴇsᴜʟᴛ: ${result}`;
                    await sendTextReply(socket, from, calcRes, ctx, { title: 'CALCULATOR' });
                } catch { await sendTextReply(socket, from, 'Invalid math expression.', ctx, { title: 'ERROR' }); }
                break;

            case 'qr':
                if (!text) return sendTextReply(socket, from, 'Provide text for the QR code.', ctx, { title: 'ERROR' });
                await socket.sendMessage(from, { 
                    image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, 
                    caption: formatViralBox('QR GENERATOR', `ᴛᴇxᴛ: ${text}`),
                    footer: config.BOT_FOOTER
                }, { quoted: fakevcard });
                break;

            case 'reverse':
                if (!text) return sendTextReply(socket, from, 'Provide text to reverse.', ctx, { title: 'ERROR' });
                const reversedText = text.split('').reverse().join('');
                await sendTextReply(socket, from, `ᴏʀɪɢɪɴᴀʟ: ${text}\nʀᴇᴠᴇʀsᴇᴅ: ${reversedText}`, ctx, { title: 'REVERSE' });
                break;

            case 'repeat':
                if (!text) return sendTextReply(socket, from, 'Provide text to repeat.', ctx, { title: 'ERROR' });
                const repeatedText = `${text}\n${text}\n${text}`;
                await sendTextReply(socket, from, repeatedText, ctx, { title: 'REPEAT x3' });
                break;

            case 'count':
                if (!text) return sendTextReply(socket, from, 'Provide text to count.', ctx, { title: 'ERROR' });
                const countRes = `ᴄʜᴀʀᴀᴄᴛᴇʀs: ${text.length}\nᴡᴏʀᴅs: ${text.split(' ').length}\nʟɪɴᴇs: ${text.split('\n').length}`;
                await sendTextReply(socket, from, countRes, ctx, { title: 'WORD COUNT' });
                break;

            case 'password':
                const pwd = crypto.randomBytes(8).toString('hex');
                await sendTextReply(socket, from, `ɢᴇɴᴇʀᴀᴛᴇᴅ: ${pwd}`, ctx, { title: 'PASSWORD GEN' });
                break;

            case 'info':
                 const infoRes = `ɴᴀᴍᴇ: ${config.BOT_NAME}\nᴏᴡɴᴇʀ: ${config.OWNER_NAME}\nɴᴜᴍʙᴇʀ: ${config.OWNER_NUMBER}\nᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}`;
                 
                 let infoImage;
                 if (String(config.FREE_IMAGE).startsWith('http')) infoImage = { url: config.FREE_IMAGE };
                 else try { infoImage = fs.readFileSync(config.FREE_IMAGE); } catch (e) { infoImage = { url: config.FREE_IMAGE }; }
                 
                 const buttons = [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 }
                 ];
                 
                 await socket.sendMessage(from, {
                     image: infoImage,
                     caption: formatViralBox('BOT INFO', infoRes),
                     footer: config.BOT_FOOTER,
                     buttons: buttons,
                     headerType: 4
                 }, { quoted: fakevcard });
                 break;

            case 'runtime':
                 const upt2 = process.uptime();
                 const d2 = Math.floor(upt2 / (3600*24));
                 const h2 = Math.floor(upt2 % (3600*24) / 3600);
                 const m2 = Math.floor(upt2 % 3600 / 60);
                 const s2 = Math.floor(upt2 % 60);
                 const runtimeText = `${d2}d ${h2}h ${m2}m ${s2}s`;
                 await sendTextReply(socket, from, runtimeText, ctx, { title: 'SYSTEM RUNTIME' });
                 break;

            case 'id':
                 const idText = `ᴄʜᴀᴛ ɪᴅ: ${from}\nᴜsᴇʀ ɪᴅ: ${sender}`;
                 await sendTextReply(socket, from, idText, ctx, { title: 'ID INFO' });
                 break;

            case 'vv': // Get ViewOnce
                if (!quoted.message.viewOnceMessageV2 && !quoted.message.viewOnceMessage) return sendTextReply(socket, from, 'Reply to a ViewOnce message.', ctx, { title: 'ERROR' });
                const viewMedia = await downloadMediaContent(quoted.message.viewOnceMessageV2?.message?.imageMessage || quoted.message.viewOnceMessage?.message?.imageMessage || quoted.message.viewOnceMessageV2?.message?.videoMessage, quoted.message.viewOnceMessageV2?.message?.videoMessage ? 'video' : 'image');
                let buffer = Buffer.from([]);
                for await (const chunk of viewMedia) buffer = Buffer.concat([buffer, chunk]);
                
                const cap = formatViralBox('SUCCESS', 'ViewOnce Recovered');
                if (quoted.message.viewOnceMessageV2?.message?.videoMessage) {
                    await socket.sendMessage(from, { video: buffer, caption: cap }, { quoted: fakevcard });
                } else {
                    await socket.sendMessage(from, { image: buffer, caption: cap }, { quoted: fakevcard });
                }
                break;

            // --- Owner Commands ---
            case 'restart':
                if (!isOwner) return;
                await sendTextReply(socket, from, 'Restarting system...', ctx, { title: 'SYSTEM' });
                process.exit(1);
                break;

            case 'setname':
                if (!isOwner) return;
                if (!text) return sendTextReply(socket, from, 'Provide a new name.', ctx, { title: 'ERROR' });
                await socket.updateProfileName(text);
                await sendTextReply(socket, from, 'Bot name updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'setbio':
                if (!isOwner) return;
                if (!text) return sendTextReply(socket, from, 'Provide a new bio.', ctx, { title: 'ERROR' });
                await socket.updateProfileStatus(text);
                await sendTextReply(socket, from, 'Bio updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'ban':
                if (!isOwner) return;
                const banTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!banTarget) return sendTextReply(socket, from, 'Tag or reply to a user.', ctx, { title: 'ERROR' });
                bannedUsers.add(banTarget);
                await sendTextReply(socket, from, `Banned @${banTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [banTarget] });
                break;
            
            case 'unban':
                if (!isOwner) return;
                const unbanTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!unbanTarget) return sendTextReply(socket, from, 'Tag or reply to a user.', ctx, { title: 'ERROR' });
                bannedUsers.delete(unbanTarget);
                await sendTextReply(socket, from, `Unbanned @${unbanTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [unbanTarget] });
                break;

            case 'broadcast':
                if (!isOwner) return;
                if (!text) return sendTextReply(socket, from, 'Provide text to broadcast.', ctx, { title: 'ERROR' });
                // Note: Without DB, broadcast can only send to current chat
                await sendTextReply(socket, from, 'Broadcast feature requires database. Sending to current chat only.', ctx, { title: 'INFO' });
                await socket.sendMessage(from, { 
                    text: `╭─📂 𝗕𝗢𝗟𝗗 𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧 𝗕𝗢𝗟𝗗\n│ ${text}\n╰──────────￫\n${config.BOT_FOOTER}`
                });
                break;

            case 'logs':
                if (!isOwner) return;
                const logsText = commandLogs.join('\n') || 'No logs available.';
                await sendTextReply(socket, from, logsText, ctx, { title: 'SYSTEM LOGS' });
                break;

            case 'stats':
                if (!isOwner) return;
                const count = 1; // Single socket
                const statsMsg = `sᴇssɪᴏɴs: ${count}\nʙᴀɴɴᴇᴅ: ${bannedUsers.size}\nᴜᴘᴛɪᴍᴇ: ${process.uptime().toFixed(0)}s`;
                await sendTextReply(socket, from, statsMsg, ctx, { title: 'SYSTEM STATS' });
                break;

            // --- Group Commands ---
            case 'mute':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                store.updateGroupSettings(from, { muted: true });
                await sendTextReply(socket, from, 'Group muted. Only admins can speak.', ctx, { title: 'SUCCESS' });
                break;

            case 'unmute':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                store.updateGroupSettings(from, { muted: false });
                await sendTextReply(socket, from, 'Group unmuted. Everyone can speak.', ctx, { title: 'SUCCESS' });
                break;

            case 'antilink':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const set = store.getGroupSettings(from);
                const newVal = !set.anti.link;
                store.updateGroupSettings(from, { 'anti.link': newVal });
                await sendTextReply(socket, from, `Anti-link is now ${newVal ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'setdesc':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide description text.', ctx, { title: 'ERROR' });
                await socket.groupUpdateDescription(from, text);
                await sendTextReply(socket, from, 'Group description updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'gsetname':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide new group name.', ctx, { title: 'ERROR' });
                await socket.groupUpdateSubject(from, text);
                await sendTextReply(socket, from, 'Group name updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'welcome':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide welcome message.', ctx, { title: 'ERROR' });
                store.updateGroupSettings(from, { welcome: text });
                await sendTextReply(socket, from, 'Welcome message set.', ctx, { title: 'SUCCESS' });
                break;

            case 'goodbye':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide goodbye message.', ctx, { title: 'ERROR' });
                store.updateGroupSettings(from, { goodbye: text });
                await sendTextReply(socket, from, 'Goodbye message set.', ctx, { title: 'SUCCESS' });
                break;

            case 'rules':
                if (!isGroup) return;
                const rules = store.getGroupSettings(from).rules;
                if (!rules) return sendTextReply(socket, from, 'No rules set yet.', ctx, { title: 'INFO' });
                await sendTextReply(socket, from, `📜 ɢʀᴏᴜᴘ ʀᴜʟᴇs:\n${rules}`, ctx, { title: 'RULES' });
                break;

            case 'setrules':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide rules text.', ctx, { title: 'ERROR' });
                store.updateGroupSettings(from, { rules: text });
                await sendTextReply(socket, from, 'Group rules updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'lock':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                // Enable all anti-features
                store.updateGroupSettings(from, {
                    'anti.link': true,
                    'anti.image': true,
                    'anti.video': true,
                    'anti.audio': true,
                    'anti.sticker': true,
                    'anti.vv': true,
                    'anti.file': true,
                    'anti.gcall': true,
                    muted: true
                });
                await sendTextReply(socket, from, 'Group locked. All restrictions enabled.', ctx, { title: 'SECURITY' });
                break;

            case 'unlock':
                if (!isGroup) return;
                if (!await isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                // Disable all anti-features
                store.updateGroupSettings(from, {
                    'anti.link': false,
                    'anti.image': false,
                    'anti.video': false,
                    'anti.audio': false,
                    'anti.sticker': false,
                    'anti.vv': false,
                    'anti.file': false,
                    'anti.gcall': false,
                    muted: false
                });
                await sendTextReply(socket, from, 'Group unlocked. All restrictions disabled.', ctx, { title: 'SECURITY' });
                break;

            case 'profile':
                try {
                    const profile = await socket.profilePictureUrl(sender, 'image');
                    await socket.sendMessage(from, { 
                        image: { url: profile },
                        caption: formatViralBox('PROFILE', `User: @${senderNumber}`),
                        footer: config.BOT_FOOTER
                    }, { mentions: [sender] });
                } catch (e) {
                    await sendTextReply(socket, from, 'No profile picture found.', ctx, { title: 'INFO' });
                }
                break;

            default:
                // Unknown command
                if (isCmd) {
                    await sendTextReply(socket, from, `Command "${command}" not found. Use ${prefix}help for commands list.`, ctx, { title: 'ERROR' });
                }
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