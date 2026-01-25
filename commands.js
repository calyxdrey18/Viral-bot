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

// --- Helper: Send Text Only Reply ---
const sendTextReply = async (socket, from, text, ctx, options = {}) => {
    const title = options.title || 'BOT NOTICE';
    const styledText = formatViralBox(title, text);
    
    return socket.sendMessage(from, { 
        text: styledText,
        footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
        headerType: 1
    }, { quoted: options.quoted || fakevcard });
};

// --- Helper: Send Text Reply with Copy Button ---
const sendTextWithCopy = async (socket, from, text, ctx, options = {}) => {
    const title = options.title || 'RESULT';
    const styledText = formatViralBox(title, text);
    
    const buttons = [
        {
            buttonId: 'copy',
            buttonText: { displayText: "📋 ᴄᴏᴘʏ" },
            type: 2
        }
    ];
    
    return socket.sendMessage(from, { 
        text: styledText,
        footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
        buttons: buttons,
        headerType: 1
    }, { quoted: options.quoted || fakevcard });
};

// --- Helper: Send Category Menu (with image) ---
const sendCategoryMenu = async (socket, from, category, commands, ctx) => {
    const { config, mongo } = ctx;
    const number = socket.user.id.split(':')[0];
    const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
    
    const categoryText = formatViralBox(category.toUpperCase() + ' COMMANDS', commands);
    
    const img = userCfg.logo || config.FREE_IMAGE;
    let imagePayload;
    if (String(img).startsWith('http')) imagePayload = { url: img };
    else try { imagePayload = fs.readFileSync(img); } catch (e) { imagePayload = { url: config.FREE_IMAGE }; }
    
    const buttons = [
        { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
        { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
        { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 },
        { buttonId: `${config.PREFIX}groupmenu`, buttonText: { displayText: "👥 ɢʀᴏᴜᴘ" }, type: 1 }
    ];

    await socket.sendMessage(from, {
        image: imagePayload,
        caption: categoryText,
        footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
        buttons: buttons,
        headerType: 4
    }, { quoted: fakevcard });
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
                (settings.anti.video && type === 'videoMessage') ||
                (settings.anti.sticker && type === 'stickerMessage') ||
                (settings.anti.audio && type === 'audioMessage') ||
                (settings.anti.vv && type === 'viewOnceMessage') ||
                (settings.anti.file && type === 'documentMessage')) {
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
`• ɴᴀᴍᴇ: ${userCfg.botName || config.BOT_NAME}
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

                const img = userCfg.logo || config.FREE_IMAGE;
                let imagePayload;
                if (String(img).startsWith('http')) imagePayload = { url: img };
                else try { imagePayload = fs.readFileSync(img); } catch (e) { imagePayload = { url: config.FREE_IMAGE }; }

                const buttons = [
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 },
                    { buttonId: `${config.PREFIX}groupmenu`, buttonText: { displayText: "👥 ɢʀᴏᴜᴘ" }, type: 1 },
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
                     footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
                     buttons: buttons,
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
`• ʙᴏᴛ: ${botName}
• ʟᴀᴛᴇɴᴄʏ: ${latency}ms
• sᴇʀᴠᴇʀ ᴛɪᴍᴇ: ${new Date().toLocaleString()}`
                );

                const img = userCfg.logo || config.FREE_IMAGE;
                let pImage;
                if (String(img).startsWith('http')) pImage = { url: img };
                else try { pImage = fs.readFileSync(img); } catch (e) { pImage = { url: config.FREE_IMAGE }; }
                
                const buttons = [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 }
                ];

                await socket.sendMessage(from, {
                    image: pImage,
                    caption: pingText,
                    footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
                    buttons: buttons,
                    headerType: 4
                }, { quoted: fakevcard });
                break;
            }

            case 'help': {
                const number = socket.user.id.split(':')[0];
                const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
                
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

                const img = userCfg.logo || config.FREE_IMAGE;
                let imagePayload;
                if (String(img).startsWith('http')) imagePayload = { url: img };
                else try { imagePayload = fs.readFileSync(img); } catch (e) { imagePayload = { url: config.FREE_IMAGE }; }

                const buttons = [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 },
                    { buttonId: `${config.PREFIX}groupmenu`, buttonText: { displayText: "👥 ɢʀᴏᴜᴘ" }, type: 1 }
                ];

                await socket.sendMessage(from, {
                    image: imagePayload,
                    caption: helpText,
                    footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
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

            // --- User Commands ---
            case 'profile': {
                try {
                    const profile = await socket.profilePictureUrl(sender, 'image');
                    const profileText = formatViralBox('PROFILE INFO', `User: @${senderNumber}\nProfile picture retrieved.`);
                    await socket.sendMessage(from, {
                        image: { url: profile },
                        caption: profileText,
                        footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
                        mentions: [sender]
                    }, { quoted: fakevcard });
                } catch (e) {
                    await sendTextReply(socket, from, 'Could not retrieve profile picture.', ctx, { title: 'ERROR' });
                }
                break;
            }

            // --- Tool Commands ---
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
                    await sendTextWithCopy(socket, from, calcRes, ctx, { title: 'CALCULATOR' });
                } catch { await sendTextReply(socket, from, 'Invalid math expression.', ctx, { title: 'ERROR' }); }
                break;

            case 'qr':
                if (!text) return sendTextReply(socket, from, 'Provide text for the QR code.', ctx, { title: 'ERROR' });
                await socket.sendMessage(from, { 
                    image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, 
                    caption: formatViralBox('QR GENERATOR', `ᴛᴇxᴛ: ${text}`),
                    footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ' 
                }, { quoted: fakevcard });
                break;

            case 'reverse':
                if (!text) return sendTextReply(socket, from, 'Provide text to reverse.', ctx, { title: 'ERROR' });
                const reversedText = text.split('').reverse().join('');
                await sendTextWithCopy(socket, from, `ᴏʀɪɢɪɴᴀʟ: ${text}\nʀᴇᴠᴇʀsᴇᴅ: ${reversedText}`, ctx, { title: 'REVERSE' });
                break;

            case 'repeat':
                if (!text) return sendTextReply(socket, from, 'Provide text to repeat.', ctx, { title: 'ERROR' });
                const repeatedText = `${text}\n${text}\n${text}`;
                await sendTextWithCopy(socket, from, repeatedText, ctx, { title: 'REPEAT x3' });
                break;

            case 'count':
                if (!text) return sendTextReply(socket, from, 'Provide text to count.', ctx, { title: 'ERROR' });
                const countRes = `ᴄʜᴀʀᴀᴄᴛᴇʀs: ${text.length}\nᴡᴏʀᴅs: ${text.split(' ').length}\nʟɪɴᴇs: ${text.split('\n').length}`;
                await sendTextWithCopy(socket, from, countRes, ctx, { title: 'WORD COUNT' });
                break;

            case 'password':
                const pwd = crypto.randomBytes(8).toString('hex');
                await sendTextWithCopy(socket, from, `ɢᴇɴᴇʀᴀᴛᴇᴅ: ${pwd}`, ctx, { title: 'PASSWORD GEN' });
                break;

            case 'info':
                 const number = socket.user.id.split(':')[0];
                 const userCfg = await mongo.loadUserConfigFromMongo(number) || {};
                 const infoRes = `ɴᴀᴍᴇ: ${userCfg.botName || config.BOT_NAME}\nᴏᴡɴᴇʀ: ${config.OWNER_NAME}\nɴᴜᴍʙᴇʀ: ${config.OWNER_NUMBER}\nᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}`;
                 
                 const img = userCfg.logo || config.FREE_IMAGE;
                 let infoImage;
                 if (String(img).startsWith('http')) infoImage = { url: img };
                 else try { infoImage = fs.readFileSync(img); } catch (e) { infoImage = { url: config.FREE_IMAGE }; }
                 
                 const buttons = [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "🏠 ᴍᴇɴᴜ" }, type: 1 },
                    { buttonId: `${config.PREFIX}usermenu`, buttonText: { displayText: "👤 ᴜsᴇʀ" }, type: 1 },
                    { buttonId: `${config.PREFIX}toolsmenu`, buttonText: { displayText: "🛠️ ᴛᴏᴏʟs" }, type: 1 }
                 ];
                 
                 await socket.sendMessage(from, {
                     image: infoImage,
                     caption: formatViralBox('BOT INFO', infoRes),
                     footer: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
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
                 await sendTextWithCopy(socket, from, runtimeText, ctx, { title: 'SYSTEM RUNTIME' });
                 break;

            case 'id':
                 const idText = `ᴄʜᴀᴛ ɪᴅ: ${from}\nᴜsᴇʀ ɪᴅ: ${sender}`;
                 await sendTextWithCopy(socket, from, idText, ctx, { title: 'ID INFO' });
                 break;

            case 'vv': // Get ViewOnce
                if (!quoted.message.viewOnceMessageV2 && !quoted.message.viewOnceMessage) return sendTextReply(socket, from, 'Reply to a ViewOnce message.', ctx, { title: 'ERROR' });
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

            // --- Owner Commands ---
            case 'restart':
                if (!isOwner) return;
                await sendTextReply(socket, from, 'Restarting system...', ctx, { title: 'SYSTEM' });
                process.exit(1);
                break;

            case 'anticall':
                if (!isOwner) return;
                const anticallStatus = callBlockers.has(socket.user.id) ? 'OFF' : 'ON';
                if (callBlockers.has(socket.user.id)) {
                    callBlockers.delete(socket.user.id);
                } else {
                    callBlockers.set(socket.user.id, true);
                }
                await sendTextReply(socket, from, `Anti-call is now ${anticallStatus}`, ctx, { title: 'SECURITY' });
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

            case 'setpp':
                if (!isOwner) return;
                if (!/image/.test(mime)) return sendTextReply(socket, from, 'Reply to an image.', ctx, { title: 'ERROR' });
                const ppbuffer = await downloadMedia(qmsg);
                await socket.updateProfilePicture(socket.user.id, ppbuffer);
                await sendTextReply(socket, from, 'Profile picture updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'ban':
                if (!isOwner) return;
                const banTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!banTarget) return sendTextReply(socket, from, 'Tag or reply to a user.', ctx, { title: 'ERROR' });
                bannedUsers.set(banTarget, true);
                await sendTextReply(socket, from, `Banned @${banTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [banTarget] });
                break;
            
            case 'unban':
                if (!isOwner) return;
                const unbanTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null);
                if (!unbanTarget) return sendTextReply(socket, from, 'Tag or reply to a user.', ctx, { title: 'ERROR' });
                bannedUsers.delete(unbanTarget);
                await sendTextReply(socket, from, `Unbanned @${unbanTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [unbanTarget] });
                break;

            case 'block':
                if (!isOwner) return;
                const blockTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null) || (text.includes('@') ? text : `${text}@s.whatsapp.net`);
                if (!blockTarget) return sendTextReply(socket, from, 'Tag, reply or provide number.', ctx, { title: 'ERROR' });
                await socket.updateBlockStatus(blockTarget, 'block');
                await sendTextReply(socket, from, `Blocked @${blockTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [blockTarget] });
                break;

            case 'unblock':
                if (!isOwner) return;
                const unblockTarget = msg.mentionedJid?.[0] || (msg.quoted ? msg.quoted.participant : null) || (text.includes('@') ? text : `${text}@s.whatsapp.net`);
                if (!unblockTarget) return sendTextReply(socket, from, 'Tag, reply or provide number.', ctx, { title: 'ERROR' });
                await socket.updateBlockStatus(unblockTarget, 'unblock');
                await sendTextReply(socket, from, `Unblocked @${unblockTarget.split('@')[0]}`, ctx, { title: 'SUCCESS', mentions: [unblockTarget] });
                break;

            case 'broadcast':
                if (!isOwner) return;
                if (!text) return sendTextReply(socket, from, 'Provide text to broadcast.', ctx, { title: 'ERROR' });
                const allNums = await mongo.getAllNumbersFromMongo();
                for (let n of allNums) {
                    await socket.sendMessage(n + '@s.whatsapp.net', { text: `╭─📂 𝗕𝗢𝗟𝗗 𝗕𝗥𝗢𝗔𝗗𝗖𝗔𝗦𝗧 𝗕𝗢𝗟𝗗\n│ ${text}\n╰──────────￫\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ` }).catch(()=>{});
                }
                await sendTextReply(socket, from, `Broadcast sent to ${allNums.length} users.`, ctx, { title: 'SUCCESS' });
                break;

            case 'logs':
                if (!isOwner) return;
                const logsText = commandLogs.join('\n') || 'No logs available.';
                await sendTextReply(socket, from, logsText, ctx, { title: 'SYSTEM LOGS' });
                break;

            case 'stats':
                if (!isOwner) return;
                const count = ctx.store.activeSockets.size;
                const statsMsg = `sᴇssɪᴏɴs: ${count}\nʙᴀɴɴᴇᴅ: ${bannedUsers.size}\nᴜᴘᴛɪᴍᴇ: ${process.uptime().toFixed(0)}s`;
                await sendTextReply(socket, from, statsMsg, ctx, { title: 'SYSTEM STATS' });
                break;

            // --- Group Commands ---
            case 'mute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { muted: true });
                await sendTextReply(socket, from, 'Group muted. Only admins can speak.', ctx, { title: 'SUCCESS' });
                break;

            case 'unmute':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { muted: false });
                await sendTextReply(socket, from, 'Group unmuted. Everyone can speak.', ctx, { title: 'SUCCESS' });
                break;

            case 'setdesc':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide description text.', ctx, { title: 'ERROR' });
                await socket.groupUpdateDescription(from, text);
                await sendTextReply(socket, from, 'Group description updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'gsetname':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide new group name.', ctx, { title: 'ERROR' });
                await socket.groupUpdateSubject(from, text);
                await sendTextReply(socket, from, 'Group name updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'lock':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { 
                    'anti.link': true,
                    'anti.sticker': true,
                    'anti.audio': true,
                    'anti.image': true,
                    'anti.video': true,
                    'anti.vv': true,
                    'anti.file': true
                });
                await sendTextReply(socket, from, 'Group security locked. All anti-features enabled.', ctx, { title: 'SECURITY' });
                break;

            case 'unlock':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { 
                    'anti.link': false,
                    'anti.sticker': false,
                    'anti.audio': false,
                    'anti.image': false,
                    'anti.video': false,
                    'anti.vv': false,
                    'anti.file': false
                });
                await sendTextReply(socket, from, 'Group security unlocked. All anti-features disabled.', ctx, { title: 'SECURITY' });
                break;

            case 'rules':
                if (!isGroup) return;
                const groupSettings = await mongo.getGroupSettings(from);
                const rules = groupSettings.rules || 'No rules set yet. Use .setrules to add rules.';
                await sendTextReply(socket, from, rules, ctx, { title: 'GROUP RULES' });
                break;

            case 'setrules':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                if (!text) return sendTextReply(socket, from, 'Provide rules text.', ctx, { title: 'ERROR' });
                await mongo.updateGroupSettings(from, { rules: text });
                await sendTextReply(socket, from, 'Group rules updated.', ctx, { title: 'SUCCESS' });
                break;

            case 'welcome':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const welcomeStatus = !text ? 'Usage: .welcome on/off' : text;
                if (welcomeStatus === 'on') {
                    await mongo.updateGroupSettings(from, { welcome: true });
                    await sendTextReply(socket, from, 'Welcome messages enabled.', ctx, { title: 'SUCCESS' });
                } else if (welcomeStatus === 'off') {
                    await mongo.updateGroupSettings(from, { welcome: false });
                    await sendTextReply(socket, from, 'Welcome messages disabled.', ctx, { title: 'SUCCESS' });
                } else {
                    const settings = await mongo.getGroupSettings(from);
                    await sendTextReply(socket, from, `Welcome is ${settings.welcome ? 'ENABLED' : 'DISABLED'}. Use .welcome on/off`, ctx, { title: 'WELCOME' });
                }
                break;

            case 'goodbye':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const goodbyeStatus = !text ? 'Usage: .goodbye on/off' : text;
                if (goodbyeStatus === 'on') {
                    await mongo.updateGroupSettings(from, { goodbye: true });
                    await sendTextReply(socket, from, 'Goodbye messages enabled.', ctx, { title: 'SUCCESS' });
                } else if (goodbyeStatus === 'off') {
                    await mongo.updateGroupSettings(from, { goodbye: false });
                    await sendTextReply(socket, from, 'Goodbye messages disabled.', ctx, { title: 'SUCCESS' });
                } else {
                    const settings = await mongo.getGroupSettings(from);
                    await sendTextReply(socket, from, `Goodbye is ${settings.goodbye ? 'ENABLED' : 'DISABLED'}. Use .goodbye on/off`, ctx, { title: 'GOODBYE' });
                }
                break;

            case 'antilink':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const set = await mongo.getGroupSettings(from);
                const newVal = !set.anti.link;
                await mongo.updateGroupSettings(from, { 'anti.link': newVal });
                await sendTextReply(socket, from, `Anti-link is now ${newVal ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'antisticker':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const setSticker = await mongo.getGroupSettings(from);
                const newValSticker = !setSticker.anti.sticker;
                await mongo.updateGroupSettings(from, { 'anti.sticker': newValSticker });
                await sendTextReply(socket, from, `Anti-sticker is now ${newValSticker ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'antiaudio':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const setAudio = await mongo.getGroupSettings(from);
                const newValAudio = !setAudio.anti.audio;
                await mongo.updateGroupSettings(from, { 'anti.audio': newValAudio });
                await sendTextReply(socket, from, `Anti-audio is now ${newValAudio ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'antiimg':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const setImg = await mongo.getGroupSettings(from);
                const newValImg = !setImg.anti.image;
                await mongo.updateGroupSettings(from, { 'anti.image': newValImg });
                await sendTextReply(socket, from, `Anti-image is now ${newValImg ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'antivideo':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const setVideo = await mongo.getGroupSettings(from);
                const newValVideo = !setVideo.anti.video;
                await mongo.updateGroupSettings(from, { 'anti.video': newValVideo });
                await sendTextReply(socket, from, `Anti-video is now ${newValVideo ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'antivv':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const setVv = await mongo.getGroupSettings(from);
                const newValVv = !setVv.anti.vv;
                await mongo.updateGroupSettings(from, { 'anti.vv': newValVv });
                await sendTextReply(socket, from, `Anti-viewonce is now ${newValVv ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'antifile':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const setFile = await mongo.getGroupSettings(from);
                const newValFile = !setFile.anti.file;
                await mongo.updateGroupSettings(from, { 'anti.file': newValFile });
                await sendTextReply(socket, from, `Anti-file is now ${newValFile ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
                break;

            case 'antigcall':
                if (!isGroup) return;
                if (!await mongo.isGroupAdmin(socket, from, sender)) return sendTextReply(socket, from, 'Admins only.', ctx, { title: 'ERROR' });
                const setGcall = await mongo.getGroupSettings(from);
                const newValGcall = !setGcall.anti.gcall;
                await mongo.updateGroupSettings(from, { 'anti.gcall': newValGcall });
                await sendTextReply(socket, from, `Anti-group-call is now ${newValGcall ? 'ENABLED' : 'DISABLED'}`, ctx, { title: 'SECURITY' });
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
