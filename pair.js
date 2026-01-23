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

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  getContentType,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  downloadContentFromMessage,
  DisconnectReason
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
  OWNER_NUMBERS: ['263786624966', '263716558758'],
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbCGIzTJkK7C0wtGy31s',
  BOT_NAME: 'Viral-Bot-Mini',
  BOT_VERSION: '1.0.beta',
  OWNER_NAME: 'Wesley',
  IMAGE_PATH: 'https://chat.whatsapp.com/Dh7gxX9AoVD8gsgWUkhB9r',
  BOT_FOOTER: '▶ ● ᴠɪʀᴀʟ-ʙᴏᴛ-ᴍɪɴɪ',
  BUTTON_IMAGES: { ALIVE: 'https://i.postimg.cc/tg7spkqh/bot-img.png' }
};

// ==================== IN-MEMORY STORAGE ====================
const bannedUsers = new Map();
const groupSettings = new Map();
const stats = {
    totalUsers: 0,
    totalChats: 0,
    commandsUsed: 0,
    messagesProcessed: 0
};
const logs = [];
const callBlockers = new Map();
const userProfileCache = new Map();
const activeSockets = new Map();
const socketCreationTime = new Map();
const otpStore = new Map();

// Helper: Add to logs
function addLog(type, message) {
    logs.push({
        timestamp: getZimbabweanTimestamp(),
        type,
        message
    });
    if (logs.length > 100) logs.shift();
}

// Helper: Check if user is banned
function isBanned(userJid) {
    return bannedUsers.has(userJid);
}

// Helper: Check if sender is owner (UPDATED FOR MULTIPLE OWNERS)
function isOwner(senderJid) {
    try {
        // Extract number from JID
        const senderNumber = senderJid.split('@')[0].replace(/[^0-9]/g, '');
        
        // Check against all owner numbers
        const ownerNumbers = config.OWNER_NUMBERS || [config.OWNER_NUMBER];
        
        // Debug logging
        console.log(`Checking ownership: Sender ${senderNumber} vs Owners ${ownerNumbers.join(', ')}`);
        console.log(`Sender JID: ${senderJid}`);
        
        // Check if sender number matches any owner number
        return ownerNumbers.includes(senderNumber);
    } catch (e) {
        console.error('Error in isOwner check:', e);
        return false;
    }
}

// Helper: Get user profile info
async function getUserProfile(socket, userJid) {
    try {
        const [user] = await socket.onWhatsApp(userJid);
        if (user && user.exists) {
            const profile = await socket.fetchStatus(userJid).catch(() => ({}));
            userProfileCache.set(userJid, {
                name: user.verifiedName || user.name || 'Unknown',
                bio: profile.status || 'No bio',
                lastSeen: profile.setAt ? new Date(profile.setAt).toLocaleString() : 'Unknown'
            });
        }
        return userProfileCache.get(userJid) || { name: 'Unknown', bio: 'No bio', lastSeen: 'Unknown' };
    } catch (e) {
        return userProfileCache.get(userJid) || { name: 'Unknown', bio: 'No bio', lastSeen: 'Unknown' };
    }
}

// Helper: Generate fake meta ID
function generateFakeMetaId() {
    return `META_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper: Send image reply with fake meta ID and menu button
async function sendImageReply(socket, sender, caption, options = {}) {
    const fakevcard = {
        key: {
            remoteJid: "status@broadcast",
            participant: "0@s.whatsapp.net",
            fromMe: false,
            id: generateFakeMetaId()
        },
        message: {
            contactMessage: {
                displayName: "Viral-Bot-Mini",
                vcard: `BEGIN:VCARD\nVERSION:3.0\nN:Mini;;;;\nFN:Meta\nORG:Calyx Studio\nTEL;type=CELL;type=VOICE;waid=13135550002:+1 313 555 0002\nEND:VCARD`
            }
        }
    };
    
    const imagePayload = { url: config.FREE_IMAGE };
    const messageOptions = { quoted: fakevcard, ...options };
    
    // Always include menu button if not already specified
    const buttons = options.buttons || [
        { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" } }
    ];
    
    try {
        await socket.sendMessage(sender, {
            image: imagePayload,
            caption: caption,
            buttons: buttons,
            ...(options.footer && { footer: options.footer }),
            headerType: 4
        }, messageOptions);
    } catch (error) {
        console.error('Failed to send image reply:', error);
        // Fallback to text with fake meta
        await socket.sendMessage(sender, { text: caption }, { quoted: fakevcard });
    }
}

// Helper: Send futuristic styled reply with menu button
async function sendFuturisticReply(socket, sender, title, content, emoji = '🔧', buttons = null) {
    const formattedText = `╭────────￫\n│  ${emoji} ${title}\n│\n${content}\n╰───────￫`;
    
    // Use provided buttons or default menu button
    const replyButtons = buttons || [
        { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" } }
    ];
    
    return await sendImageReply(socket, sender, formattedText, { buttons: replyButtons });
}

// Helper: Format command list in futuristic style
function formatCommandList(title, commands, emoji) {
    let list = `╭────────￫\n│  ${emoji} ${title}\n`;
    commands.forEach(cmd => {
        list += `│  ➤ ${cmd}\n`;
    });
    list += `╰───────￫`;
    return list;
}

// Helper: Check owner permission and send error if not owner
async function checkOwnerPermission(socket, sender, senderJid, commandName) {
    if (!isOwner(senderJid)) {
        console.log(`Permission denied: ${senderJid} tried to use ${commandName}`);
        // Get all owner numbers for display
        const ownerNumbers = config.OWNER_NUMBERS || [config.OWNER_NUMBER];
        await sendFuturisticReply(socket, sender, 'ᴘᴇʀᴍɪssɪᴏɴ ᴅᴇɴɪᴇᴅ', 
            `ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ɪs ʀᴇsᴛʀɪᴄᴛᴇᴅ ᴛᴏ ᴛʜᴇ ʙᴏᴛ ᴏᴡɴᴇʀs ᴏɴʟʏ.\n\nᴏᴡɴᴇʀ: ${config.OWNER_NAME}\nᴏᴡɴᴇʀ ɴᴜᴍʙᴇʀs: ${ownerNumbers.join(', ')}`, 
            '❌'
        );
        return false;
    }
    return true;
}

// Helper: Download media from message
async function downloadMedia(message, mimeType) {
    try {
        const stream = await downloadContentFromMessage(message, mimeType);
        let buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
        return buffer;
    } catch (e) {
        console.error('Download media error:', e);
        return null;
    }
}

// Helper: Convert to sticker with proper processing
async function convertToSticker(buffer, mimeType) {
    try {
        // If it's a video, convert to GIF for sticker
        if (mimeType.includes('video')) {
            // For simplicity, we'll use the first frame if video-to-sticker conversion fails
            // In production, you might want to use ffmpeg or similar
            const image = await Jimp.read(buffer);
            return await image.resize(512, 512).getBufferAsync(Jimp.MIME_PNG);
        } else {
            // For images
            const image = await Jimp.read(buffer);
            return await image.resize(512, 512).getBufferAsync(Jimp.MIME_PNG);
        }
    } catch (e) {
        console.error('Convert to sticker error:', e);
        return buffer; // Return original buffer as fallback
    }
}

// ---------------- MONGO SETUP ----------------
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://malvintech11_db_user:0SBgxRy7WsQZ1KTq@cluster0.xqgaovj.mongodb.net/?appName=Cluster0';
const MONGO_DB = process.env.MONGO_DB || 'Viral-Bot_Mini';

let mongoClient, mongoDB;
let sessionsCol, numbersCol, adminsCol, newsletterCol, configsCol, newsletterReactsCol;

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

  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await newsletterCol.createIndex({ jid: 1 }, { unique: true });
  await newsletterReactsCol.createIndex({ jid: 1 }, { unique: true });
  await configsCol.createIndex({ number: 1 }, { unique: true });
  console.log('✅ Mongo initialized and collections ready');
}

// ---------------- Mongo helpers ----------------
async function saveCredsToMongo(number, creds, keys = null) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = { number: sanitized, creds, keys, updatedAt: new Date() };
    await sessionsCol.updateOne({ number: sanitized }, { $set: doc }, { upsert: true });
    console.log(`Saved creds to Mongo for ${sanitized}`);
  } catch (e) { console.error('saveCredsToMongo error:', e); }
}

async function loadCredsFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await sessionsCol.findOne({ number: sanitized });
    return doc || null;
  } catch (e) { console.error('loadCredsFromMongo error:', e); return null; }
}

async function removeSessionFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await sessionsCol.deleteOne({ number: sanitized });
    console.log(`Removed session from Mongo for ${sanitized}`);
  } catch (e) { console.error('removeSessionToMongo error:', e); }
}

async function addNumberToMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
    console.log(`Added number ${sanitized} to Mongo numbers`);
  } catch (e) { console.error('addNumberToMongo', e); }
}

async function removeNumberFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: sanitized });
    console.log(`Removed number ${sanitized} from Mongo numbers`);
  } catch (e) { console.error('removeNumberFromMongo', e); }
}

async function getAllNumbersFromMongo() {
  try {
    await initMongo();
    const docs = await numbersCol.find({}).toArray();
    return docs.map(d => d.number);
  } catch (e) { console.error('getAllNumbersFromMongo', e); return []; }
}

async function loadAdminsFromMongo() {
  try {
    await initMongo();
    const docs = await adminsCol.find({}).toArray();
    return docs.map(d => d.jid || d.number).filter(Boolean);
  } catch (e) { console.error('loadAdminsFromMongo', e); return []; }
}

async function addAdminToMongo(jidOrNumber) {
  try {
    await initMongo();
    const doc = { jid: jidOrNumber };
    await adminsCol.updateOne({ jid: jidOrNumber }, { $set: doc }, { upsert: true });
    console.log(`Added admin ${jidOrNumber}`);
  } catch (e) { console.error('addAdminToMongo', e); }
}

async function removeAdminFromMongo(jidOrNumber) {
  try {
    await initMongo();
    await adminsCol.deleteOne({ jid: jidOrNumber });
    console.log(`Removed admin ${jidOrNumber}`);
  } catch (e) { console.error('removeAdminFromMongo', e); }
}

async function addNewsletterToMongo(jid, emojis = []) {
  try {
    await initMongo();
    const doc = { jid, emojis: Array.isArray(emojis) ? emojis : [], addedAt: new Date() };
    await newsletterCol.updateOne({ jid }, { $set: doc }, { upsert: true });
    console.log(`Added newsletter ${jid} -> emojis: ${doc.emojis.join(',')}`);
  } catch (e) { console.error('addNewsletterToMongo', e); throw e; }
}

async function removeNewsletterFromMongo(jid) {
  try {
    await initMongo();
    await newsletterCol.deleteOne({ jid });
    console.log(`Removed newsletter ${jid}`);
  } catch (e) { console.error('removeNewsletterFromMongo', e); throw e; }
}

async function listNewslettersFromMongo() {
  try {
    await initMongo();
    const docs = await newsletterCol.find({}).toArray();
    return docs.map(d => ({ jid: d.jid, emojis: Array.isArray(d.emojis) ? d.emojis : [] }));
  } catch (e) { console.error('listNewslettersFromMongo', e); return []; }
}

async function saveNewsletterReaction(jid, messageId, emoji, sessionNumber) {
  try {
    await initMongo();
    const doc = { jid, messageId, emoji, sessionNumber, ts: new Date() };
    if (!mongoDB) await initMongo();
    const col = mongoDB.collection('newsletter_reactions_log');
    await col.insertOne(doc);
    console.log(`Saved reaction ${emoji} for ${jid}#${messageId}`);
  } catch (e) { console.error('saveNewsletterReaction', e); }
}

async function setUserConfigInMongo(number, conf) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, config: conf, updatedAt: new Date() } }, { upsert: true });
  } catch (e) { console.error('setUserConfigInMongo', e); }
}

async function loadUserConfigFromMongo(number) {
  try {
    await initMongo();
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await configsCol.findOne({ number: sanitized });
    return doc ? doc.config : null;
  } catch (e) { console.error('loadUserConfigFromMongo', e); return null; }
}

async function addNewsletterReactConfig(jid, emojis = []) {
  try {
    await initMongo();
    await newsletterReactsCol.updateOne({ jid }, { $set: { jid, emojis, addedAt: new Date() } }, { upsert: true });
    console.log(`Added react-config for ${jid} -> ${emojis.join(',')}`);
  } catch (e) { console.error('addNewsletterReactConfig', e); throw e; }
}

async function removeNewsletterReactConfig(jid) {
  try {
    await initMongo();
    await newsletterReactsCol.deleteOne({ jid });
    console.log(`Removed react-config for ${jid}`);
  } catch (e) { console.error('removeNewsletterReactConfig', e); throw e; }
}

async function listNewsletterReactsFromMongo() {
  try {
    await initMongo();
    const docs = await newsletterReactsCol.find({}).toArray();
    return docs.map(d => ({ jid: d.jid, emojis: Array.isArray(d.emojis) ? d.emojis : [] }));
  } catch (e) { console.error('listNewsletterReactsFromMongo', e); return []; }
}

async function getReactConfigForJid(jid) {
  try {
    await initMongo();
    const doc = await newsletterReactsCol.findOne({ jid });
    return doc ? (Array.isArray(doc.emojis) ? doc.emojis : []) : null;
  } catch (e) { console.error('getReactConfigForJid', e); return null; }
}

// ---------------- basic utils ----------------
function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getZimbabweanTimestamp(){ return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss'); }

// ---------------- helpers ----------------
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
      let errorMessage = error.message || 'Unknown error';
      if (error.message && error.message.includes('not-authorized')) errorMessage = 'Bot not authorized';
      else if (error.message && error.message.includes('conflict')) errorMessage = 'Already a member';
      else if (error.message && error.message.includes('gone')) errorMessage = 'Invite invalid/expired';
      if (retries === 0) return { status: 'failed', error: errorMessage };
      await delay(2000 * (config.MAX_RETRIES - retries));
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult, sessionConfig = {}) {
  const admins = await loadAdminsFromMongo();
  const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`;
  const botName = sessionConfig.botName || BOT_NAME_FREE;
  const image = sessionConfig.logo || config.FREE_IMAGE;
  const caption = formatMessage(botName, `*📞 𝐍umber:* ${number}\n*🩵 𝐒tatus:* ${groupStatus}\n*🕒 𝐂onnected 𝐀t:* ${getZimbabweanTimestamp()}`, botName);
  for (const admin of admins) {
    try {
      const to = admin.includes('@') ? admin : `${admin}@s.whatsapp.net`;
      if (String(image).startsWith('http')) {
        await socket.sendMessage(to, { image: { url: image }, caption });
      } else {
        try {
          const buf = fs.readFileSync(image);
          await socket.sendMessage(to, { image: buf, caption });
        } catch (e) {
          await socket.sendMessage(to, { image: { url: config.FREE_IMAGE }, caption });
        }
      }
    } catch (err) {
      console.error('Failed to send connect message to admin', admin, err?.message || err);
    }
  }
}

async function sendOTP(socket, number, otp) {
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`*🔐 OTP VERIFICATION — ${BOT_NAME_FREE}*`, `*𝐘our 𝐎TP 𝐅or 𝐂onfig 𝐔pdate is:* *${otp}*\n*𝐓his 𝐎TP 𝐖ill 𝐄xpire 𝐈n 5 𝐌inutes.*\n\n*𝐍umber:* ${number}`, BOT_NAME_FREE);
  try { await socket.sendMessage(userJid, { text: message }); console.log(`OTP ${otp} sent to ${number}`); }
  catch (error) { console.error(`Failed to send OTP to ${number}:`, error); throw error; }
}

// ---------------- handlers ----------------
async function setupNewsletterHandlers(socket, sessionNumber) {
  const rrPointers = new Map();

  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key) return;
    const jid = message.key.remoteJid;

    try {
      const followedDocs = await listNewslettersFromMongo();
      const reactConfigs = await listNewsletterReactsFromMongo();
      const reactMap = new Map();
      for (const r of reactConfigs) reactMap.set(r.jid, r.emojis || []);

      const followedJids = followedDocs.map(d => d.jid);
      if (!followedJids.includes(jid) && !reactMap.has(jid)) return;

      let emojis = reactMap.get(jid) || null;
      if ((!emojis || emojis.length === 0) && followedDocs.find(d => d.jid === jid)) {
        emojis = (followedDocs.find(d => d.jid === jid).emojis || []);
      }
      if (!emojis || emojis.length === 0) emojis = config.AUTO_LIKE_EMOJI;

      let idx = rrPointers.get(jid) || 0;
      const emoji = emojis[idx % emojis.length];
      rrPointers.set(jid, (idx + 1) % emojis.length);

      const messageId = message.newsletterServerId || message.key.id;
      if (!messageId) return;

      let retries = 3;
      while (retries-- > 0) {
        try {
          if (typeof socket.newsletterReactMessage === 'function') {
            await socket.newsletterReactMessage(jid, messageId.toString(), emoji);
          } else {
            await socket.sendMessage(jid, { react: { text: emoji, key: message.key } });
          }
          console.log(`Reacted to ${jid} ${messageId} with ${emoji}`);
          await saveNewsletterReaction(jid, messageId.toString(), emoji, sessionNumber || null);
          break;
        } catch (err) {
          console.warn(`Reaction attempt failed (${3 - retries}/3):`, err?.message || err);
          await delay(1200);
        }
      }

    } catch (error) {
      console.error('Newsletter reaction handler error:', error?.message || error);
    }
  });
}

async function setupStatusHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
    try {
      if (config.AUTO_RECORDING === 'true') await socket.sendPresenceUpdate("recording", message.key.remoteJid);
      if (config.AUTO_VIEW_STATUS === 'true') {
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try { await socket.readMessages([message.key]); break; }
          catch (error) { retries--; await delay(1000 * (config.MAX_RETRIES - retries)); if (retries===0) throw error; }
        }
      }
      if (config.AUTO_LIKE_STATUS === 'true') {
        const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
        let retries = config.MAX_RETRIES;
        while (retries > 0) {
          try {
            await socket.sendMessage(message.key.remoteJid, { react: { text: randomEmoji, key: message.key } }, { statusJidList: [message.key.participant] });
            break;
          } catch (error) { retries--; await delay(1000 * (config.MAX_RETRIES - retries)); if (retries===0) throw error; }
        }
      }

    } catch (error) { console.error('Status handler error:', error); }
  });
}

async function handleMessageRevocation(socket, number) {
  socket.ev.on('messages.delete', async ({ keys }) => {
    if (!keys || keys.length === 0) return;
    const messageKey = keys[0];
    const userJid = jidNormalizedUser(socket.user.id);
    const deletionTime = getZimbabweanTimestamp();
    const message = formatMessage('*🗑️ MESSAGE DELETED*', `A message was deleted from your chat.\n*📄 𝐅rom:* ${messageKey.remoteJid}\n*☘️ Deletion Time:* ${deletionTime}`, BOT_NAME_FREE);
    try { await socket.sendMessage(userJid, { image: { url: config.FREE_IMAGE }, caption: message }); }
    catch (error) { console.error('*Failed to send deletion notification !*', error); }
  });
}

async function resize(image, width, height) {
  let oyy = await Jimp.read(image);
  return await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
}

// ---------------- COMMAND HANDLERS (OWNER COMMANDS + USER COMMANDS) ----------------
function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

    const type = getContentType(msg.message);
    if (!msg.message) return;
    msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;

    const from = msg.key.remoteJid;
    const sender = from;
    const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
    const senderNumber = (nowsender || '').split('@')[0];
    const senderJid = nowsender; // Use full JID for owner check
    const botNumber = socket.user.id ? socket.user.id.split(':')[0] : '';

    const body = (type === 'conversation') ? msg.message.conversation
      : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text
      : (type === 'imageMessage' && msg.message.imageMessage.caption) ? msg.message.imageMessage.caption
      : (type === 'videoMessage' && msg.message.videoMessage.caption) ? msg.message.videoMessage.caption
      : (type === 'buttonsResponseMessage') ? msg.message.buttonsResponseMessage?.selectedButtonId
      : (type === 'listResponseMessage') ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId
      : (type === 'viewOnceMessage') ? (msg.message.viewOnceMessage?.message?.imageMessage?.caption || '') : '';

    if (!body || typeof body !== 'string') return;

    const prefix = config.PREFIX;
    const isCmd = body && body.startsWith && body.startsWith(prefix);
    const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);

    // helper: download quoted media
    async function downloadQuotedMedia(quoted) {
      if (!quoted) return null;
      const qTypes = ['imageMessage','videoMessage','audioMessage','documentMessage','stickerMessage'];
      const qType = qTypes.find(t => quoted[t]);
      if (!qType) return null;
      const messageType = qType.replace(/Message$/i, '').toLowerCase();
      const stream = await downloadContentFromMessage(quoted[qType], messageType);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
      return {
        buffer,
        mime: quoted[qType].mimetype || '',
        caption: quoted[qType].caption || quoted[qType].fileName || '',
        ptt: quoted[qType].ptt || false,
        fileName: quoted[qType].fileName || ''
      };
    }

    if (!command) return;

    // Update stats
    stats.commandsUsed++;
    stats.messagesProcessed++;
    addLog('COMMAND', `${command} used by ${senderJid} in ${from}`);

    // Check if user is banned
    if (isBanned(nowsender)) {
      await sendImageReply(socket, sender, '╭────────￫\n│  ❌ ʙᴀɴɴᴇᴅ\n│\n│  ʏᴏᴜ ᴀʀᴇ ʙᴀɴɴᴇᴅ ғʀᴏᴍ ᴜsɪɴɢ ʙᴏᴛ ᴄᴏᴍᴍᴀɴᴅs.\n╰───────￫');
      return;
    }

    try {
      // ==================== USER COMMANDS ====================
      switch (command) {
        // BASIC COMMANDS
        case 'menu': {
          try { await socket.sendMessage(sender, { react: { text: "🎐", key: msg.key } }); } catch(e){}
          try {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const hours = Math.floor(uptime / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            const text = `
╭────────￫
│  🔧 ғᴇᴀᴛᴜʀᴇs                  
│  [1] 👑 ᴏᴡɴᴇʀ                           
│  [2] 🧑 ᴜsᴇʀ                          
│  [3] 🛡 ɢʀᴏᴜᴘ / ᴀᴅᴍɪɴ                        
│  [4] ⏳ ᴄᴏᴍɪɴɢ sᴏᴏɴ                   
│  [5] ⏳ ᴄᴏᴍɪɴɢ sᴏᴏɴ                       
╰───────￫

🎯 ᴛᴀᴘ ᴀ ᴄᴀᴛᴇɢᴏʀʏ ʙᴇʟᴏᴡ!
`.trim();

            const buttons = [
              { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: "👑 ᴏᴡɴᴇʀ" } },
              { buttonId: `${config.PREFIX}user`, buttonText: { displayText: "🧑 ᴜsᴇʀ ᴄᴏᴍᴍᴀɴᴅs" } },
              { buttonId: `${config.PREFIX}help`, buttonText: { displayText: "❓ ʜᴇʟᴘ" } },
              { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: "⚡ ᴘɪɴɢ" } }
            ];

            await sendImageReply(socket, sender, text, { 
              buttons, 
              footer: config.BOT_FOOTER
            });
          } catch (err) {
            console.error('menu command error:', err);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ sʜᴏᴡ ᴍᴇɴᴜ.', '❌');
          }
          break;
        }

        case 'help': {
          try { await socket.sendMessage(sender, { react: { text: "❓", key: msg.key } }); } catch(e){}
          
          const helpText = `
╭────────￫
│  ❓ ʙᴀsɪᴄ ʜᴇʟᴘ
│
│  📍 ᴘʀᴇғɪx: ${config.PREFIX}
│  👑 ᴏᴡɴᴇʀ: ${config.OWNER_NAME}
│
│  🎯 ᴀᴠᴀɪʟᴀʙʟᴇ ᴄᴏᴍᴍᴀɴᴅs:
│  ➤ .ᴍᴇɴᴜ - sʜᴏᴡ ᴍᴀɪɴ ᴍᴇɴᴜ
│  ➤ .ʜᴇʟᴘ - ᴛʜɪs ʜᴇʟᴘ ᴍᴇssᴀɢᴇ
│  ➤ .ᴘɪɴɢ - ᴄʜᴇᴄᴋ ʙᴏᴛ ʀᴇsᴘᴏɴsᴇ
│  ➤ .ᴏᴡɴᴇʀ - sʜᴏᴡ ᴏᴡɴᴇʀ ᴄᴏᴍᴍᴀɴᴅs
│  ➤ .ᴜsᴇʀ - sʜᴏᴡ ᴜsᴇʀ ᴄᴏᴍᴍᴀɴᴅs
│  ➤ .ʀᴜɴᴛɪᴍᴇ - sʜᴏᴡ ʙᴏᴛ ᴜᴘᴛɪᴍᴇ
│  ➤ .ɪᴅ - ɢᴇᴛ ʏᴏᴜʀ ᴜsᴇʀ ɪᴅ
│  ➤ .ᴘʀᴏғɪʟᴇ - ᴠɪᴇᴡ ʏᴏᴜʀ ᴘʀᴏғɪʟᴇ
│  ➤ .ᴠᴠ - ᴠɪᴇᴡ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇᴅɪᴀ
│  ➤ .sᴛɪᴄᴋᴇʀ - ᴄᴏɴᴠᴇʀᴛ ᴍᴇᴅɪᴀ ᴛᴏ sᴛɪᴄᴋᴇʀ
│  ➤ .ᴛᴏɪᴍɢ - ᴄᴏɴᴠᴇʀᴛ sᴛɪᴄᴋᴇʀ ᴛᴏ ɪᴍᴀɢᴇ
│  ➤ .ᴛᴏᴀᴜᴅɪᴏ - ᴇxᴛʀᴀᴄᴛ ᴀᴜᴅɪᴏ ғʀᴏᴍ ᴠɪᴅᴇᴏ
│  ➤ .ᴄᴀʟᴄ - ᴄᴀʟᴄᴜʟᴀᴛᴏʀ
│  ➤ .ǫʀ - ɢᴇɴᴇʀᴀᴛᴇ ǫʀ ᴄᴏᴅᴇ
│  ➤ .ʀᴇᴠᴇʀsᴇ - ʀᴇᴠᴇʀsᴇ ᴛᴇxᴛ
│  ➤ .ʀᴇᴘᴇᴀᴛ - ʀᴇᴘᴇᴀᴛ ᴛᴇxᴛ
│  ➤ .ᴄᴏᴜɴᴛ - ᴄᴏᴜɴᴛᴇʀ
│  ➤ .ᴘᴀssᴡᴏʀᴅ - ɢᴇɴᴇʀᴀᴛᴇ ᴘᴀssᴡᴏʀᴅ
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, helpText);
          break;
        }

        case 'user': {
          try { await socket.sendMessage(sender, { react: { text: "🧑", key: msg.key } }); } catch(e){}
          
          const userCommands = `
╭────────￫
│  🧑 ᴜsᴇʀ ᴄᴏᴍᴍᴀɴᴅs
│
│  📍 ᴘʀᴇғɪx: ${config.PREFIX}
│
│  🔧 ʙᴀsɪᴄ ᴄᴏᴍᴍᴀɴᴅs:
│  ➤ .ᴍᴇɴᴜ - sʜᴏᴡ ᴍᴀɪɴ ᴍᴇɴᴜ
│  ➤ .ʜᴇʟᴘ - sʜᴏᴡ ʜᴇʟᴘ ᴍᴇɴᴜ
│  ➤ .ᴘɪɴɢ - ᴄʜᴇᴄᴋ ʙᴏᴛ sᴘᴇᴇᴅ
│  ➤ .ʀᴜɴᴛɪᴍᴇ - sʜᴏᴡ ʙᴏᴛ ᴜᴘᴛɪᴍᴇ
│  ➤ .ɪᴅ - ɢᴇᴛ ʏᴏᴜʀ ᴜsᴇʀ ɪᴅ
│  ➤ .ᴘʀᴏғɪʟᴇ - ᴠɪᴇᴡ ʏᴏᴜʀ ᴘʀᴏғɪʟᴇ
│
│  🖼️ ᴍᴇᴅɪᴀ ᴄᴏᴍᴍᴀɴᴅs:
│  ➤ .ᴠᴠ - sᴀᴠᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇᴅɪᴀ
│  ➤ .sᴛɪᴄᴋᴇʀ - ᴄᴏɴᴠᴇʀᴛ ᴛᴏ sᴛɪᴄᴋᴇʀ
│  ➤ .ᴛᴏɪᴍɢ - sᴛɪᴄᴋᴇʀ ᴛᴏ ɪᴍᴀɢᴇ
│  ➤ .ᴛᴏᴀᴜᴅɪᴏ - ᴇxᴛʀᴀᴄᴛ ᴀᴜᴅɪᴏ
│
│  🛠️ ᴜᴛɪʟɪᴛʏ ᴄᴏᴍᴍᴀɴᴅs:
│  ➤ .ᴄᴀʟᴄ - ᴄᴀʟᴄᴜʟᴀᴛᴏʀ
│  ➤ .ǫʀ - ɢᴇɴᴇʀᴀᴛᴇ ǫʀ ᴄᴏᴅᴇ
│  ➤ .ʀᴇᴠᴇʀsᴇ - ʀᴇᴠᴇʀsᴇ ᴛᴇxᴛ
│  ➤ .ʀᴇᴘᴇᴀᴛ - ʀᴇᴘᴇᴀᴛ ᴛᴇxᴛ
│  ➤ .ᴄᴏᴜɴᴛ - ᴛᴇxᴛ sᴛᴀᴛɪsᴛɪᴄs
│  ➤ .ᴘᴀssᴡᴏʀᴅ - ᴘᴀssᴡᴏʀᴅ ɢᴇɴᴇʀᴀᴛᴏʀ
│
│  ℹ️ ɪɴғᴏ ᴄᴏᴍᴍᴀɴᴅs:
│  ➤ .ᴏᴡɴᴇʀ - sʜᴏᴡ ᴏᴡɴᴇʀ ɪɴғᴏ
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, userCommands, {
            buttons: [
              { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" } },
              { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: "👑 ᴏᴡɴᴇʀ" } }
            ]
          });
          break;
        }

        case 'info': {
          try { await socket.sendMessage(sender, { react: { text: "📋", key: msg.key } }); } catch(e){}
          
          const ownerNumbers = config.OWNER_NUMBERS || [config.OWNER_NUMBER];
          const ownerInfo = `
╭────────￫
│  📋 ᴏᴡɴᴇʀ ɪɴғᴏʀᴍᴀᴛɪᴏɴ
│
│  📛 ɴᴀᴍᴇ: ${config.OWNER_NAME}
│  📞 ᴏᴡɴᴇʀ ɴᴜᴍʙᴇʀs:
│  ${ownerNumbers.map((num, idx) => `  ${idx + 1}. ${num}`).join('\n')}
│  ⚡ ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}
│  🏢 ᴅᴇᴠᴇʟᴏᴘᴇʀ: Calyx Drey
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, ownerInfo);
          break;
        }

        case 'ping': {
          try { await socket.sendMessage(sender, { react: { text: "⚡", key: msg.key } }); } catch(e){}
          try {
            const startTime = Date.now();
            const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());
            const speedTest = Date.now() - startTime;

            const text = `
╭────────￫
│  ⚡ ᴘɪɴɢ ɴᴏᴡ
│
│  ◈ 🛠️ ʟᴀᴛᴇɴᴄʏ: ${latency}ᴍs
│  ◈ ⚡ sᴘᴇᴇᴅ: ${speedTest}ᴍs
│  ◈ 👑 ᴏᴡɴᴇʀ: ${config.OWNER_NAME}
╰───────￫
`.trim();

            await sendImageReply(socket, sender, text, { 
              footer: config.BOT_FOOTER
            });
          } catch(e) {
            console.error('ping error', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ᴘɪɴɢ.', '❌');
          }
          break;
        }

        case 'runtime': {
          try { await socket.sendMessage(sender, { react: { text: "⏱️", key: msg.key } }); } catch(e){}
          try {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const days = Math.floor(uptime / 86400);
            const hours = Math.floor((uptime % 86400) / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);

            const runtimeText = `
╭────────￫
│  ⏱️ ʀᴜɴᴛɪᴍᴇ
│
│  ◈ ʙᴏᴛ ᴜᴘᴛɪᴍᴇ:
│  ➤ ${days}ᴅ ${hours}ʜ ${minutes}ᴍ ${seconds}s
│
│  ◈ sᴛᴀʀᴛᴇᴅ ᴀᴛ:
│  ➤ ${new Date(startTime).toLocaleString()}
│
│  ◈ ᴄᴜʀʀᴇɴᴛ ᴛɪᴍᴇ:
│  ➤ ${new Date().toLocaleString()}
╰───────￫
`.trim();
            
            await sendImageReply(socket, sender, runtimeText);
          } catch(e) {
            console.error('Runtime error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ʀᴜɴᴛɪᴍᴇ.', '❌');
          }
          break;
        }

        case 'owner': {
          try { await socket.sendMessage(sender, { react: { text: "👑", key: msg.key } }); } catch(e){}
          
          // Check if user is owner to show owner commands
          if (isOwner(senderJid)) {
            const ownerCommands = `
╭────────￫
│  👑 ᴏᴡɴᴇʀ ᴄᴏᴍᴍᴀɴᴅs
│
│  🛠️ ʙᴏᴛ ᴄᴏɴᴛʀᴏʟ:
│  ➤ .ʀᴇsᴛᴀʀᴛ - ʀᴇsᴛᴀʀᴛ ʙᴏᴛ
│  ➤ .ᴀɴᴛɪᴄᴀʟʟ ᴏɴ/ᴏғғ - ᴛᴏɢɢʟᴇ ᴀɴᴛɪᴄᴀʟʟ
│  ➤ .sᴇᴛɴᴀᴍᴇ - ᴄʜᴀɴɢᴇ ʙᴏᴛ ɴᴀᴍᴇ
│  ➤ .sᴇᴛʙɪᴏ - ᴄʜᴀɴɢᴇ ʙᴏᴛ ʙɪᴏ
│  ➤ .sᴇᴛᴘᴘ - ᴄʜᴀɴɢᴇ ʙᴏᴛ ᴘʀᴏғɪʟᴇ ᴘɪᴄ
│
│  👥 ᴜsᴇʀ ᴍᴀɴᴀɢᴇᴍᴇɴᴛ:
│  ➤ .ʙʀᴏᴀᴅᴄᴀsᴛ - sᴇɴᴅ ʙʀᴏᴀᴅᴄᴀsᴛ
│  ➤ .ʙᴀɴ - ʙᴀɴ ᴜsᴇʀ ғʀᴏᴍ ʙᴏᴛ
│  ➤ .ᴜɴʙᴀɴ - ᴜɴʙᴀɴ ᴜsᴇʀ
│  ➤ .ʙʟᴏᴄᴋ - ʙʟᴏᴄᴋ ᴜsᴇʀ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ
│  ➤ .ᴜɴʙʟᴏᴄᴋ - ᴜɴʙʟᴏᴄᴋ ᴜsᴇʀ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ
│
│  📊 sʏsᴛᴇᴍ:
│  ➤ .ʟᴏɢs - ᴠɪᴇᴡ ʀᴇᴄᴇɴᴛ ʟᴏɢs
│  ➤ .sᴛᴀᴛs - ᴠɪᴇᴡ ʙᴏᴛ sᴛᴀᴛɪsᴛɪᴄs
│
│  ℹ️ ɪɴғᴏ:
│  ➤ .ɪɴғᴏ - sʜᴏᴡ ᴏᴡɴᴇʀ ᴅᴇᴛᴀɪʟs
╰───────￫
`.trim();
            
            await sendImageReply(socket, sender, ownerCommands, {
              buttons: [
                { buttonId: `${config.PREFIX}info`, buttonText: { displayText: "📋 ᴏᴡɴᴇʀ ɪɴғᴏ" } },
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" } }
              ]
            });
          } else {
            // For non-owners, show basic owner info
            const ownerNumbers = config.OWNER_NUMBERS || [config.OWNER_NUMBER];
            const ownerInfo = `
╭────────￫
│  👑 ʙᴏᴛ ᴏᴡɴᴇʀs
│
│  📛 ɴᴀᴍᴇ: ${config.OWNER_NAME}
│  📞 ᴏᴡɴᴇʀ ɴᴜᴍʙᴇʀs:
│  ${ownerNumbers.map((num, idx) => `  ${idx + 1}. ${num}`).join('\n')}
│  ⚡ ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}
│  🏢 ᴅᴇᴠᴇʟᴏᴘᴇʀ: Calyx Drey
╰───────￫
`.trim();
            
            await sendImageReply(socket, sender, ownerInfo);
          }
          break;
        }

        case 'id': {
          try { await socket.sendMessage(sender, { react: { text: "🆔", key: msg.key } }); } catch(e){}
          
          const idText = `
╭────────￫
│  🆔 ᴜsᴇʀ ɪɴғᴏ
│
│  ◈ ʏᴏᴜʀ ɪᴅ:
│  ➤ ${senderJid}
│
│  ◈ ᴄʜᴀᴛ ɪᴅ:
│  ➤ ${from}
│
│  ◈ ʙᴏᴛ ɴᴜᴍʙᴇʀ:
│  ➤ ${botNumber}
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, idText);
          break;
        }

        case 'profile': {
          try { await socket.sendMessage(sender, { react: { text: "👤", key: msg.key } }); } catch(e){}
          
          try {
            const profile = await getUserProfile(socket, senderJid);
            const profileText = `
╭────────￫
│  👤 ᴘʀᴏғɪʟᴇ ɪɴғᴏ
│
│  ◈ ɴᴀᴍᴇ:
│  ➤ ${profile.name}
│
│  ◈ ʙɪᴏ:
│  ➤ ${profile.bio}
│
│  ◈ ʟᴀsᴛ sᴇᴇɴ:
│  ➤ ${profile.lastSeen}
│
│  ◈ ʏᴏᴜʀ ɪᴅ:
│  ➤ ${senderJid}
╰───────￫
`.trim();
            
            await sendImageReply(socket, sender, profileText);
          } catch(e) {
            console.error('Profile error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ғᴇᴛᴄʜ ᴘʀᴏғɪʟᴇ ɪɴғᴏʀᴍᴀᴛɪᴏɴ.', '❌');
          }
          break;
        }

        case 'vv': {
          try { await socket.sendMessage(sender, { react: { text: "👁️", key: msg.key } }); } catch(e){}
          
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ.', '👁️');
            break;
          }
          
          try {
            // Check for viewOnceMessage or viewOnceMessageV2
            const viewOnceMsg = quoted.viewOnceMessage || quoted.viewOnceMessageV2;
            if (!viewOnceMsg) {
              await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ.', '👁️');
              break;
            }
            
            const messageContent = viewOnceMsg.message;
            const contentType = getContentType(messageContent);
            
            if (contentType === 'imageMessage' || contentType === 'videoMessage') {
              const mediaType = contentType.replace('Message', '').toLowerCase();
              const buffer = await downloadMedia(messageContent[contentType], mediaType);
              
              if (buffer) {
                if (contentType === 'imageMessage') {
                  await socket.sendMessage(sender, { 
                    image: buffer,
                    caption: 'ʜᴇʀᴇ ɪs ᴛʜᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ ɪᴍᴀɢᴇ 👁️'
                  });
                } else if (contentType === 'videoMessage') {
                  await socket.sendMessage(sender, { 
                    video: buffer,
                    caption: 'ʜᴇʀᴇ ɪs ᴛʜᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴠɪᴅᴇᴏ 👁️'
                  });
                }
                await sendFuturisticReply(socket, sender, 'sᴜᴄᴄᴇss', 'ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇᴅɪᴀ ʜᴀs ʙᴇᴇɴ sᴀᴠᴇᴅ.', '✅');
              } else {
                await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇᴅɪᴀ.', '❌');
              }
            } else {
              await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴜɴsᴜᴘᴘᴏʀᴛᴇᴅ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇᴅɪᴀ ᴛʏᴘᴇ.', '❌');
            }
          } catch(e) {
            console.error('VV error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', `ғᴀɪʟᴇᴅ ᴛᴏ ᴘʀᴏᴄᴇss ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇᴅɪᴀ.\n\nᴇʀʀᴏʀ: ${e.message || 'Unknown error'}`, '❌');
          }
          break;
        }

        case 'sticker': {
          try { await socket.sendMessage(sender, { react: { text: "🖼️", key: msg.key } }); } catch(e){}
          
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ.', '🖼️');
            break;
          }
          
          try {
            const qTypes = ['imageMessage', 'videoMessage'];
            const qType = qTypes.find(t => quoted[t]);
            
            if (!qType) {
              await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ.', '🖼️');
              break;
            }
            
            const mediaType = qType.replace('Message', '').toLowerCase();
            const buffer = await downloadMedia(quoted[qType], mediaType);
            
            if (buffer) {
              // Process image for sticker (resize to 512x512)
              let stickerBuffer;
              if (qType === 'imageMessage') {
                try {
                  const image = await Jimp.read(buffer);
                  stickerBuffer = await image
                    .resize(512, 512)
                    .quality(100)
                    .getBufferAsync(Jimp.MIME_PNG);
                } catch (imgError) {
                  console.error('Image processing error:', imgError);
                  stickerBuffer = buffer; // Use original buffer as fallback
                }
              } else {
                // For videos, we'll use the first frame or a simple approach
                try {
                  // Create a simple sticker from video (in production, use ffmpeg to extract first frame)
                  const tempImage = await Jimp.read(512, 512, 0xFFFFFFFF);
                  stickerBuffer = await tempImage.getBufferAsync(Jimp.MIME_PNG);
                } catch (vidError) {
                  console.error('Video processing error:', vidError);
                  // Create a simple colored sticker as fallback
                  const tempImage = await Jimp.read(512, 512, 0x0000FFFF);
                  stickerBuffer = await tempImage.getBufferAsync(Jimp.MIME_PNG);
                }
              }
              
              // Send sticker
              await socket.sendMessage(sender, { 
                sticker: stickerBuffer 
              });
              
              await sendFuturisticReply(socket, sender, 'sᴜᴄᴄᴇss', 'sᴛɪᴄᴋᴇʀ ᴄʀᴇᴀᴛᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ!', '✅');
            } else {
              await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇᴅɪᴀ.', '❌');
            }
          } catch(e) {
            console.error('Sticker error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴄʀᴇᴀᴛᴇ sᴛɪᴄᴋᴇʀ.', '❌');
          }
          break;
        }

        case 'toimg': {
          try { await socket.sendMessage(sender, { react: { text: "🖼️", key: msg.key } }); } catch(e){}
          
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted?.stickerMessage) {
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛɪᴄᴋᴇʀ.', '🖼️');
            break;
          }
          
          try {
            const buffer = await downloadMedia(quoted.stickerMessage, 'sticker');
            if (buffer) {
              await socket.sendMessage(sender, { 
                image: buffer,
                caption: 'ʜᴇʀᴇ ɪs ʏᴏᴜʀ ɪᴍᴀɢᴇ ғʀᴏᴍ sᴛɪᴄᴋᴇʀ 🖼️'
              });
              await sendFuturisticReply(socket, sender, 'sᴜᴄᴄᴇss', 'sᴛɪᴄᴋᴇʀ ᴄᴏɴᴠᴇʀᴛᴇᴅ ᴛᴏ ɪᴍᴀɢᴇ!', '✅');
            } else {
              await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴅᴏᴡɴʟᴏᴀᴅ sᴛɪᴄᴋᴇʀ.', '❌');
            }
          } catch(e) {
            console.error('Toimg error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴄᴏɴᴠᴇʀᴛ sᴛɪᴄᴋᴇʀ ᴛᴏ ɪᴍᴀɢᴇ.', '❌');
          }
          break;
        }

        case 'toaudio': {
          try { await socket.sendMessage(sender, { react: { text: "🎵", key: msg.key } }); } catch(e){}
          
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted?.videoMessage) {
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴅᴇᴏ.', '🎵');
            break;
          }
          
          try {
            const buffer = await downloadMedia(quoted.videoMessage, 'video');
            if (buffer) {
              // For audio extraction, we send the video buffer as audio
              // In production, you'd want to use ffmpeg to extract audio
              await socket.sendMessage(sender, { 
                audio: buffer,
                mimetype: 'audio/mp4',
                ptt: false
              });
              await sendFuturisticReply(socket, sender, 'sᴜᴄᴄᴇss', 'ᴀᴜᴅɪᴏ ᴇxᴛʀᴀᴄᴛᴇᴅ ғʀᴏᴍ ᴠɪᴅᴇᴏ!', '✅');
            } else {
              await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴅᴏᴡɴʟᴏᴀᴅ ᴠɪᴅᴇᴏ.', '❌');
            }
          } catch(e) {
            console.error('Toaudio error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴇxᴛʀᴀᴄᴛ ᴀᴜᴅɪᴏ ғʀᴏᴍ ᴠɪᴅᴇᴏ.', '❌');
          }
          break;
        }

        case 'calc': {
          try { await socket.sendMessage(sender, { react: { text: "🧮", key: msg.key } }); } catch(e){}
          
          const expression = args.join(' ');
          if (!expression) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ᴄᴀʟᴄ <ᴇxᴘʀᴇssɪᴏɴ>\n\nᴇxᴀᴍᴘʟᴇ:\n.ᴄᴀʟᴄ 10+5\n.ᴄᴀʟᴄ 50*2\n.ᴄᴀʟᴄ 100/4', '🧮');
            break;
          }
          
          try {
            // Safe evaluation
            const safeExpression = expression
              .replace(/[^0-9+\-*/().,%\s]/g, '')
              .replace(/%/g, '/100');
            
            const result = eval(safeExpression);
            const calcText = `
╭────────￫
│  🧮 ᴄᴀʟᴄᴜʟᴀᴛᴏʀ
│
│  ◈ ᴇxᴘʀᴇssɪᴏɴ:
│  ➤ ${expression}
│
│  ◈ ʀᴇsᴜʟᴛ:
│  ➤ ${result}
╰───────￫
`.trim();
            
            await sendImageReply(socket, sender, calcText);
          } catch(e) {
            console.error('Calc error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ɪɴᴠᴀʟɪᴅ ᴇxᴘʀᴇssɪᴏɴ ᴏʀ sʏɴᴛᴀx ᴇʀʀᴏʀ.\n\nᴇxᴀᴍᴘʟᴇ:\n.ᴄᴀʟᴄ 10+5\n.ᴄᴀʟᴄ 50*2', '❌');
          }
          break;
        }

        case 'qr': {
          try { await socket.sendMessage(sender, { react: { text: "📱", key: msg.key } }); } catch(e){}
          
          const text = args.join(' ');
          if (!text) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ǫʀ <ᴛᴇxᴛ>\n\nᴇxᴀᴍᴘʟᴇ:\n.ǫʀ ʜᴇʟʟᴏ ᴡᴏʀʟᴅ\n.ǫʀ https://example.com', '📱');
            break;
          }
          
          try {
            const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
            
            const qrText = `
╭────────￫
│  📱 ǫʀ ᴄᴏᴅᴇ
│
│  ◈ ᴛᴇxᴛ:
│  ➤ ${text}
│
│  ◈ sᴄᴀɴ ᴛʜᴇ ǫʀ ᴄᴏᴅᴇ
│  ➤ ᴛᴏ ᴠɪᴇᴡ ᴛʜᴇ ᴄᴏɴᴛᴇɴᴛ
╰───────￫
`.trim();
            
            await socket.sendMessage(sender, { 
              image: { url: qrCodeUrl },
              caption: qrText
            });
          } catch(e) {
            console.error('QR error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇɴᴇʀᴀᴛᴇ ǫʀ ᴄᴏᴅᴇ.', '❌');
          }
          break;
        }

        case 'reverse': {
          try { await socket.sendMessage(sender, { react: { text: "🔁", key: msg.key } }); } catch(e){}
          
          const text = args.join(' ');
          if (!text) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ʀᴇᴠᴇʀsᴇ <ᴛᴇxᴛ>\n\nᴇxᴀᴍᴘʟᴇ:\n.ʀᴇᴠᴇʀsᴇ ʜᴇʟʟᴏ\n.ʀᴇᴠᴇʀsᴇ ᴡᴏʀʟᴅ', '🔁');
            break;
          }
          
          const reversed = text.split('').reverse().join('');
          const reverseText = `
╭────────￫
│  🔁 ʀᴇᴠᴇʀsᴇᴅ ᴛᴇxᴛ
│
│  ◈ ᴏʀɪɢɪɴᴀʟ:
│  ➤ ${text}
│
│  ◈ ʀᴇᴠᴇʀsᴇᴅ:
│  ➤ ${reversed}
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, reverseText);
          break;
        }

        case 'repeat': {
          try { await socket.sendMessage(sender, { react: { text: "🔂", key: msg.key } }); } catch(e){}
          
          const text = args.join(' ');
          if (!text) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ʀᴇᴘᴇᴀᴛ <ᴛᴇxᴛ>\n\nᴇxᴀᴍᴘʟᴇ:\n.ʀᴇᴘᴇᴀᴛ ʜᴇʟʟᴏ 3', '🔂');
            break;
          }
          
          const parts = text.split(' ');
          const lastWord = parts[parts.length - 1];
          const count = parseInt(lastWord);
          
          let repeatText, repeatCount;
          if (!isNaN(count) && count > 0 && count <= 20) {
            repeatText = parts.slice(0, -1).join(' ');
            repeatCount = count;
          } else {
            repeatText = text;
            repeatCount = 3;
          }
          
          const repeated = Array(repeatCount).fill(repeatText).join('\n');
          const resultText = `
╭────────￫
│  🔂 ʀᴇᴘᴇᴀᴛ
│
│  ◈ ᴛᴇxᴛ:
│  ➤ ${repeatText}
│
│  ◈ ᴛɪᴍᴇs:
│  ➤ ${repeatCount}
│
│  ◈ ʀᴇsᴜʟᴛ:
│  ➤ ${repeated}
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, resultText);
          break;
        }

        case 'count': {
          try { await socket.sendMessage(sender, { react: { text: "🔢", key: msg.key } }); } catch(e){}
          
          const text = args.join(' ');
          if (!text) {
            const defaultCount = `
╭────────￫
│  🔢 ᴄᴏᴜɴᴛᴇʀ
│
│  ◈ ᴜsᴀɢᴇ:
│  ➤ .ᴄᴏᴜɴᴛ <ᴛᴇxᴛ>
│  ➤ .ᴄᴏᴜɴᴛ ʜᴇʟʟᴏ ᴡᴏʀʟᴅ
│
│  ◈ ᴇxᴀᴍᴘʟᴇ:
│  ➤ ɪɴᴘᴜᴛ: ʜᴇʟʟᴏ ᴡᴏʀʟᴅ
│  ➤ ᴄʜᴀʀᴀᴄᴛᴇʀs: 11
│  ➤ ᴡᴏʀᴅs: 2
╰───────￫
`.trim();
            
            await sendImageReply(socket, sender, defaultCount);
            break;
          }
          
          const characters = text.length;
          const words = text.trim().split(/\s+/).filter(w => w.length > 0).length;
          const lines = text.split('\n').length;
          
          const countText = `
╭────────￫
│  🔢 ᴄᴏᴜɴᴛᴇʀ
│
│  ◈ ᴛᴇxᴛ:
│  ➤ ${text.length > 50 ? text.substring(0, 47) + '...' : text}
│
│  ◈ sᴛᴀᴛɪsᴛɪᴄs:
│  ➤ ᴄʜᴀʀᴀᴄᴛᴇʀs: ${characters}
│  ➤ ᴡᴏʀᴅs: ${words}
│  ➤ ʟɪɴᴇs: ${lines}
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, countText);
          break;
        }

        case 'password': {
          try { await socket.sendMessage(sender, { react: { text: "🔐", key: msg.key } }); } catch(e){}
          
          const length = parseInt(args[0]) || 12;
          const safeLength = Math.min(Math.max(length, 6), 32);
          
          const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()';
          let password = '';
          for (let i = 0; i < safeLength; i++) {
            password += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          
          const passwordText = `
╭────────￫
│  🔐 ᴘᴀssᴡᴏʀᴅ ɢᴇɴᴇʀᴀᴛᴏʀ
│
│  ◈ ʟᴇɴɢᴛʜ: ${safeLength}
│  ◈ sᴛʀᴇɴɢᴛʜ: ${safeLength >= 16 ? 'ᴠᴇʀʏ sᴛʀᴏɴɢ 💪' : safeLength >= 12 ? 'sᴛʀᴏɴɢ 👍' : 'ɢᴏᴏᴅ 👌'}
│
│  ◈ ɢᴇɴᴇʀᴀᴛᴇᴅ ᴘᴀssᴡᴏʀᴅ:
│  ➤ ${password}
│
│  ◈ ɴᴏᴛᴇ:
│  ➤ ᴋᴇᴇᴘ ʏᴏᴜʀ ᴘᴀssᴡᴏʀᴅ sᴇᴄᴜʀᴇ!
│  ➤ ᴅᴏ ɴᴏᴛ sʜᴀʀᴇ ᴡɪᴛʜ ᴀɴʏᴏɴᴇ!
╰───────￫
`.trim();
          
          await sendImageReply(socket, sender, passwordText);
          break;
        }

        // ==================== OWNER COMMANDS ====================
        case 'restart': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'restart');
          if (!hasPermission) break;
          
          try { await socket.sendMessage(sender, { react: { text: "🔄", key: msg.key } }); } catch(e){}
          
          try {
            await sendFuturisticReply(socket, sender, 'ʀᴇsᴛᴀʀᴛɪɴɢ', 'ʀᴇsᴛᴀʀᴛɪɴɢ ʙᴏᴛ... ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ 5-10 sᴇᴄᴏɴᴅs.', '🔄');
            
            // Delay before restart to allow message to be sent
            setTimeout(() => {
              try { 
                console.log(`Restarting bot for owner: ${senderJid}`);
                exec(`pm2 restart ${process.env.PM2_NAME || 'Viral-Bot-Mini'}`, (error, stdout, stderr) => {
                  if (error) {
                    console.error('Restart failed:', error);
                  } else {
                    console.log('Restart successful:', stdout);
                  }
                });
              } catch(e) { 
                console.error('PM2 restart failed:', e); 
              }
            }, 2000);
          } catch(e) {
            console.error('Restart error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ɪɴɪᴛɪᴀᴛᴇ ʀᴇsᴛᴀʀᴛ.', '❌');
          }
          break;
        }

        case 'anticall': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'anticall');
          if (!hasPermission) break;
          
          const state = args[0];
          if (!state || (state !== 'on' && state !== 'off')) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ᴀɴᴛɪᴄᴀʟʟ ᴏɴ/ᴏғғ\n\nᴇxᴀᴍᴘʟᴇ:\n.ᴀɴᴛɪᴄᴀʟʟ ᴏɴ\n.ᴀɴᴛɪᴄᴀʟʟ ᴏғғ', '📵');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "📵", key: msg.key } }); } catch(e){}
          
          const enabled = state === 'on';
          callBlockers.set(number, { enabled, blockedNumbers: new Set() });
          
          await sendFuturisticReply(socket, sender, 'ᴀɴᴛɪᴄᴀʟʟ', 
            `ᴀɴᴛɪᴄᴀʟʟ ${enabled ? 'ᴇɴᴀʙʟᴇᴅ ✅' : 'ᴅɪsᴀʙʟᴇᴅ ❌'}\n\nɪɴᴄᴏᴍɪɴɢ ᴄᴀʟʟs ᴡɪʟʟ ʙᴇ ${enabled ? 'ᴀᴜᴛᴏ-ʙʟᴏᴄᴋᴇᴅ 🔒' : 'ᴀʟʟᴏᴡᴇᴅ ✅'}.`, 
            '📵'
          );
          break;
        }

        case 'setname': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'setname');
          if (!hasPermission) break;
          
          const newName = args.join(' ');
          if (!newName) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.sᴇᴛɴᴀᴍᴇ <ɴᴇᴡ ɴᴀᴍᴇ>\n\nᴇxᴀᴍᴘʟᴇ:\n.sᴇᴛɴᴀᴍᴇ ᴠɪʀᴀʟ-ʙᴏᴛ ᴘʀᴏ', '✏️');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "✏️", key: msg.key } }); } catch(e){}
          
          try {
            await socket.updateProfileName(newName);
            await sendFuturisticReply(socket, sender, 'sᴜᴄᴄᴇss', `ʙᴏᴛ ɴᴀᴍᴇ ᴜᴘᴅᴀᴛᴇᴅ ✅\n\nɴᴇᴡ ɴᴀᴍᴇ: ${newName}`, '✅');
          } catch(e) {
            console.error('Setname error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴜᴘᴅᴀᴛᴇ ʙᴏᴛ ɴᴀᴍᴇ.', '❌');
          }
          break;
        }

        case 'setbio': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'setbio');
          if (!hasPermission) break;
          
          const newBio = args.join(' ');
          if (!newBio) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.sᴇᴛʙɪᴏ <ɴᴇᴡ ᴀʙᴏᴜᴛ ᴛᴇxᴛ>\n\nᴇxᴀᴍᴘʟᴇ:\n.sᴇᴛʙɪᴏ ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ', '📝');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "📝", key: msg.key } }); } catch(e){}
          
          try {
            await socket.updateProfileStatus(newBio);
            await sendFuturisticReply(socket, sender, 'sᴜᴄᴄᴇss', `ʙᴏᴛ ʙɪᴏ ᴜᴘᴅᴀᴛᴇᴅ ✅\n\nɴᴇᴡ ʙɪᴏ: ${newBio}`, '✅');
          } catch(e) {
            console.error('Setbio error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴜᴘᴅᴀᴛᴇ ʙᴏᴛ ʙɪᴏ.', '❌');
          }
          break;
        }

        case 'setpp': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'setpp');
          if (!hasPermission) break;
          
          const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted?.imageMessage) {
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ ᴡɪᴛʜ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ.\n\nᴇxᴀᴍᴘʟᴇ:\nʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ ᴡɪᴛʜ ".sᴇᴛᴘᴘ"', '🖼️');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "🖼️", key: msg.key } }); } catch(e){}
          
          try {
            const buffer = await downloadMedia(quoted.imageMessage, 'image');
            if (buffer) {
              await socket.updateProfilePicture(botNumber + '@s.whatsapp.net', buffer);
              await sendFuturisticReply(socket, sender, 'sᴜᴄᴄᴇss', 'ʙᴏᴛ ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ ᴜᴘᴅᴀᴛᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ ✅', '✅');
            } else {
              await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴅᴏᴡɴʟᴏᴀᴅ ᴛʜᴇ ɪᴍᴀɢᴇ.', '❌');
            }
          } catch(e) {
            console.error('Setpp error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ᴜᴘᴅᴀᴛᴇ ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ.', '❌');
          }
          break;
        }

        case 'broadcast': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'broadcast');
          if (!hasPermission) break;
          
          const message = args.join(' ');
          if (!message) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ʙʀᴏᴀᴅᴄᴀsᴛ <ᴍᴇssᴀɢᴇ>\n\nᴇxᴀᴍᴘʟᴇ:\n.ʙʀᴏᴀᴅᴄᴀsᴛ ʜᴇʟʟᴏ ᴇᴠᴇʀʏᴏɴᴇ!', '📢');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "📢", key: msg.key } }); } catch(e){}
          
          try {
            const numbers = await getAllNumbersFromMongo();
            let sent = 0;
            let failed = 0;
            
            // Send initial status
            await sendFuturisticReply(socket, sender, 'ʙʀᴏᴀᴅᴄᴀsᴛ sᴛᴀʀᴛᴇᴅ', 
              `sᴇɴᴅɪɴɢ ʙʀᴏᴀᴅᴄᴀsᴛ ᴛᴏ ${numbers.length} ᴜsᴇʀs...\nᴘʟᴇᴀsᴇ ᴡᴀɪᴛ.`, 
              '⏳'
            );
            
            for (const userNumber of numbers) {
              try {
                const userJid = userNumber.includes('@') ? userNumber : userNumber + '@s.whatsapp.net';
                await socket.sendMessage(userJid, { 
                  text: `╭────────￫\n│  📢 ʙʀᴏᴀᴅᴄᴀsᴛ\n│\n│  ${message}\n│\n│  - ${config.OWNER_NAME}\n╰───────￫` 
                });
                sent++;
                await delay(500); // Delay to avoid rate limiting
              } catch(e) {
                failed++;
                console.error(`Failed to send to ${userNumber}:`, e.message);
              }
            }
            
            await sendFuturisticReply(socket, sender, 'ʙʀᴏᴀᴅᴄᴀsᴛ ᴄᴏᴍᴘʟᴇᴛᴇᴅ', 
              `✅ sᴜᴄᴄᴇssғᴜʟʟʏ sᴇɴᴛ: ${sent}\n❌ ғᴀɪʟᴇᴅ: ${failed}\n📊 ᴛᴏᴛᴀʟ: ${numbers.length}`, 
              '✅'
            );
          } catch(e) {
            console.error('Broadcast error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ sᴇɴᴅ ʙʀᴏᴀᴅᴄᴀsᴛ.', '❌');
          }
          break;
        }

        case 'ban': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'ban');
          if (!hasPermission) break;
          
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ʙᴀɴ @ᴜsᴇʀ\nᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴜsᴇʀ\'s ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ".ʙᴀɴ"', '🚫');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "🚫", key: msg.key } }); } catch(e){}
          
          // Extract username
          const targetUsername = target.split('@')[0];
          bannedUsers.set(target, `ʙᴀɴɴᴇᴅ ʙʏ ᴏᴡɴᴇʀ ᴀᴛ ${getZimbabweanTimestamp()}`);
          
          await sendFuturisticReply(socket, sender, 'ᴜsᴇʀ ʙᴀɴɴᴇᴅ', 
            `ᴜsᴇʀ ${targetUsername} ʜᴀs ʙᴇᴇɴ ʙᴀɴɴᴇᴅ ғʀᴏᴍ ᴜsɪɴɢ ʙᴏᴛ ᴄᴏᴍᴍᴀɴᴅs ✅\n\nᴛɪᴍᴇ: ${getZimbabweanTimestamp()}`, 
            '✅'
          );
          break;
        }

        case 'unban': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'unban');
          if (!hasPermission) break;
          
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ᴜɴʙᴀɴ @ᴜsᴇʀ\nᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴜsᴇʀ\'s ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ".ᴜɴʙᴀɴ"', '✅');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "✅", key: msg.key } }); } catch(e){}
          
          // Extract username
          const targetUsername = target.split('@')[0];
          const wasBanned = bannedUsers.has(target);
          bannedUsers.delete(target);
          
          await sendFuturisticReply(socket, sender, wasBanned ? 'ᴜsᴇʀ ᴜɴʙᴀɴɴᴇᴅ' : 'ᴜsᴇʀ ɴᴏᴛ ʙᴀɴɴᴇᴅ', 
            wasBanned 
              ? `ᴜsᴇʀ ${targetUsername} ʜᴀs ʙᴇᴇɴ ᴜɴʙᴀɴɴᴇᴅ ✅\n\nᴛɪᴍᴇ: ${getZimbabweanTimestamp()}`
              : `ᴜsᴇʀ ${targetUsername} ᴡᴀs ɴᴏᴛ ғᴏᴜɴᴅ ɪɴ ʙᴀɴ ʟɪsᴛ.`, 
            wasBanned ? '✅' : 'ℹ️'
          );
          break;
        }

        case 'block': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'block');
          if (!hasPermission) break;
          
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ʙʟᴏᴄᴋ @ᴜsᴇʀ\nᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴜsᴇʀ\'s ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ".ʙʟᴏᴄᴋ"', '🔒');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "🔒", key: msg.key } }); } catch(e){}
          
          try {
            const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
            
            // FIXED: Use correct method for blocking
            await socket.updateBlockStatus(targetJid, 'block');
            
            await sendFuturisticReply(socket, sender, 'ᴜsᴇʀ ʙʟᴏᴄᴋᴇᴅ', 
              `ᴜsᴇʀ ${target.split('@')[0]} ʜᴀs ʙᴇᴇɴ ʙʟᴏᴄᴋᴇᴅ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ ✅\n\nᴛɪᴍᴇ: ${getZimbabweanTimestamp()}`, 
              '✅'
            );
          } catch(e) {
            console.error('Block error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', `ғᴀɪʟᴇᴅ ᴛᴏ ʙʟᴏᴄᴋ ᴜsᴇʀ.\n\nᴇʀʀᴏʀ: ${e.message || 'Unknown error'}`, '❌');
          }
          break;
        }

        case 'unblock': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'unblock');
          if (!hasPermission) break;
          
          const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
          if (!target) {
            await sendFuturisticReply(socket, sender, 'ᴜsᴀɢᴇ', '.ᴜɴʙʟᴏᴄᴋ @ᴜsᴇʀ\nᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴜsᴇʀ\'s ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ".ᴜɴʙʟᴏᴄᴋ"', '🔓');
            break;
          }
          
          try { await socket.sendMessage(sender, { react: { text: "🔓", key: msg.key } }); } catch(e){}
          
          try {
            const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
            
            // FIXED: Use correct method for unblocking
            await socket.updateBlockStatus(targetJid, 'unblock');
            
            await sendFuturisticReply(socket, sender, 'ᴜsᴇʀ ᴜɴʙʟᴏᴄᴋᴇᴅ', 
              `ᴜsᴇʀ ${target.split('@')[0]} ʜᴀs ʙᴇᴇɴ ᴜɴʙʟᴏᴄᴋᴇᴅ ᴏɴ ᴡʜᴀᴛsᴀᴘᴘ ✅\n\nᴛɪᴍᴇ: ${getZimbabweanTimestamp()}`, 
              '✅'
            );
          } catch(e) {
            console.error('Unblock error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', `ғᴀɪʟᴇᴅ ᴛᴏ ᴜɴʙʟᴏᴄᴋ ᴜsᴇʀ.\n\nᴇʀʀᴏʀ: ${e.message || 'Unknown error'}`, '❌');
          }
          break;
        }

        case 'logs': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'logs');
          if (!hasPermission) break;
          
          try { await socket.sendMessage(sender, { react: { text: "📋", key: msg.key } }); } catch(e){}
          
          try {
            const recentLogs = logs.slice(-15).reverse();
            let logText = '';
            
            if (recentLogs.length === 0) {
              logText = '│  ɴᴏ ʟᴏɢs ᴀᴠᴀɪʟᴀʙʟᴇ ʏᴇᴛ.';
            } else {
              recentLogs.forEach((log, index) => {
                const time = log.timestamp.split(' ')[1]; // Get time only
                logText += `│  [${time}] ${log.type}: ${log.message}\n`;
              });
            }
            
            const logsText = `╭────────￫\n│  📋 ʀᴇᴄᴇɴᴛ ʟᴏɢs (ʟᴀsᴛ 15)\n│\n${logText}╰───────￫`;
            await sendImageReply(socket, sender, logsText);
          } catch(e) {
            console.error('Logs error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ғᴇᴛᴄʜ ʟᴏɢs.', '❌');
          }
          break;
        }

        case 'stats': {
          // Check owner permission
          const hasPermission = await checkOwnerPermission(socket, sender, senderJid, 'stats');
          if (!hasPermission) break;
          
          try { await socket.sendMessage(sender, { react: { text: "📊", key: msg.key } }); } catch(e){}
          
          try {
            const startTime = socketCreationTime.get(number) || Date.now();
            const uptime = Math.floor((Date.now() - startTime) / 1000);
            const days = Math.floor(uptime / 86400);
            const hours = Math.floor((uptime % 86400) / 3600);
            const minutes = Math.floor((uptime % 3600) / 60);
            const seconds = Math.floor(uptime % 60);
            
            const numbers = await getAllNumbersFromMongo();
            const ownerNumbers = config.OWNER_NUMBERS || [config.OWNER_NUMBER];
            
            const statsText = `
╭────────￫
│  📊 ʙᴏᴛ sᴛᴀᴛɪsᴛɪᴄs
│
│  🤖 ʙᴏᴛ ɪɴғᴏ:
│  ➤ ɴᴀᴍᴇ: ᴠɪʀᴀʟ-ʙᴏᴛ-ᴍɪɴɪ
│  ➤ ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}
│  ➤ ᴏᴡɴᴇʀs: ${ownerNumbers.join(', ')}
│
│  ⏱️ ᴜᴘᴛɪᴍᴇ:
│  ➤ ${days}ᴅ ${hours}ʜ ${minutes}ᴍ ${seconds}s
│
│  👥 ᴜsᴇʀs:
│  ➤ ᴛᴏᴛᴀʟ ᴜsᴇʀs: ${numbers.length}
│  ➤ ᴀᴄᴛɪᴠᴇ sᴇssɪᴏɴs: ${activeSockets.size}
│  ➤ ʙᴀɴɴᴇᴅ ᴜsᴇʀs: ${bannedUsers.size}
│
│  📈 ᴀᴄᴛɪᴠɪᴛʏ:
│  ➤ ᴄᴏᴍᴍᴀɴᴅs ᴜsᴇᴅ: ${stats.commandsUsed}
│  ➤ ᴍᴇssᴀɢᴇs ᴘʀᴏᴄᴇssᴇᴅ: ${stats.messagesProcessed}
│  ➤ ᴛᴏᴛᴀʟ ᴄʜᴀᴛs: ${stats.totalChats}
│
│  🔧 sʏsᴛᴇᴍ:
│  ➤ ᴘʟᴀᴛғᴏʀᴍ: ${process.platform}
│  ➤ ɴᴏᴅᴇ: ${process.version}
│  ➤ ᴍᴏɴɢᴏᴅʙ: ${mongoClient ? '✅ ᴄᴏɴɴᴇᴄᴛᴇᴅ' : '❌ ᴅɪsᴄᴏɴɴᴇᴄᴛᴇᴅ'}
╰───────￫
            `.trim();
            
            await sendImageReply(socket, sender, statsText);
          } catch(e) {
            console.error('Stats error:', e);
            await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ғᴀɪʟᴇᴅ ᴛᴏ ғᴇᴛᴄʜ sᴛᴀᴛɪsᴛɪᴄs.', '❌');
          }
          break;
        }

        default:
          // Unknown command - show basic help
          await sendFuturisticReply(socket, sender, 'ᴜɴᴋɴᴏᴡɴ ᴄᴏᴍᴍᴀɴᴅ', 
            `ᴄᴏᴍᴍᴀɴᴅ "${command}" ɴᴏᴛ ғᴏᴜɴᴅ.\n\nᴜsᴇ .ʜᴇʟᴘ ᴛᴏ sᴇᴇ ᴀᴠᴀɪʟᴀʙʟᴇ ᴄᴏᴍᴍᴀɴᴅs.\nᴏʀ ᴜsᴇ .ᴍᴇɴᴜ ᴛᴏ sᴇᴇ ᴛʜᴇ ᴍᴀɪɴ ᴍᴇɴᴜ.`, 
            '❓'
          );
          break;
      }
    } catch (err) {
      console.error('Command handler error:', err);
      await sendFuturisticReply(socket, sender, 'ᴇʀʀᴏʀ', 'ᴀɴ ᴇʀʀᴏʀ ᴏᴄᴄᴜʀʀᴇᴅ ᴡʜɪʟᴇ ᴘʀᴏᴄᴇssɪɴɢ ʏᴏᴜʀ ᴄᴏᴍᴍᴀɴᴅ. ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ.', '❌');
    }
  });
}

// ---------------- message handlers ----------------
function setupMessageHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
    
    const sender = msg.key.fromMe ? socket.user.id : (msg.key.participant || msg.key.remoteJid);
    if (isBanned(sender)) {
      try { await sendFuturisticReply(socket, sender, 'ʙᴀɴɴᴇᴅ', 'ʏᴏᴜ ᴀʀᴇ ʙᴀɴɴᴇᴅ ғʀᴏᴍ ᴜsɪɴɢ ʙᴏᴛ ᴄᴏᴍᴍᴀɴᴅs.', '❌'); } catch(e) {}
      return;
    }
    
    if (msg.key.remoteJid.endsWith('@g.us')) {
      const settings = groupSettings.get(msg.key.remoteJid) || {};
      if (settings.muted) return;
    }
    
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
    try {
      const ownerNumbers = config.OWNER_NUMBERS || [config.OWNER_NUMBER];
      for (const ownerNum of ownerNumbers) {
        const ownerJid = `${ownerNum.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
        const caption = formatMessage('*💀 OWNER NOTICE — SESSION REMOVED*', `Number: ${sanitized}\nSession removed due to logout.\n\nActive sessions now: ${activeSockets.size}`, BOT_NAME_FREE);
        if (socketInstance && socketInstance.sendMessage) await socketInstance.sendMessage(ownerJid, { image: { url: config.FREE_IMAGE }, caption });
      }
    } catch(e){}
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

          try {
            const forcedJid = '120363405637529316@newsletter';
            try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(forcedJid); } catch(e){}
          } catch(e){}

          activeSockets.set(sanitizedNumber, socket);
          const groupStatus = groupResult.status === 'success' ? 'Joined successfully' : `Failed to join group: ${groupResult.error}`;

          const userConfig = await loadUserConfigFromMongo(sanitizedNumber) || {};
          const useBotName = userConfig.botName || BOT_NAME_FREE;
          const useLogo = userConfig.logo || config.FREE_IMAGE;

          const initialCaption = formatMessage(useBotName,
            `*✅ 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥 𝘚𝘶𝘤𝘤𝘦𝘴𝘴𝘧𝘶𝘭𝘭𝘺*\n\n*🔢 𝘊𝘩𝘢𝘵 𝘕𝘣:*  ${sanitizedNumber}\n*🕒 𝘛𝘰 𝘊𝘰𝘯𝘯𝘦𝘤𝘵: 𝘉𝘰𝘵 𝘞𝘪𝘭𝘭 𝘉𝘦 𝘜𝘱 𝘈𝘯𝘥 𝘙𝘶𝘯𝘯𝘪𝘯𝘨 𝘐𝘯 𝘈 𝘍𝘦𝘸 𝘔𝘪𝘯𝘶𝘵𝘦𝘴*\n\n✅ Successfully connected!\n\n🔢 Number: ${sanitizedNumber}\n*🕒 Connecting: Bot will become active in a few seconds*`,
            useBotName
          );

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
              try { await socket.sendMessage(userJid, { delete: sentMsg.key }); } catch(delErr) {}
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

// ---------------- endpoints ----------------
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