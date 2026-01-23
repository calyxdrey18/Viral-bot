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
  NEWSLETTER_JID: '120363405637529316@newsletter', // replace with your own newsletter its the main newsletter
  
  // ✅ SUPPORT/VALIDATION NEWSLETTER ( recommended) 
  // this will not affect anything..its just for supporting the dev channel
  // Users add this to show support and get updates
  SUPPORT_NEWSLETTER: {
    jid: '120363405637529316@newsletter',  // Your channel
    emojis: ['❤️', '🌟', '🔥', '💯'],  // Support emojis
    name: 'Viral-Bot-Mini',
    description: 'Bot updates & support channel by Calyx Drey'
  },
  
  // ✅ Default newsletters
  DEFAULT_NEWSLETTERS: [
    { 
      jid: '120363405637529316@newsletter',  // Your channel
      emojis: ['❤️', '🌟', '🔥', '💯'],
      name: 'Viral-Bot-Mini', 
      description: 'Official Channel'
    }
  ],
  
  OTP_EXPIRY: 300000,
  OWNER_NUMBER: process.env.OWNER_NUMBER || '263786624966',
  CHANNEL_LINK: 'https://whatsapp.com/channel/0029VbCGIzTJkK7C0wtGy31s',
  BOT_NAME: 'Viral-Bot-Mini',
  BOT_VERSION: '1.0.beta',
  OWNER_NAME: 'Wesley',
  IMAGE_PATH: 'https://chat.whatsapp.com/Dh7gxX9AoVD8gsgWUkhB9r',
  BOT_FOOTER: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
  BUTTON_IMAGES: { ALIVE: 'https://i.postimg.cc/tg7spkqh/bot-img.png' }
};

// ==================== IN-MEMORY STORAGE FOR NEW FEATURES ====================
const bannedUsers = new Map(); // userJid -> reason
const groupSettings = new Map(); // groupJid -> {muted: boolean, welcome: boolean, goodbye: boolean, rules: string, locked: boolean}
const stats = {
    totalUsers: 0,
    totalChats: 0,
    commandsUsed: 0,
    messagesProcessed: 0
};
const logs = []; // {timestamp: string, type: string, message: string}
const callBlockers = new Map(); // number -> {enabled: boolean, blockedNumbers: Set}
const userProfileCache = new Map(); // userJid -> {name: string, bio: string, lastSeen: string}

// Helper: Add to logs
function addLog(type, message) {
    logs.push({
        timestamp: getZimbabweanTimestamp(),
        type,
        message
    });
    // Keep only last 100 logs
    if (logs.length > 100) logs.shift();
}

// Helper: Check if user is banned
function isBanned(userJid) {
    return bannedUsers.has(userJid);
}

// Helper: Check if sender is group admin
async function isGroupAdmin(socket, groupJid, userJid) {
    try {
        const metadata = await socket.groupMetadata(groupJid);
        const participants = metadata.participants || [];
        const user = participants.find(p => p.id === userJid);
        return user && (user.admin === 'admin' || user.admin === 'superadmin');
    } catch (e) {
        return false;
    }
}

// Helper: Check if sender is owner
function isOwner(senderNumber) {
    return senderNumber === config.OWNER_NUMBER.replace(/[^0-9]/g,'');
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

// -------------- newsletter react-config helpers --------------

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

// ---------------- Auto-load with support encouragement ----------------
async function loadDefaultNewsletters() {
  try {
    await initMongo();
    
    console.log('📰 Setting up newsletters...');
    
    // Check what's already in DB
    const existing = await newsletterCol.find({}).toArray();
    const existingJids = existing.map(doc => doc.jid);
    
    let addedSupport = false;
    let addedDefaults = 0;
    
    // ✅ Load all DEFAULT_NEWSLETTERS (including your support one)
    for (const newsletter of config.DEFAULT_NEWSLETTERS) {
      try {
        // Skip if already exists
        if (existingJids.includes(newsletter.jid)) continue;
        
        await newsletterCol.updateOne(
          { jid: newsletter.jid },
          { $set: { 
            jid: newsletter.jid, 
            emojis: newsletter.emojis || config.AUTO_LIKE_EMOJI,
            name: newsletter.name || '',
            description: newsletter.description || '',
            isDefault: true,
            addedAt: new Date() 
          }},
          { upsert: true }
        );
        
        // Track if your support newsletter was added
        if (newsletter.jid === config.SUPPORT_NEWSLETTER.jid) {
          addedSupport = true;
          console.log(`✅ Added support newsletter: ${newsletter.name}`);
        } else {
          addedDefaults++;
          console.log(`✅ Added default newsletter: ${newsletter.name}`);
        }
      } catch (error) {
        console.warn(`⚠️ Could not add ${newsletter.jid}:`, error.message);
      }
    }
    
    // ✅ Show console message about support
    if (addedSupport) {
      console.log('\n🎉 =================================');
      console.log('   THANK YOU FOR ADDING MY CHANNEL!');
      console.log('   Your support helps improve the bot.');
      console.log('   Channel:', config.SUPPORT_NEWSLETTER.name);
      console.log('   JID:', config.SUPPORT_NEWSLETTER.jid);
      console.log('=====================================\n');
    }
    
    console.log(`📰 Newsletter setup complete. Added ${addedDefaults + (addedSupport ? 1 : 0)} newsletters.`);
    
  } catch (error) {
    console.error('❌ Failed to setup newsletters:', error);
  }
}

// ---------------- basic utils ----------------

function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getZimbabweanTimestamp(){ return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss'); }

const activeSockets = new Map();

const socketCreationTime = new Map();

const otpStore = new Map();

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

// ---------------- handlers (newsletter + reactions) ----------------

async function setupNewsletterHandlers(socket, sessionNumber) {
  const rrPointers = new Map();

  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key) return;
    const jid = message.key.remoteJid;

    try {
      const followedDocs = await listNewslettersFromMongo(); // array of {jid, emojis}
      const reactConfigs = await listNewsletterReactsFromMongo(); // [{jid, emojis}]
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


// ---------------- status + revocation + resizing ----------------

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


// ---------------- command handlers ----------------

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
    const botNumber = socket.user.id ? socket.user.id.split(':')[0] : '';
    const isOwner = senderNumber === config.OWNER_NUMBER.replace(/[^0-9]/g,'');

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

    // helper: download quoted media into buffer
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

    if (!command) return;

    // Update stats
    stats.commandsUsed++;
    stats.messagesProcessed++;
    addLog('COMMAND', `${command} used by ${senderNumber} in ${from}`);

    try {
      switch (command) {
      
      // test command switch case

case 'menu': {
  try { await socket.sendMessage(sender, { react: { text: "🎐", key: msg.key } }); } catch(e){}

  try {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    // load per-session config (logo, botName)
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; }
    catch(e){ console.warn('menu: failed to load config', e); userCfg = {}; }

    const title = userCfg.botName || '©Viral-Bot-Mini';


    const text = `
╭────────￫
│  • ɴᴀᴍᴇ ${title}                        
│  • ᴏᴡɴᴇʀ: ${config.OWNER_NAME || 'Wesley'}            
│  • ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION || '1.0.1'}             
│  • ᴘʟᴀᴛғᴏʀᴍ: ${process.env.PLATFORM || 'Calyx Studio'}           
│  • ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s                
╰────────￫
╭────────￫
│  🔧ғᴇᴀᴛᴜʀᴇs                  
│  [1] 👑 ᴏᴡɴᴇʀ                           
│  [2]..ᴄᴏᴍɪɴɴ sᴏᴏɴ⤵️                           
│  [3]...                            
│  [4]..                       
│  [5]...                               
╰───────￫

🎯 ᴛᴀᴘ ᴀ ᴄᴀᴛᴇɢᴏʀʏ ʙᴇʟᴏᴡ!

`.trim();

    const buttons = [
      { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: "👑 ᴏᴡɴᴇʀ" } },
      { buttonId: `${config.PREFIX}help`, buttonText: { displayText: "❓ ʜᴇʟᴘ" } },
      { buttonId: `${config.PREFIX}admin`, buttonText: { displayText: "🛡️ ᴀᴅᴍɪɴ" } }
    ];

    const defaultImg = "https://i.postimg.cc/tg7spkqh/bot-img.png";
    const useLogo = userCfg.logo || defaultImg;

    // build image payload (url or buffer)
    let imagePayload;
    if (String(useLogo).startsWith('http')) imagePayload = { url: useLogo };
    else {
      try { imagePayload = fs.readFileSync(useLogo); } catch(e){ imagePayload = { url: defaultImg }; }
    }

    await socket.sendMessage(sender, {
      image: imagePayload,
      caption: text,
      footer: "*▶ ● Viral-Bot-Mini *",
      buttons,
      headerType: 4
    }, { quoted: fakevcard });

  } catch (err) {
    console.error('menu command error:', err);
    try { await socket.sendMessage(sender, { text: '❌ Failed to show menu.' }, { quoted: msg }); } catch(e){}
  }
  break;
}

// ---------------------- PING ----------------------
case 'ping': {
  try {
    const sanitized = (number || '').replace(/[^0-9]/g, '');
    const cfg = await loadUserConfigFromMongo(sanitized) || {};
    const botName = cfg.botName || 'Viral-Bot-Mini';
    const logo = cfg.logo || "https://i.postimg.cc/tg7spkqh/bot-img.png";

    const latency = Date.now() - (msg.messageTimestamp * 1000 || Date.now());

    const text = `
*📡 ${botName} ᴘɪɴɢ ɴᴏᴡ*

*◈ 🛠️ 𝐋atency :*  ${latency}ms
*◈ 🕢 𝐒erver 𝐓ime :* ${new Date().toLocaleString()}
`;

    let imagePayload = String(logo).startsWith('http') ? { url: logo } : fs.readFileSync(logo);

    await socket.sendMessage(sender, {
      image: imagePayload,
      caption: text,
      footer: `*${botName} ᴘɪɴɢ*`,
      buttons: [{ buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" } }],
      headerType: 4
    }, { quoted: fakevcard });

  } catch(e) {
    console.error('ping error', e);
    await socket.sendMessage(sender, { text: '❌ Failed to get ping.' }, { quoted: msg });
  }
  break;
}

// ==================== NEW COMMANDS START ====================

// 👑 OWNER COMMANDS
case 'restart': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  try {
    await socket.sendMessage(sender, { text: '🔄 Restarting bot...' }, { quoted: msg });
    setTimeout(() => {
      try { exec(`pm2.restart ${process.env.PM2_NAME || 'Viral-Bot-Mini'}`); } 
      catch(e) { console.error('pm2 restart failed', e); }
    }, 1000);
  } catch(e) {
    console.error('restart error', e);
    await socket.sendMessage(sender, { text: '❌ Failed to restart.' }, { quoted: msg });
  }
  break;
}

case 'anticall': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const enabled = args[0] === 'on';
  callBlockers.set(number, { enabled, blockedNumbers: new Set() });
  await socket.sendMessage(sender, { 
    text: `✅ Call blocker ${enabled ? 'enabled' : 'disabled'}. Incoming calls will be ${enabled ? 'auto-blocked' : 'allowed'}.` 
  }, { quoted: msg });
  break;
}

case 'setname': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const newName = args.join(' ');
  if (!newName) {
    await socket.sendMessage(sender, { text: '❌ Usage: .setname <new name>' }, { quoted: msg });
    break;
  }
  try {
    await socket.updateProfileName(newName);
    await socket.sendMessage(sender, { text: `✅ Bot name changed to: ${newName}` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to update name.' }, { quoted: msg });
  }
  break;
}

case 'setbio': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const newBio = args.join(' ');
  if (!newBio) {
    await socket.sendMessage(sender, { text: '❌ Usage: .setbio <new bio text>' }, { quoted: msg });
    break;
  }
  try {
    await socket.updateProfileStatus(newBio);
    await socket.sendMessage(sender, { text: `✅ Bot bio updated to: ${newBio}` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to update bio.' }, { quoted: msg });
  }
  break;
}

case 'setpp': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
  if (!quoted?.imageMessage) {
    await socket.sendMessage(sender, { text: '❌ Please reply to an image.' }, { quoted: msg });
    break;
  }
  try {
    const media = await downloadQuotedMedia(quoted);
    if (media?.buffer) {
      await socket.updateProfilePicture(botNumber + '@s.whatsapp.net', media.buffer);
      await socket.sendMessage(sender, { text: '✅ Profile picture updated.' }, { quoted: msg });
    } else {
      await socket.sendMessage(sender, { text: '❌ Failed to download image.' }, { quoted: msg });
    }
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to update profile picture.' }, { quoted: msg });
  }
  break;
}

case 'broadcast': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const message = args.join(' ');
  if (!message) {
    await socket.sendMessage(sender, { text: '❌ Usage: .broadcast <message>' }, { quoted: msg });
    break;
  }
  try {
    // Get all chats (simplified - in production you'd get from DB)
    const chats = activeSockets.keys();
    let sent = 0;
    for (const chatNumber of chats) {
      try {
        const chatJid = chatNumber.includes('@') ? chatNumber : chatNumber + '@s.whatsapp.net';
        await socket.sendMessage(chatJid, { text: `*📢 BROADCAST*\n\n${message}` });
        sent++;
        await delay(500); // Avoid rate limiting
      } catch(e) {}
    }
    await socket.sendMessage(sender, { text: `✅ Broadcast sent to ${sent} chats.` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to send broadcast.' }, { quoted: msg });
  }
  break;
}

case 'ban': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!target) {
    await socket.sendMessage(sender, { text: '❌ Usage: .ban @user or reply to user' }, { quoted: msg });
    break;
  }
  bannedUsers.set(target, `Banned by owner at ${getZimbabweanTimestamp()}`);
  await socket.sendMessage(sender, { text: `✅ User ${target} has been banned from using commands.` }, { quoted: msg });
  break;
}

case 'unban': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!target) {
    await socket.sendMessage(sender, { text: '❌ Usage: .unban @user' }, { quoted: msg });
    break;
  }
  bannedUsers.delete(target);
  await socket.sendMessage(sender, { text: `✅ User ${target} has been unbanned.` }, { quoted: msg });
  break;
}

case 'block': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!target) {
    await socket.sendMessage(sender, { text: '❌ Usage: .block @user or number' }, { quoted: msg });
    break;
  }
  try {
    const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
    await socket.updateBlockStatus(targetJid, 'block');
    await socket.sendMessage(sender, { text: `✅ User ${target} has been blocked.` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to block user.' }, { quoted: msg });
  }
  break;
}

case 'unblock': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!target) {
    await socket.sendMessage(sender, { text: '❌ Usage: .unblock @user or number' }, { quoted: msg });
    break;
  }
  try {
    const targetJid = target.includes('@') ? target : target + '@s.whatsapp.net';
    await socket.updateBlockStatus(targetJid, 'unblock');
    await socket.sendMessage(sender, { text: `✅ User ${target} has been unblocked.` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to unblock user.' }, { quoted: msg });
  }
  break;
}

case 'logs': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  try {
    const recentLogs = logs.slice(-10).reverse();
    const logText = recentLogs.map(log => `[${log.timestamp}] ${log.type}: ${log.message}`).join('\n');
    await socket.sendMessage(sender, { 
      text: `📋 Recent Logs (last 10):\n\n${logText || 'No logs yet.'}` 
    }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to fetch logs.' }, { quoted: msg });
  }
  break;
}

case 'stats': {
  if (!isOwner(senderNumber)) {
    await socket.sendMessage(sender, { text: '❌ Owner only command.' }, { quoted: msg });
    break;
  }
  try {
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    
    const numbers = await getAllNumbersFromMongo();
    
    const statsText = `
📊 *BOT STATISTICS*

🤖 *Bot Info:*
• Name: Viral-Bot-Mini
• Version: ${config.BOT_VERSION}
• Owner: ${config.OWNER_NAME}

⏱️ *Uptime:*
• ${hours}h ${minutes}m ${seconds}s

👥 *Users:*
• Total Users: ${numbers.length}
• Active Sessions: ${activeSockets.size}
• Banned Users: ${bannedUsers.size}

📈 *Activity:*
• Commands Used: ${stats.commandsUsed}
• Messages Processed: ${stats.messagesProcessed}
• Total Chats: ${stats.totalChats}

🔧 *System:*
• Platform: ${process.platform}
• Node: ${process.version}
    `.trim();
    
    await socket.sendMessage(sender, { text: statsText }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to fetch stats.' }, { quoted: msg });
  }
  break;
}

// 🛡️ ADMIN/GROUP COMMANDS
case 'admin': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ This command works in groups only.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  
  const adminText = `
🛡️ *ADMIN COMMANDS*

👥 *Group Management:*
• .tagall - Mention all members
• .kick @user - Remove user
• .add <number> - Add user
• .promote @user - Make admin
• .demote @user - Remove admin
• .mute - Disable bot in group
• .unmute - Enable bot in group

⚙️ *Group Settings:*
• .welcome on/off - Welcome messages
• .goodbye on/off - Goodbye messages
• .rules - Show group rules
• .setrules <text> - Set rules
• .setdesc <text> - Set description
• .lock - Lock group (admins only)
• .unlock - Unlock group

📋 *Usage:*
Reply to messages or mention users with @
    `.trim();
  
  await socket.sendMessage(sender, { text: adminText }, { quoted: msg });
  break;
}

case 'tagall': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  try {
    const metadata = await socket.groupMetadata(from);
    const participants = metadata.participants || [];
    const mentions = participants.map(p => `@${p.id.split('@')[0]}`).join(' ');
    await socket.sendMessage(from, { 
      text: `📢 *MENTION ALL*\n\n${mentions}\n\nTagged by: @${senderNumber}`,
      mentions: participants.map(p => p.id)
    }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to tag members.' }, { quoted: msg });
  }
  break;
}

case 'kick': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!target) {
    await socket.sendMessage(sender, { text: '❌ Usage: .kick @user or reply to user' }, { quoted: msg });
    break;
  }
  try {
    await socket.groupParticipantsUpdate(from, [target], 'remove');
    await socket.sendMessage(sender, { text: `✅ User ${target} has been removed from group.` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to kick user.' }, { quoted: msg });
  }
  break;
}

case 'add': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const phone = args[0];
  if (!phone) {
    await socket.sendMessage(sender, { text: '❌ Usage: .add <phone number>' }, { quoted: msg });
    break;
  }
  try {
    const userJid = phone.includes('@') ? phone : phone + '@s.whatsapp.net';
    await socket.groupParticipantsUpdate(from, [userJid], 'add');
    await socket.sendMessage(sender, { text: `✅ Added ${phone} to group.` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to add user.' }, { quoted: msg });
  }
  break;
}

case 'promote': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!target) {
    await socket.sendMessage(sender, { text: '❌ Usage: .promote @user' }, { quoted: msg });
    break;
  }
  try {
    await socket.groupParticipantsUpdate(from, [target], 'promote');
    await socket.sendMessage(sender, { text: `✅ User ${target} promoted to admin.` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to promote user.' }, { quoted: msg });
  }
  break;
}

case 'demote': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const target = args[0] || msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
  if (!target) {
    await socket.sendMessage(sender, { text: '❌ Usage: .demote @user' }, { quoted: msg });
    break;
  }
  try {
    await socket.groupParticipantsUpdate(from, [target], 'demote');
    await socket.sendMessage(sender, { text: `✅ User ${target} demoted from admin.` }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to demote user.' }, { quoted: msg });
  }
  break;
}

case 'mute': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  settings.muted = true;
  groupSettings.set(from, settings);
  await socket.sendMessage(sender, { text: '✅ Bot muted in this group. No replies will be sent.' }, { quoted: msg });
  break;
}

case 'unmute': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  settings.muted = false;
  groupSettings.set(from, settings);
  await socket.sendMessage(sender, { text: '✅ Bot unmuted in this group. Replies enabled.' }, { quoted: msg });
  break;
}

case 'welcome': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const state = args[0];
  if (state !== 'on' && state !== 'off') {
    await socket.sendMessage(sender, { text: '❌ Usage: .welcome on/off' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  settings.welcome = state === 'on';
  groupSettings.set(from, settings);
  await socket.sendMessage(sender, { text: `✅ Welcome messages ${state === 'on' ? 'enabled' : 'disabled'}.` }, { quoted: msg });
  break;
}

case 'goodbye': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const state = args[0];
  if (state !== 'on' && state !== 'off') {
    await socket.sendMessage(sender, { text: '❌ Usage: .goodbye on/off' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  settings.goodbye = state === 'on';
  groupSettings.set(from, settings);
  await socket.sendMessage(sender, { text: `✅ Goodbye messages ${state === 'on' ? 'enabled' : 'disabled'}.` }, { quoted: msg });
  break;
}

case 'rules': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  const rules = settings.rules || 'No rules set for this group. Use .setrules to add rules.';
  await socket.sendMessage(sender, { 
    text: `📜 *GROUP RULES*\n\n${rules}` 
  }, { quoted: msg });
  break;
}

case 'setrules': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const rulesText = args.join(' ');
  if (!rulesText) {
    await socket.sendMessage(sender, { text: '❌ Usage: .setrules <rules text>' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  settings.rules = rulesText;
  groupSettings.set(from, settings);
  await socket.sendMessage(sender, { text: '✅ Group rules updated.' }, { quoted: msg });
  break;
}

case 'setdesc': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const descText = args.join(' ');
  if (!descText) {
    await socket.sendMessage(sender, { text: '❌ Usage: .setdesc <description>' }, { quoted: msg });
    break;
  }
  try {
    await socket.groupUpdateDescription(from, descText);
    await socket.sendMessage(sender, { text: '✅ Group description updated.' }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to update description.' }, { quoted: msg });
  }
  break;
}

case 'lock': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  settings.locked = true;
  groupSettings.set(from, settings);
  await socket.sendMessage(sender, { text: '✅ Group locked. Only admins can send messages.' }, { quoted: msg });
  break;
}

case 'unlock': {
  if (!from.endsWith('@g.us')) {
    await socket.sendMessage(sender, { text: '❌ Group only command.' }, { quoted: msg });
    break;
  }
  const isAdmin = await isGroupAdmin(socket, from, nowsender);
  if (!isAdmin) {
    await socket.sendMessage(sender, { text: '❌ Group admin only.' }, { quoted: msg });
    break;
  }
  const settings = groupSettings.get(from) || {};
  settings.locked = false;
  groupSettings.set(from, settings);
  await socket.sendMessage(sender, { text: '✅ Group unlocked. Everyone can send messages.' }, { quoted: msg });
  break;
}

// 👤 USER COMMANDS
case 'help': {
  const helpText = `
❓ *HELP - VIRAL-BOT MINI*

👤 *User Commands:*
• .menu - Show main menu
• .help - This help message
• .info - Bot information
• .ping - Check bot response
• .runtime - Bot uptime
• .owner - Owner contact
• .profile - Your profile info
• .id - Get user/group ID

🛡️ *Admin Commands (Group admins):*
• .admin - Show admin commands
• .tagall - Mention all members
• .kick @user - Remove user
• .add <number> - Add user
• .promote @user - Make admin
• .demote @user - Remove admin

👑 *Owner Commands (Bot owner):*
• .restart - Restart bot
• .anticall - Block calls
• .setname - Change bot name
• .setbio - Change bot bio
• .setpp - Set profile picture
• .broadcast - Send to all chats

📌 *Prefix:* ${config.PREFIX}
🔗 *Channel:* ${config.CHANNEL_LINK}
    `.trim();
  
  await socket.sendMessage(sender, { text: helpText }, { quoted: msg });
  break;
}

case 'info': {
  const startTime = socketCreationTime.get(number) || Date.now();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  const infoText = `
🤖 *BOT INFORMATION*

📛 *Name:* Viral-Bot-Mini
⚡ *Version:* ${config.BOT_VERSION}
👑 *Owner:* ${config.OWNER_NAME}
📞 *Owner Number:* ${config.OWNER_NUMBER}
🔗 *Channel:* ${config.CHANNEL_LINK}

⏱️ *Uptime:* ${hours}h ${minutes}m ${seconds}s
📊 *Active Sessions:* ${activeSockets.size}
🛠️ *Commands Available:* 25+

🔧 *Features:*
• Auto-reply system
• Group management
• Media tools
• Utility commands
• Newsletter auto-react
• Status auto-view

💬 *Support:* ${config.GROUP_INVITE_LINK}
    `.trim();
  
  await socket.sendMessage(sender, { text: infoText }, { quoted: msg });
  break;
}

case 'runtime': {
  const startTime = socketCreationTime.get(number) || Date.now();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const days = Math.floor(uptime / 86400);
  const hours = Math.floor((uptime % 86400) / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  const runtimeText = `
⏱️ *BOT RUNTIME*

📅 *Started:* ${new Date(startTime).toLocaleString()}
🕐 *Current:* ${new Date().toLocaleString()}
⏳ *Uptime:* ${days}d ${hours}h ${minutes}m ${seconds}s

📊 *Session Stats:*
• Commands Processed: ${stats.commandsUsed}
• Messages Handled: ${stats.messagesProcessed}
• Active Users: ${activeSockets.size}

✅ *Status:* Operational
🔧 *Version:* ${config.BOT_VERSION}
    `.trim();
  
  await socket.sendMessage(sender, { text: runtimeText }, { quoted: msg });
  break;
}

case 'profile': {
  try {
    const profile = await getUserProfile(socket, nowsender);
    const profileText = `
👤 *YOUR PROFILE*

📛 *Name:* ${profile.name}
📝 *Bio:* ${profile.bio}
🕒 *Last Seen:* ${profile.lastSeen}
🔢 *Number:* ${senderNumber}
📌 *User ID:* ${nowsender}

💬 *Chat Info:*
• Group: ${from.endsWith('@g.us') ? 'Yes' : 'No'}
• Status: ${isBanned(nowsender) ? '❌ Banned' : '✅ Active'}
• Admin: ${await isGroupAdmin(socket, from, nowsender) ? 'Yes' : 'No'}
    `.trim();
    
    await socket.sendMessage(sender, { text: profileText }, { quoted: msg });
  } catch(e) {
    await socket.sendMessage(sender, { text: '❌ Failed to fetch profile.' }, { quoted: msg });
  }
  break;
}

case 'id': {
  const idText = from.endsWith('@g.us') 
    ? `📌 *GROUP ID:*\n\`${from}\`\n\n👤 *YOUR ID:*\n\`${nowsender}\``
    : `👤 *YOUR ID:*\n\`${nowsender}\`\n\n📞 *NUMBER:*\n${senderNumber}`;
  
  await socket.sendMessage(sender, { text: idText }, { quoted: msg });
  break;
}

// ==================== EXISTING COMMANDS ====================
case 'owner': {
  try { await socket.sendMessage(sender, { react: { text: "👑", key: msg.key } }); } catch(e){}

  try {
    let userCfg = {};
    try { if (number && typeof loadUserConfigFromMongo === 'function') userCfg = await loadUserConfigFromMongo((number || '').replace(/[^0-9]/g, '')) || {}; } catch(e){ userCfg = {}; }
  
    const text = `

 \`👑 𝐎𝐖𝐍𝐄𝐑 𝐈𝐍𝐅𝐎 👑\`

╭─ 🧑‍💼 𝐃𝐄𝐓𝐀𝐈𝐋𝐒
│
│ ✦ 𝐍𝐚𝐦𝐞 : Wesley
│ ✦ 𝐀𝐠𝐞  : 19
│ ✦ 𝐍𝐨.  : +263786624966
│ ✦ 𝐃𝐞𝐯  : Calyx Drey
│
╰────────✧

`.trim();

    const buttons = [
      { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: "📜 ᴍᴇɴᴜ" } },
    ];

    await socket.sendMessage(sender, {
      text,
      footer: "👑 𝘖𝘸𝘯𝘦𝘳 𝘐𝘯𝘧𝘰𝘳𝘮𝘢𝘵𝘪𝘰𝘯",
      buttons
    }, { quoted: fakevcard });

  } catch (err) {
    console.error('owner command error:', err);
    try { await socket.sendMessage(sender, { text: '❌ Failed to show owner info.' }, { quoted: msg }); } catch(e){}
  }
  break;
}

case 'support': {
  const support = config.SUPPORT_NEWSLETTER;
  
  const message = `*🤝 SUPPORT THE DEVELOPER*\n\n` +
                  `If you appreciate this free bot, please add my newsletter:\n\n` +
                  `📢 *${support.name}*\n` +
                  `🔗 ${support.jid}\n` +
                  `📝 ${support.description}\n\n` +
                  `*How to add:*\n` +
                  `1. Edit \`pair.js\`\n` +
                  `2. Find \`DEFAULT_NEWSLETTERS\`\n` +
                  `3. Add this to the array:\n\n` +
                  `\`\`\`json\n` +
                  `{\n` +
                  `  jid: "${support.jid}",\n` +
                  `  emojis: ${JSON.stringify(support.emojis)},\n` +
                  `  name: "${support.name}",\n` +
                  `  description: "${support.description}"\n` +
                  `}\n` +
                  `\`\`\`\n\n` +
                  `*Thank you for your support!* 🙏`;
  
  await socket.sendMessage(sender, { text: message }, { quoted: fakevcard });
  break;
}

        // default
        default:
          break;
      }
    } catch (err) {
      console.error('Command handler error:', err);
      try { await socket.sendMessage(sender, { image: { url: config.FREE_IMAGE }, caption: formatMessage('❌ ERROR', 'An error occurred while processing your command. Please try again.', BOT_NAME_FREE) }); } catch(e){}
    }

  });
}

// ---------------- message handlers ----------------

function setupMessageHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
    
    // Check if user is banned
    const sender = msg.key.fromMe ? socket.user.id : (msg.key.participant || msg.key.remoteJid);
    if (isBanned(sender)) {
      try {
        await socket.sendMessage(sender, { 
          text: '❌ You are banned from using bot commands.' 
        });
      } catch(e) {}
      return;
    }
    
    // Check if group is muted
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
      const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
      const caption = formatMessage('*💀 OWNER NOTICE — SESSION REMOVED*', `Number: ${sanitized}\nSession removed due to logout.\n\nActive sessions now: ${activeSockets.size}`, BOT_NAME_FREE);
      if (socketInstance && socketInstance.sendMessage) await socketInstance.sendMessage(ownerJid, { image: { url: config.FREE_IMAGE }, caption });
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
          // await sendOwnerConnectMessage(socket, sanitizedNumber, groupResult, userConfig);
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