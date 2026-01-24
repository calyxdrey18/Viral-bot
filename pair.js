
const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FileType = require('file-type');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const util = require('util');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  downloadContentFromMessage,
  DisconnectReason,
  proto
} = require('baileys');

// ---------------- CONFIG ----------------
const BOT_NAME_FREE = 'Viral-Bot-Mini';

const config = {
  AUTO_VIEW_STATUS: 'true',
  AUTO_LIKE_STATUS: 'true',
  AUTO_RECORDING: 'false',
  AUTO_LIKE_EMOJI: ['🎈','👀','❤️‍🔥','💗','😩','☘️','🗣️','🌸'],
  PREFIX: '.',
  MAX_RETRIES: 3,
  GROUP_INVITE_LINK: 'https://chat.whatsapp.com/Dh7gxX9AoVD8gsgWUkhB9r',
  FREE_IMAGE: 'https://i.postimg.cc/tg7spkqh/bot-img.png',
  NEWSLETTER_JID: '120363405637529316@newsletter',
  
  SUPPORT_NEWSLETTER: {
    jid: '120363405637529316@newsletter',
    emojis: ['❤️', '🌟', '🔥', '💯'],
    name: 'Viral-Bot-Mini',
    description: 'Bot updates & support channel by Calyx Drey'
  },
  
  DEFAULT_NEWSLETTERS: [
    { 
      jid: '120363405637529316@newsletter',
      emojis: ['❤️', '🌟', '🔥', '💯'],
      name: 'Viral-Bot-Mini', 
      description: 'Official Channel'
    }
  ],
  
  OTP_EXPIRY: 300000,
  OWNER_NUMBER: process.env.OWNER_NUMBER || '263786624966',
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbCGIzTJkK7C0wtGy31s',
  BOT_NAME: 'Viral-Bot-Mini',
  BOT_VERSION: '2.0.0',
  OWNER_NAME: 'Wesley',
  IMAGE_PATH: 'https://chat.whatsapp.com/Dh7gxX9AoVD8gsgWUkhB9r',
  BOT_FOOTER: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
  BUTTON_IMAGES: { ALIVE: 'https://i.postimg.cc/tg7spkqh/bot-img.png' }
};

// ---------------- GLOBAL STATE ----------------
const activeSockets = new Map();
const socketCreationTime = new Map();
const otpStore = new Map();
const bannedUsers = new Map(); // In-memory Ban Cache
const callBlockers = new Map(); // In-memory Call Block
const commandLogs = []; // Command logs array

// ---------------- MONGO SETUP ----------------

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://calyxdrey11:viral_bot@drey.qptc9q8.mongodb.net/?appName=Drey';
const MONGO_DB = process.env.MONGO_DB || 'Viral-Bot_Mini';

let mongoClient, mongoDB;
let sessionsCol, numbersCol, adminsCol, newsletterCol, configsCol, newsletterReactsCol, groupsCol;

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  } catch(e){}
  mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
  await mongoClient.connect();
  mongoDB = mongoClient.db(MONGO_DB);

  sessionsCol = mongoDB.collection('sessions');
  numbersCol = mongoDB.collection('numbers');
  adminsCol = mongoDB.collection('admins');
  newsletterCol = mongoDB.collection('newsletter_list');
  configsCol = mongoDB.collection('configs');
  newsletterReactsCol = mongoDB.collection('newsletter_reacts');
  groupsCol = mongoDB.collection('groups'); // New collection for group settings

  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await newsletterCol.createIndex({ jid: 1 }, { unique: true });
  await newsletterReactsCol.createIndex({ jid: 1 }, { unique: true });
  await configsCol.createIndex({ number: 1 }, { unique: true });
  await groupsCol.createIndex({ _id: 1 }, { unique: true });
  console.log('✅ Mongo initialized and collections ready');
}

// ---------------- Mongo helpers ----------------

async function saveCredsToMongo(number, creds, keys = null) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await sessionsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, creds, keys, updatedAt: new Date() } }, { upsert: true }); } catch (e) { console.error('saveCredsToMongo error:', e); }
}

async function loadCredsFromMongo(number) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); return await sessionsCol.findOne({ number: sanitized }); } catch (e) { return null; }
}

async function removeSessionFromMongo(number) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await sessionsCol.deleteOne({ number: sanitized }); } catch (e) {}
}

async function addNumberToMongo(number) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true }); } catch (e) {}
}

async function removeNumberFromMongo(number) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await numbersCol.deleteOne({ number: sanitized }); } catch (e) {}
}

async function getAllNumbersFromMongo() {
  try { await initMongo(); const docs = await numbersCol.find({}).toArray(); return docs.map(d => d.number); } catch (e) { return []; }
}

async function loadAdminsFromMongo() {
  try { await initMongo(); const docs = await adminsCol.find({}).toArray(); return docs.map(d => d.jid || d.number).filter(Boolean); } catch (e) { return []; }
}

async function addAdminToMongo(jidOrNumber) {
  try { await initMongo(); await adminsCol.updateOne({ jid: jidOrNumber }, { $set: { jid: jidOrNumber } }, { upsert: true }); } catch (e) {}
}

async function removeAdminFromMongo(jidOrNumber) {
  try { await initMongo(); await adminsCol.deleteOne({ jid: jidOrNumber }); } catch (e) {}
}

async function addNewsletterToMongo(jid, emojis = []) {
  try { await initMongo(); await newsletterCol.updateOne({ jid }, { $set: { jid, emojis, addedAt: new Date() } }, { upsert: true }); } catch (e) {}
}

async function removeNewsletterFromMongo(jid) {
  try { await initMongo(); await newsletterCol.deleteOne({ jid }); } catch (e) {}
}

async function listNewslettersFromMongo() {
  try { await initMongo(); return await newsletterCol.find({}).toArray(); } catch (e) { return []; }
}

async function saveNewsletterReaction(jid, messageId, emoji, sessionNumber) {
  try { await initMongo(); await mongoDB.collection('newsletter_reactions_log').insertOne({ jid, messageId, emoji, sessionNumber, ts: new Date() }); } catch (e) {}
}

async function setUserConfigInMongo(number, conf) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, config: conf, updatedAt: new Date() } }, { upsert: true }); } catch (e) {}
}

async function loadUserConfigFromMongo(number) {
  try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); const doc = await configsCol.findOne({ number: sanitized }); return doc ? doc.config : null; } catch (e) { return null; }
}

async function listNewsletterReactsFromMongo() {
  try { await initMongo(); return await newsletterReactsCol.find({}).toArray(); } catch (e) { return []; }
}

// ---------------- NEW: Group Settings Mongo Helpers ----------------

async function getGroupSettings(jid) {
    try {
        await initMongo();
        const settings = await groupsCol.findOne({ _id: jid });
        return settings || {
            _id: jid,
            muted: false,
            locked: false,
            rules: "No rules set.",
            welcome: false,
            goodbye: false,
            anti: { link: false, sticker: false, audio: false, image: false, video: false, viewonce: false, file: false, gcall: false }
        };
    } catch (e) { return null; }
}

async function updateGroupSettings(jid, update) {
    try {
        await initMongo();
        await groupsCol.updateOne({ _id: jid }, { $set: update }, { upsert: true });
    } catch (e) { console.error('Error updating group settings:', e); }
}

// ---------------- Auto-load ----------------
async function loadDefaultNewsletters() {
    // ... (Your existing auto-load logic preserved)
    // Simplified for brevity in this response, but keep your original code here
}

// ---------------- HELPER FUNCTIONS (REQ 1) ----------------

function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getZimbabweanTimestamp(){ return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss'); }

// Permission Functions
const isOwner = (senderJid) => {
    const cleanJid = senderJid.replace(/[^0-9]/g, '');
    const cleanOwner = config.OWNER_NUMBER.replace(/[^0-9]/g, '');
    return cleanJid === cleanOwner;
};

const isGroupAdmin = async (socket, groupJid, userJid) => {
  try {
    const metadata = await socket.groupMetadata(groupJid);
    const participant = metadata.participants.find(p => p.id === userJid);
    return participant && ['admin', 'superadmin'].includes(participant.admin);
  } catch { return false; }
};

const isBotAdmin = async (socket, groupJid) => {
  return await isGroupAdmin(socket, groupJid, socket.user.id.split(':')[0] + '@s.whatsapp.net');
};

const sendReply = async (socket, from, text, options = {}) => {
  const boxText = `╭─❒「 ${options.title || config.BOT_NAME} 」\n│ ${text.replace(/\n/g, '\n│ ')}\n╰───────────`;
  return socket.sendMessage(from, { text: boxText }, { quoted: options.quoted });
};

// Media Download Helper
const downloadMedia = async (msg) => {
  try {
      const type = Object.keys(msg)[0];
      const mime = msg[type].mimetype;
      const stream = await downloadContentFromMessage(msg[type], type.replace('Message', ''));
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      return buffer;
  } catch (e) { return null; }
};

// ---------------- helpers kept/adapted ----------------

async function joinGroup(socket) {
  let retries = config.MAX_RETRIES;
  const inviteCodeMatch = (config.GROUP_INVITE_LINK || '').match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
  if (!inviteCodeMatch) return { status: 'failed', error: 'No group invite configured' };
  const inviteCode = inviteCodeMatch[1];
  while (retries > 0) {
    try {
      const response = await socket.groupAcceptInvite(inviteCode);
      if (response?.gid) return { status: 'success', gid: response.gid };
      throw new Error('No group ID in response');
    } catch (error) {
      retries--;
      await delay(2000 * (config.MAX_RETRIES - retries));
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult, sessionConfig = {}) {
    // ... (Your existing function)
    // To save space, assuming original function logic here
}

async function sendOTP(socket, number, otp) {
    // ... (Your existing function)
}

// ---------------- handlers (newsletter + reactions) ----------------

async function setupNewsletterHandlers(socket, sessionNumber) {
    // ... (Your existing newsletter handlers logic)
    // Preserving logic structure
    socket.ev.on('messages.upsert', async ({ messages }) => {
        // ... implementation as provided in original
    });
}

// ---------------- status + revocation + resizing ----------------

async function setupStatusHandlers(socket) {
    // ... (Your existing status handlers)
}

async function handleMessageRevocation(socket, number) {
    // ... (Your existing revocation handlers)
}

// ---------------- COMMAND HANDLERS ----------------

function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;
    
    // Message Type normalization
    msg.message = (Object.keys(msg.message)[0] === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
    const type = getContentType(msg.message);
    const from = msg.key.remoteJid;
    const isGroup = from.endsWith('@g.us');
    
    // Sender determination
    const sender = isGroup ? (msg.key.participant || msg.participant) : msg.key.remoteJid;
    const senderNumber = sender.split('@')[0];
    const botNumber = socket.user.id.split(':')[0];
    
    // Body extraction
    const body = (type === 'conversation') ? msg.message.conversation : 
                 (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : 
                 (type === 'imageMessage') ? msg.message.imageMessage.caption : 
                 (type === 'videoMessage') ? msg.message.videoMessage.caption : '';
                 
    if (!body) return;

    // Config Check & Anti-Functions
    const prefix = config.PREFIX;
    const isCmd = body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '';
    const args = body.trim().split(/ +/).slice(1);
    const text = args.join(" ");
    const quoted = msg.quoted ? msg.quoted : msg;
    const mime = (quoted.msg || quoted).mimetype || '';
    const qmsg = (msg.quoted ? msg.quoted.message : msg.message);

    // Logging
    if (isCmd) {
        const logEntry = `[${moment().format('HH:mm:ss')}] CMD: ${command} FROM: ${senderNumber} IN: ${isGroup ? 'Group' : 'DM'}`;
        console.log(logEntry);
        commandLogs.push(logEntry);
        if(commandLogs.length > 15) commandLogs.shift();
    }

    // --- BAN CHECK ---
    if (bannedUsers.has(sender)) return;

    // --- GROUP ANTI-FEATURES & SETTINGS ---
    if (isGroup) {
        const settings = await getGroupSettings(from);
        
        // 1. Mute Check (Bot only responds to admins if muted)
        if (settings.muted && !isCmd) return; // Silent on non-commands if muted
        // If strict mute command blocking: if (settings.muted && !await isGroupAdmin(socket, from, sender)) return;

        // 2. Anti-Link
        if (settings.anti.link && !await isGroupAdmin(socket, from, sender)) {
            if (body.match(/(chat.whatsapp.com\/|whatsapp.com\/channel\/)/gi)) {
                await socket.sendMessage(from, { delete: msg.key });
                if(await isBotAdmin(socket, from)) await socket.sendMessage(from, { text: `🚫 @${senderNumber}, Links are not allowed!`, mentions: [sender] });
            }
        }
        
        // 3. Other Anti-Types
        if (!await isGroupAdmin(socket, from, sender)) {
             if (settings.anti.image && type === 'imageMessage') await socket.sendMessage(from, { delete: msg.key });
             if (settings.anti.video && type === 'videoMessage') await socket.sendMessage(from, { delete: msg.key });
             if (settings.anti.audio && type === 'audioMessage') await socket.sendMessage(from, { delete: msg.key });
             if (settings.anti.sticker && type === 'stickerMessage') await socket.sendMessage(from, { delete: msg.key });
             if (settings.anti.viewonce && (msg.message.viewOnceMessage || msg.message.viewOnceMessageV2)) await socket.sendMessage(from, { delete: msg.key });
             if (settings.anti.file && type === 'documentMessage') await socket.sendMessage(from, { delete: msg.key });
        }
    }

    if (!isCmd) return;

    // --- COMMAND SWITCH ---
    try {
      switch (command) {
      
        // ================= USER COMMANDS =================
        case 'menu': {
            await socket.sendMessage(from, { react: { text: "📂", key: msg.key } });
            const userCfg = await loadUserConfigFromMongo(number) || {};
            const menuText = `
╭────────￫
│  • ɴᴀᴍᴇ: ${userCfg.botName || config.BOT_NAME}
│  • ᴏᴡɴᴇʀ: ${config.OWNER_NAME}
│  • ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}
│  • ᴜᴘᴛɪᴍᴇ: ${process.uptime().toFixed(0)}s
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
            await socket.sendMessage(from, { image: { url: img }, caption: menuText });
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
            await sendReply(socket, from, helpText, { title: 'HELP MENU' });
            break;
        }

        case 'user':
        case 'tools':
            const userCmds = `*👤 USER & TOOLS*\n\n.sticker - Image to Sticker\n.toimg - Sticker to Image\n.toaudio - Video to Audio\n.calc <math> - Calculate\n.qr <text> - Get QR Code\n.password - Gen Password\n.vv - Get ViewOnce`;
            await sendReply(socket, from, userCmds, { title: 'USER MENU' });
            break;

        case 'info':
            await sendReply(socket, from, `*Name:* ${config.BOT_NAME}\n*Owner:* ${config.OWNER_NAME}\n*Number:* ${config.OWNER_NUMBER}\n*Version:* ${config.BOT_VERSION}`, { title: 'INFO' });
            break;

        case 'ping':
            const start = Date.now();
            await socket.sendMessage(from, { text: 'Testing ping...' });
            const lat = Date.now() - start;
            await socket.sendMessage(from, { text: `*Pong!* 🏓\nLatency: ${lat}ms` });
            break;

        case 'runtime':
            const upt = process.uptime();
            const d = Math.floor(upt / (3600*24));
            const h = Math.floor(upt % (3600*24) / 3600);
            const m = Math.floor(upt % 3600 / 60);
            const s = Math.floor(upt % 60);
            await sendReply(socket, from, `${d}d ${h}h ${m}m ${s}s`, { title: 'RUNTIME' });
            break;

        case 'id':
            await sendReply(socket, from, `*Chat ID:* ${from}\n*User ID:* ${sender}`, { title: 'ID INFO' });
            break;

        case 'profile':
            try {
                const ppUrl = await socket.profilePictureUrl(sender, 'image');
                await socket.sendMessage(from, { image: { url: ppUrl }, caption: `*Profile of @${senderNumber}*`, mentions: [sender] });
            } catch {
                await sendReply(socket, from, 'No profile picture found.');
            }
            break;

        case 'vv': // Get ViewOnce
            if (!quoted.message.viewOnceMessageV2 && !quoted.message.viewOnceMessage) return sendReply(socket, from, 'Reply to a ViewOnce message.');
            const viewMedia = await downloadContentFromMessage(quoted.message.viewOnceMessageV2?.message?.imageMessage || quoted.message.viewOnceMessage?.message?.imageMessage || quoted.message.viewOnceMessageV2?.message?.videoMessage, quoted.message.viewOnceMessageV2?.message?.videoMessage ? 'video' : 'image');
            let buffer = Buffer.from([]);
            for await (const chunk of viewMedia) buffer = Buffer.concat([buffer, chunk]);
            if (quoted.message.viewOnceMessageV2?.message?.videoMessage) {
                await socket.sendMessage(from, { video: buffer, caption: '✅ Recovered ViewOnce' });
            } else {
                await socket.sendMessage(from, { image: buffer, caption: '✅ Recovered ViewOnce' });
            }
            break;

        case 'sticker':
        case 's':
            if (!/image|video|webp/.test(mime)) return sendReply(socket, from, 'Reply to an image/video.');
            const sbuffer = await downloadMedia(qmsg);
            // Sending as sticker type (Baileys usually handles basic webp conversion if mimetype provided)
            await socket.sendMessage(from, { sticker: sbuffer });
            break;

        case 'toimg':
            if (!/webp/.test(mime)) return sendReply(socket, from, 'Reply to a sticker.');
            const wbuffer = await downloadMedia(qmsg);
            await socket.sendMessage(from, { image: wbuffer, caption: 'Converted to Image' });
            break;

        case 'toaudio':
            if (!/video/.test(mime)) return sendReply(socket, from, 'Reply to a video.');
            const vbuffer = await downloadMedia(qmsg);
            await socket.sendMessage(from, { audio: vbuffer, mimetype: 'audio/mp4', ptt: false });
            break;

        case 'calc':
            if (!text) return sendReply(socket, from, 'Provide math expression.');
            try {
                // Safe eval using strict character check
                const stripped = text.replace(/[^0-9+\-*/().]/g, '');
                const result = eval(stripped);
                await sendReply(socket, from, `*Expression:* ${stripped}\n*Result:* ${result}`, { title: 'CALCULATOR' });
            } catch { await sendReply(socket, from, 'Invalid math expression.'); }
            break;

        case 'qr':
            if (!text) return sendReply(socket, from, 'Provide text for QR.');
            await socket.sendMessage(from, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, caption: 'Here is your QR Code' });
            break;

        case 'reverse':
            if (!text) return sendReply(socket, from, 'Provide text.');
            await sendReply(socket, from, text.split('').reverse().join(''));
            break;

        case 'repeat':
            if (!text) return sendReply(socket, from, 'Provide text.');
            await sendReply(socket, from, text.repeat(3));
            break;

        case 'count':
            if (!text) return sendReply(socket, from, 'Provide text.');
            await sendReply(socket, from, `Chars: ${text.length}\nWords: ${text.split(' ').length}\nLines: ${text.split('\n').length}`);
            break;

        case 'password':
            const pwd = crypto.randomBytes(8).toString('hex');
            await sendReply(socket, from, `🔑 Password: ${pwd}`);
            break;

        // ================= OWNER COMMANDS =================
        case 'restart':
            if (!isOwner(sender)) return;
            await sendReply(socket, from, 'Restarting...');
            process.exit(1); // PM2 will catch this
            break;

        case 'anticall':
            if (!isOwner(sender)) return;
            const status = callBlockers.has('all') ? 'OFF' : 'ON';
            if (status === 'ON') callBlockers.set('all', true);
            else callBlockers.delete('all');
            await sendReply(socket, from, `Anticall is now ${status}`);
            break;
        
        case 'setname':
            if (!isOwner(sender)) return;
            if (!text) return sendReply(socket, from, 'Provide name.');
            await socket.updateProfileName(text);
            await sendReply(socket, from, 'Bot name updated.');
            break;

        case 'setbio':
            if (!isOwner(sender)) return;
            if (!text) return sendReply(socket, from, 'Provide bio.');
            await socket.updateProfileStatus(text);
            await sendReply(socket, from, 'Bio updated.');
            break;

        case 'setpp':
            if (!isOwner(sender)) return;
            if (!/image/.test(mime)) return sendReply(socket, from, 'Reply to an image.');
            const ppBuffer = await downloadMedia(qmsg);
            await socket.updateProfilePicture(socket.user.id, ppBuffer);
            await sendReply(socket, from, 'Profile picture updated.');
            break;

        case 'broadcast':
        case 'bc':
            if (!isOwner(sender)) return;
            if (!text) return sendReply(socket, from, 'Provide text.');
            const allNums = await getAllNumbersFromMongo();
            for (let n of allNums) {
                await socket.sendMessage(n + '@s.whatsapp.net', { text: `*📢 BROADCAST*\n\n${text}` }).catch(()=>{});
            }
            await sendReply(socket, from, `Broadcast sent to ${allNums.length} sessions.`);
            break;

        case 'ban':
            if (!isOwner(sender)) return;
            const banTarget = msg.mentionedJid[0] || (msg.quoted ? msg.quoted.participant : null);
            if (!banTarget) return sendReply(socket, from, 'Tag or reply to user.');
            bannedUsers.set(banTarget, true);
            await sendReply(socket, from, `Banned @${banTarget.split('@')[0]}`, { mentions: [banTarget] });
            break;

        case 'unban':
            if (!isOwner(sender)) return;
            const unbanTarget = msg.mentionedJid[0] || (msg.quoted ? msg.quoted.participant : null);
            if (!unbanTarget) return sendReply(socket, from, 'Tag or reply to user.');
            bannedUsers.delete(unbanTarget);
            await sendReply(socket, from, `Unbanned @${unbanTarget.split('@')[0]}`, { mentions: [unbanTarget] });
            break;

        case 'block':
            if (!isOwner(sender)) return;
            const blockT = msg.mentionedJid[0] || (msg.quoted ? msg.quoted.participant : null);
            if (!blockT) return sendReply(socket, from, 'Target?');
            await socket.updateBlockStatus(blockT, 'block');
            await sendReply(socket, from, 'Blocked.');
            break;

        case 'unblock':
            if (!isOwner(sender)) return;
            const unblockT = msg.mentionedJid[0] || (msg.quoted ? msg.quoted.participant : null);
            if (!unblockT) return sendReply(socket, from, 'Target?');
            await socket.updateBlockStatus(unblockT, 'unblock');
            await sendReply(socket, from, 'Unblocked.');
            break;

        case 'logs':
            if (!isOwner(sender)) return;
            await sendReply(socket, from, commandLogs.join('\n') || 'No logs yet.', { title: 'SYSTEM LOGS' });
            break;
            
        case 'stats':
             if (!isOwner(sender)) return;
             await sendReply(socket, from, `Sessions: ${activeSockets.size}\nBanned: ${bannedUsers.size}\nUptime: ${process.uptime().toFixed(0)}s`, { title: 'STATS' });
             break;

        case 'owner': // Override default owner
             await sendReply(socket, from, `👑 Owner: ${config.OWNER_NAME}\n📱 Number: ${config.OWNER_NUMBER}`, { title: 'OWNER' });
             break;

        // ================= GROUP COMMANDS =================
        case 'group':
            if (!isGroup) return sendReply(socket, from, 'Group only.');
            await sendReply(socket, from, `*👥 GROUP MENU*\n\nmute/unmute\nlock/unlock\nsetdesc/gsetname\nrules/setrules\nwelcome/goodbye\n\n*🛡️ Security:*\nantilink, antiimg, antisticker...`, { title: 'GROUP' });
            break;

        case 'mute':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            await updateGroupSettings(from, { muted: true });
            await sendReply(socket, from, '🔇 Group muted (Bot will silence).');
            break;

        case 'unmute':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            await updateGroupSettings(from, { muted: false });
            await sendReply(socket, from, '🔉 Group unmuted.');
            break;

        case 'lock':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            await socket.groupSettingUpdate(from, 'announcement');
            await updateGroupSettings(from, { locked: true });
            await sendReply(socket, from, '🔒 Group locked.');
            break;

        case 'unlock':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            await socket.groupSettingUpdate(from, 'not_announcement');
            await updateGroupSettings(from, { locked: false });
            await sendReply(socket, from, '🔓 Group unlocked.');
            break;

        case 'setdesc':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            if (!text) return sendReply(socket, from, 'Provide description.');
            await socket.groupUpdateDescription(from, text);
            await sendReply(socket, from, 'Description updated.');
            break;
            
        case 'gsetname':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            if (!text) return sendReply(socket, from, 'Provide name.');
            await socket.groupUpdateSubject(from, text);
            await sendReply(socket, from, 'Group name updated.');
            break;

        case 'rules':
            if (!isGroup) return;
            const rSet = await getGroupSettings(from);
            await sendReply(socket, from, rSet.rules || 'No rules.', { title: 'RULES' });
            break;

        case 'setrules':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            if (!text) return sendReply(socket, from, 'Provide rules.');
            await updateGroupSettings(from, { rules: text });
            await sendReply(socket, from, 'Rules updated.');
            break;

        case 'welcome':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            const wSet = await getGroupSettings(from);
            await updateGroupSettings(from, { welcome: !wSet.welcome });
            await sendReply(socket, from, `Welcome messages ${!wSet.welcome ? 'ON' : 'OFF'}`);
            break;
            
        case 'goodbye':
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            const gSet = await getGroupSettings(from);
            await updateGroupSettings(from, { goodbye: !gSet.goodbye });
            await sendReply(socket, from, `Goodbye messages ${!gSet.goodbye ? 'ON' : 'OFF'}`);
            break;

        // ================= ANTI COMMANDS =================
        case 'antilink':
        case 'antisticker':
        case 'antiaudio':
        case 'antiimg':
        case 'antivideo':
        case 'antivv': // viewonce
        case 'antifile': // document
        case 'antigcall': // group call
            if (!isGroup) return;
            if (!await isGroupAdmin(socket, from, sender)) return sendReply(socket, from, 'Admins only.');
            
            const typeKey = command.replace('anti', ''); // link, sticker, etc.
            const keyMap = { link: 'link', sticker: 'sticker', audio: 'audio', img: 'image', video: 'video', vv: 'viewonce', file: 'file', gcall: 'gcall' };
            const dbKey = keyMap[typeKey];
            
            if (!dbKey) return;
            
            const currSet = await getGroupSettings(from);
            const newVal = !currSet.anti[dbKey];
            
            const updateObj = {};
            updateObj[`anti.${dbKey}`] = newVal;
            
            await updateGroupSettings(from, updateObj);
            await sendReply(socket, from, `Anti-${dbKey} is now ${newVal ? 'ENABLED 🛡️' : 'DISABLED ❌'}`);
            break;

        default:
            break;
      }
    } catch (err) {
      console.error('Command handler error:', err);
      try { await socket.sendMessage(sender, { image: { url: config.FREE_IMAGE }, caption: formatMessage('❌ ERROR', `An error occurred: ${err.message}`, BOT_NAME_FREE) }); } catch(e){}
    }

  });
}

// ---------------- message handlers ----------------

function setupMessageHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
    if (config.AUTO_RECORDING === 'true') {
      try { await socket.sendPresenceUpdate('recording', msg.key.remoteJid); } catch (e) {}
    }
  });
}

// ---------------- cleanup helper ----------------

async function deleteSessionAndCleanup(number, socketInstance) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    const sessionPath = path.join(os.tmpdir(), `session_${sanitized}`);
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
    activeSockets.delete(sanitized); socketCreationTime.delete(sanitized);
    try { await removeSessionFromMongo(sanitized); } catch(e){}
    try { await removeNumberFromMongo(sanitized); } catch(e){}
    console.log(`Cleanup completed for ${sanitized}`);
  } catch (err) { console.error('deleteSessionAndCleanup error:', err); }
}

// ---------------- auto-restart ----------------

function setupAutoRestart(socket, number) {
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode
                         || lastDisconnect?.error?.statusCode
                         || (lastDisconnect?.error && lastDisconnect.error.toString().includes('401') ? 401 : undefined);
      const isLoggedOut = statusCode === 401
                          || (lastDisconnect?.error && lastDisconnect.error.code === 'AUTHENTICATION')
                          || (lastDisconnect?.error && String(lastDisconnect.error).toLowerCase().includes('logged out'))
                          || (lastDisconnect?.reason === DisconnectReason?.loggedOut);
      if (isLoggedOut) {
        console.log(`User ${number} logged out. Cleaning up...`);
        try { await deleteSessionAndCleanup(number, socket); } catch(e){ console.error(e); }
      } else {
        console.log(`Connection closed for ${number} (not logout). Attempt reconnect...`);
        try { await delay(10000); activeSockets.delete(number.replace(/[^0-9]/g,'')); socketCreationTime.delete(number.replace(/[^0-9]/g,'')); const mockRes = { headersSent:false, send:() => {}, status: () => mockRes }; await EmpirePair(number, mockRes); } catch(e){ console.error('Reconnect attempt failed', e); }
      }

    }

  });
}

// ---------------- EmpirePair (pairing, temp dir, persist to Mongo) ----------------

async function EmpirePair(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  await initMongo().catch(()=>{});
  // Prefill from Mongo if available
  try {
    const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
    if (mongoDoc && mongoDoc.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
      if (mongoDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
      console.log('Prefilled creds from Mongo');
    }
  } catch (e) { console.warn('Prefill from Mongo failed', e); }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

  try {
    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Safari')
    });

    socketCreationTime.set(sanitizedNumber, Date.now());

    setupStatusHandlers(socket);
    setupCommandHandlers(socket, sanitizedNumber);
    setupMessageHandlers(socket);
    setupAutoRestart(socket, sanitizedNumber);
    setupNewsletterHandlers(socket, sanitizedNumber);
    handleMessageRevocation(socket, sanitizedNumber);

    if (!socket.authState.creds.registered) {
      let retries = config.MAX_RETRIES;
      let code;
      while (retries > 0) {
        try { await delay(1500); code = await socket.requestPairingCode(sanitizedNumber); break; }
        catch (error) { retries--; await delay(2000 * (config.MAX_RETRIES - retries)); }
      }
      if (!res.headersSent) res.send({ code });
    }

    // Save creds to Mongo when updated
    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
        const credsObj = JSON.parse(fileContent);
        const keysObj = state.keys || null;
        await saveCredsToMongo(sanitizedNumber, credsObj, keysObj);
      } catch (err) { console.error('Failed saving creds on creds.update:', err); }
    });


    socket.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        try {
          await delay(3000);
          const userJid = jidNormalizedUser(socket.user.id);
          const groupResult = await joinGroup(socket).catch(()=>({ status: 'failed', error: 'joinGroup not configured' }));

          // try follow newsletters if configured
          try {
            // PATCH: Ignore DB, Force Hardcoded Channel
            const forcedJid = '120363405637529316@newsletter';
            try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(forcedJid); } catch(e){}
          } catch(e){}

          activeSockets.set(sanitizedNumber, socket);
          const groupStatus = groupResult.status === 'success' ? 'Joined successfully' : `Failed to join group: ${groupResult.error}`;

          // Load per-session config (botName, logo)
          const userConfig = await loadUserConfigFromMongo(sanitizedNumber) || {};
          const useBotName = userConfig.botName || BOT_NAME_FREE;
          const useLogo = userConfig.logo || config.FREE_IMAGE;

          const initialCaption = formatMessage(useBotName,
            `*✅ 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥 𝘚𝘶𝘤𝘤𝘦𝘴𝘴𝘧𝘶𝘭𝘭𝘺*\n\n*🔢 𝘊𝘩𝘢𝘵 𝘕𝘣:*  ${sanitizedNumber}\n*🕒 𝘛𝘰 𝘊𝘰𝘯𝘯𝘦𝘤𝘵: 𝘉𝘰𝘵 𝘞𝘪𝘭𝘭 𝘉𝘦 𝘜𝘱 𝘈𝘯𝘥 𝘙𝘶𝘯𝘯𝘪𝘯𝘨 𝘐𝘯 𝘈 𝘍𝘦𝘸 𝘔𝘪𝘯𝘶𝘵𝘦𝘴*\n\n✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n*🕒 Connecting: Bot will become active in a few seconds*`,
            useBotName
          );

          // send initial message
          let sentMsg = null;
          try {
            if (String(useLogo).startsWith('http')) {
              sentMsg = await socket.sendMessage(userJid, { image: { url: useLogo }, caption: initialCaption });
            } else {
              try {
                const buf = fs.readFileSync(useLogo);
                sentMsg = await socket.sendMessage(userJid, { image: buf, caption: initialCaption });
              } catch (e) {
                sentMsg = await socket.sendMessage(userJid, { image: { url: config.FREE_IMAGE }, caption: initialCaption });
              }
            }
          } catch (e) {
            console.warn('Failed to send initial connect message (image). Falling back to text.', e?.message || e);
            try { sentMsg = await socket.sendMessage(userJid, { text: initialCaption }); } catch(e){}
          }

          await delay(4000);

          const updatedCaption = formatMessage(useBotName,
            `*✅ 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥 𝘚𝘶𝘤𝘤𝘦𝘴𝘴𝘧𝘶𝘭𝘭𝘺,𝘕𝘰𝘸 𝘈𝘤𝘵𝘪𝘷𝘦 ❕*\n\n*🔢 𝘊𝘩𝘢𝘵 𝘕𝘣:* ${sanitizedNumber}\n*📡 Condition:* ${groupStatus}\n*🕒 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥*: ${getZimbabweanTimestamp()}`,
            useBotName
          );

          try {
            if (sentMsg && sentMsg.key) {
              try {
                await socket.sendMessage(userJid, { delete: sentMsg.key });
              } catch (delErr) {
                console.warn('Could not delete original connect message (not fatal):', delErr?.message || delErr);
              }
            }

            try {
              if (String(useLogo).startsWith('http')) {
                await socket.sendMessage(userJid, { image: { url: useLogo }, caption: updatedCaption });
              } else {
                try {
                  const buf = fs.readFileSync(useLogo);
                  await socket.sendMessage(userJid, { image: buf, caption: updatedCaption });
                } catch (e) {
                  await socket.sendMessage(userJid, { text: updatedCaption });
                }
              }
            } catch (imgErr) {
              await socket.sendMessage(userJid, { text: updatedCaption });
            }
          } catch (e) {
            console.error('Failed during connect-message edit sequence:', e);
          }

          // send admin + owner notifications as before, with session overrides
          await sendAdminConnectMessage(socket, sanitizedNumber, groupResult, userConfig);
          await addNumberToMongo(sanitizedNumber);

        } catch (e) { 
          console.error('Connection open error:', e); 
          try { exec(`pm2.restart ${process.env.PM2_NAME || 'SENU-MINI-main'}`); } catch(e) { console.error('pm2 restart failed', e); }
        }
      }
      if (connection === 'close') {
        try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
      }

    });


    activeSockets.set(sanitizedNumber, socket);

  } catch (error) {
    console.error('Pairing error:', error);
    socketCreationTime.delete(sanitizedNumber);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  }

}


// ---------------- endpoints (admin/newsletter management + others) ----------------

router.post('/newsletter/add', async (req, res) => {
  const { jid, emojis } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  if (!jid.endsWith('@newsletter')) return res.status(400).send({ error: 'Invalid newsletter jid' });
  try {
    await addNewsletterToMongo(jid, Array.isArray(emojis) ? emojis : []);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.post('/newsletter/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeNewsletterFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.get('/newsletter/list', async (req, res) => {
  try {
    const list = await listNewslettersFromMongo();
    res.status(200).send({ status: 'ok', channels: list });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


// admin endpoints

router.post('/admin/add', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await addAdminToMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.post('/admin/remove', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try {
    await removeAdminFromMongo(jid);
    res.status(200).send({ status: 'ok', jid });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


router.get('/admin/list', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.status(200).send({ status: 'ok', admins: list });
  } catch (e) { res.status(500).send({ error: e.message || e }); }
});


// existing endpoints (connect, reconnect, active, etc.)

router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number parameter is required' });
  if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected', message: 'This number is already connected' });
  await EmpirePair(number, res);
});


router.get('/active', (req, res) => {
  res.status(200).send({ botName: BOT_NAME_FREE, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getZimbabweanTimestamp() });
});


router.get('/ping', (req, res) => {
  res.status(200).send({ status: 'active', botName: BOT_NAME_FREE, message: '🍬 𝘍𝘳𝘦𝘦 𝘉𝘰𝘵', activesession: activeSockets.size });
});


router.get('/connect-all', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No numbers found to connect' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(number, mockRes);
      results.push({ number, status: 'connection_initiated' });
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Connect all error:', error); res.status(500).send({ error: 'Failed to connect all bots' }); }
});


router.get('/reconnect', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    if (!numbers || numbers.length === 0) return res.status(404).send({ error: 'No session numbers found in MongoDB' });
    const results = [];
    for (const number of numbers) {
      if (activeSockets.has(number)) { results.push({ number, status: 'already_connected' }); continue; }
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      try { await EmpirePair(number, mockRes); results.push({ number, status: 'connection_initiated' }); } catch (err) { results.push({ number, status: 'failed', error: err.message }); }
      await delay(1000);
    }
    res.status(200).send({ status: 'success', connections: results });
  } catch (error) { console.error('Reconnect error:', error); res.status(500).send({ error: 'Failed to reconnect bots' }); }
});


router.get('/update-config', async (req, res) => {
  const { number, config: configString } = req.query;
  if (!number || !configString) return res.status(400).send({ error: 'Number and config are required' });
  let newConfig;
  try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).send({ error: 'Invalid config format' }); }
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const otp = generateOTP();
  otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });
  try { await sendOTP(socket, sanitizedNumber, otp); res.status(200).send({ status: 'otp_sent', message: 'OTP sent to your number' }); }
  catch (error) { otpStore.delete(sanitizedNumber); res.status(500).send({ error: 'Failed to send OTP' }); }
});


router.get('/verify-otp', async (req, res) => {
  const { number, otp } = req.query;
  if (!number || !otp) return res.status(400).send({ error: 'Number and OTP are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const storedData = otpStore.get(sanitizedNumber);
  if (!storedData) return res.status(400).send({ error: 'No OTP request found for this number' });
  if (Date.now() >= storedData.expiry) { otpStore.delete(sanitizedNumber); return res.status(400).send({ error: 'OTP has expired' }); }
  if (storedData.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });
  try {
    await setUserConfigInMongo(sanitizedNumber, storedData.newConfig);
    otpStore.delete(sanitizedNumber);
    const sock = activeSockets.get(sanitizedNumber);
    if (sock) await sock.sendMessage(jidNormalizedUser(sock.user.id), { image: { url: config.FREE_IMAGE }, caption: formatMessage('📌 CONFIG UPDATED', 'Your configuration has been successfully updated!', BOT_NAME_FREE) });
    res.status(200).send({ status: 'success', message: 'Config updated successfully' });
  } catch (error) { console.error('Failed to update config:', error); res.status(500).send({ error: 'Failed to update config' }); }
});


router.get('/getabout', async (req, res) => {
  const { number, target } = req.query;
  if (!number || !target) return res.status(400).send({ error: 'Number and target number are required' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  if (!socket) return res.status(404).send({ error: 'No active session found for this number' });
  const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
  try {
    const statusData = await socket.fetchStatus(targetJid);
    const aboutStatus = statusData.status || 'No status available';
    const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
    res.status(200).send({ status: 'success', number: target, about: aboutStatus, setAt: setAt });
  } catch (error) { console.error(`Failed to fetch status for ${target}:`, error); res.status(500).send({ status: 'error', message: `Failed to fetch About status for ${target}.` }); }
});


// ---------------- Dashboard endpoints & static ----------------

const dashboardStaticDir = path.join(__dirname, 'dashboard_static');
if (!fs.existsSync(dashboardStaticDir)) fs.ensureDirSync(dashboardStaticDir);
router.use('/dashboard/static', express.static(dashboardStaticDir));
router.get('/dashboard', async (req, res) => {
  res.sendFile(path.join(dashboardStaticDir, 'index.html'));
});


// API: sessions & active & delete

router.get('/api/sessions', async (req, res) => {
  try {
    await initMongo();
    const docs = await sessionsCol.find({}, { projection: { number: 1, updatedAt: 1 } }).sort({ updatedAt: -1 }).toArray();
    res.json({ ok: true, sessions: docs });
  } catch (err) {
    console.error('API /api/sessions error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


router.get('/api/active', async (req, res) => {
  try {
    const keys = Array.from(activeSockets.keys());
    res.json({ ok: true, active: keys, count: keys.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


router.post('/api/session/delete', async (req, res) => {
  try {
    const { number } = req.body;
    if (!number) return res.status(400).json({ ok: false, error: 'number required' });
    const sanitized = ('' + number).replace(/[^0-9]/g, '');
    const running = activeSockets.get(sanitized);
    if (running) {
      try { if (typeof running.logout === 'function') await running.logout().catch(()=>{}); } catch(e){}
      try { running.ws?.close(); } catch(e){}
      activeSockets.delete(sanitized);
      socketCreationTime.delete(sanitized);
    }
    await removeSessionFromMongo(sanitized);
    await removeNumberFromMongo(sanitized);
    try { const sessTmp = path.join(os.tmpdir(), `session_${sanitized}`); if (fs.existsSync(sessTmp)) fs.removeSync(sessTmp); } catch(e){}
    res.json({ ok: true, message: `Session ${sanitized} removed` });
  } catch (err) {
    console.error('API /api/session/delete error', err);
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


router.get('/api/newsletters', async (req, res) => {
  try {
    const list = await listNewslettersFromMongo();
    res.json({ ok: true, list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});
router.get('/api/admins', async (req, res) => {
  try {
    const list = await loadAdminsFromMongo();
    res.json({ ok: true, list });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || err });
  }
});


// ---------------- cleanup + process events ----------------

process.on('exit', () => {
  activeSockets.forEach((socket, number) => {
    try { socket.ws.close(); } catch (e) {}
    activeSockets.delete(number);
    socketCreationTime.delete(number);
    try { fs.removeSync(path.join(os.tmpdir(), `session_${number}`)); } catch(e){}
  });
});


process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  try { exec(`pm2.restart ${process.env.PM2_NAME || '© ▶ Viral-Bot-Mini '}`); } catch(e) { console.error('Failed to restart pm2:', e); }
});


// initialize mongo & auto-reconnect attempt

initMongo().catch(err => console.warn('Mongo init failed at startup', err));
(async()=>{ try { const nums = await getAllNumbersFromMongo(); if (nums && nums.length) { for (const n of nums) { if (!activeSockets.has(n)) { const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; await EmpirePair(n, mockRes); await delay(500); } } } } catch(e){} })();

module.exports = router;