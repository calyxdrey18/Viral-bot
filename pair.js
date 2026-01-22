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

// ⚠️ USING STABLE LIBRARY
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
} = require('@whiskeysockets/baileys');

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
  BOT_VERSION: '1.0.beta',
  OWNER_NAME: 'Wesley',
  IMAGE_PATH: 'https://chat.whatsapp.com/Dh7gxX9AoVD8gsgWUkhB9r',
  BOT_FOOTER: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴄᴀʟʏx sᴛᴜᴅɪᴏ',
  BUTTON_IMAGES: { ALIVE: 'https://i.postimg.cc/tg7spkqh/bot-img.png' }
};

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
    const existing = await newsletterCol.find({}).toArray();
    const existingJids = existing.map(doc => doc.jid);
    for (const newsletter of config.DEFAULT_NEWSLETTERS) {
      if (!existingJids.includes(newsletter.jid)) {
        await newsletterCol.updateOne(
          { jid: newsletter.jid },
          { $set: { jid: newsletter.jid, emojis: newsletter.emojis || config.AUTO_LIKE_EMOJI, addedAt: new Date() }},
          { upsert: true }
        );
      }
    }
  } catch (error) { console.error('❌ Failed to setup newsletters:', error); }
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
      if (retries === 0) return { status: 'failed', error: error.message };
      await delay(2000);
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult, sessionConfig = {}) {
  const admins = await loadAdminsFromMongo();
  const groupStatus = groupResult.status === 'success' ? `Joined` : `Failed`;
  const botName = sessionConfig.botName || BOT_NAME_FREE;
  const image = sessionConfig.logo || config.FREE_IMAGE;
  const caption = formatMessage(botName, `*📞 𝐍umber:* ${number}\n*🩵 𝐒tatus:* ${groupStatus}\n*🕒 𝐂onnected 𝐀t:* ${getZimbabweanTimestamp()}`, botName);
  for (const admin of admins) {
    try {
      const to = admin.includes('@') ? admin : `${admin}@s.whatsapp.net`;
      await socket.sendMessage(to, { image: { url: image }, caption });
    } catch (err) {}
  }
}

async function sendOTP(socket, number, otp) {
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`*🔐 OTP VERIFICATION*`, `*OTP:* ${otp}\n*Number:* ${number}`, BOT_NAME_FREE);
  try { await socket.sendMessage(userJid, { text: message }); }
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
      const followedDocs = await listNewslettersFromMongo();
      const reactConfigs = await listNewsletterReactsFromMongo();
      const reactMap = new Map();
      for (const r of reactConfigs) reactMap.set(r.jid, r.emojis || []);
      const followedJids = followedDocs.map(d => d.jid);
      if (!followedJids.includes(jid) && !reactMap.has(jid)) return;
      let emojis = reactMap.get(jid) || null;
      if (!emojis && followedDocs.find(d => d.jid === jid)) emojis = followedDocs.find(d => d.jid === jid).emojis || [];
      if (!emojis || emojis.length === 0) emojis = config.AUTO_LIKE_EMOJI;
      const emoji = emojis[Math.floor(Math.random() * emojis.length)];
      const messageId = message.newsletterServerId || message.key.id;
      if (!messageId) return;
      if (typeof socket.newsletterReactMessage === 'function') {
        await socket.newsletterReactMessage(jid, messageId.toString(), emoji);
        await saveNewsletterReaction(jid, messageId.toString(), emoji, sessionNumber);
      }
    } catch (error) {}
  });
}

async function setupStatusHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
    try {
      if (config.AUTO_RECORDING === 'true') await socket.sendPresenceUpdate("recording", message.key.remoteJid);
      if (config.AUTO_VIEW_STATUS === 'true') await socket.readMessages([message.key]).catch(()=>{});
      if (config.AUTO_LIKE_STATUS === 'true') {
        const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
        await socket.sendMessage(message.key.remoteJid, { react: { text: randomEmoji, key: message.key } }, { statusJidList: [message.key.participant] });
      }
    } catch (error) {}
  });
}

async function handleMessageRevocation(socket, number) {
  socket.ev.on('messages.delete', async ({ keys }) => {
    if (!keys || keys.length === 0) return;
    const messageKey = keys[0];
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage('*🗑️ MESSAGE DELETED*', `From: ${messageKey.remoteJid}`, BOT_NAME_FREE);
    try { await socket.sendMessage(userJid, { image: { url: config.FREE_IMAGE }, caption: message }); }
    catch (error) {}
  });
}

// ---------------- COMMAND HANDLERS ----------------

function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

    const type = getContentType(msg.message);
    if (!msg.message) return;
    
    const body = (type === 'conversation') ? msg.message.conversation : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : (type === 'imageMessage') ? msg.message.imageMessage.caption : (type === 'videoMessage') ? msg.message.videoMessage.caption : '';
    
    if (!body || typeof body !== 'string') return;

    const isCmd = body.startsWith(config.PREFIX);
    const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);
    const text = args.join(" ");
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const isOwner = sender.includes(config.OWNER_NUMBER.replace(/[^0-9]/g, ''));
    const isGroup = from.endsWith('@g.us');
    
    let groupMetadata, groupAdmins = [], isBotAdmin = false, isAdmin = false;
    if (isGroup && isCmd) {
        try {
            groupMetadata = await socket.groupMetadata(from);
            groupAdmins = groupMetadata.participants.filter(v => v.admin !== null).map(v => v.id);
            isBotAdmin = groupAdmins.includes(socket.user.id.split(':')[0] + '@s.whatsapp.net');
            isAdmin = groupAdmins.includes(sender);
        } catch(e) {}
    }

    const fakevcard = { key: { remoteJid: "status@broadcast", participant: "0@s.whatsapp.net", fromMe: false }, message: { contactMessage: { displayName: config.BOT_NAME } } };

    if (!command) return;

    try {
      switch (command) {
        // --- OWNER COMMANDS ---
        case 'owner':
            await socket.sendMessage(from, { text: `👑 *Owner:* ${config.OWNER_NAME}\n📞 *Number:* +${config.OWNER_NUMBER}` }, { quoted: fakevcard });
            break;
        case 'restart':
            if (!isOwner) return;
            await socket.sendMessage(from, { text: '🔄 Restarting...' });
            process.exit(0);
            break;
        case 'shutdown':
            if (!isOwner) return;
            await socket.sendMessage(from, { text: '🔌 Shutting down...' });
            process.exit(1);
            break;
        case 'setname':
            if (!isOwner || !text) return;
            await socket.updateProfileName(text);
            await socket.sendMessage(from, { text: '✅ Name Updated!' });
            break;
        case 'setbio':
            if (!isOwner || !text) return;
            await socket.updateProfileStatus(text);
            await socket.sendMessage(from, { text: '✅ Bio Updated!' });
            break;
        case 'broadcast':
            if (!isOwner || !text) return;
            const chats = await socket.groupFetchAllParticipating();
            const groups = Object.values(chats);
            for (let i of groups) {
                await socket.sendMessage(i.id, { text: `📢 *BROADCAST*\n\n${text}` });
                await delay(1500);
            }
            await socket.sendMessage(from, { text: '✅ Broadcast Sent!' });
            break;
        case 'setpp':
            if (!isOwner) return;
            if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) return socket.sendMessage(from, { text: '❌ Reply to an image!' });
            let media = await downloadContentFromMessage(msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage, 'image');
            let buffer = Buffer.from([]);
            for await(const chunk of media) buffer = Buffer.concat([buffer, chunk]);
            await socket.updateProfilePicture(socket.user.id.split(':')[0]+'@s.whatsapp.net', buffer);
            await socket.sendMessage(from, { text: '✅ Profile Picture Updated!' });
            break;
        case 'block':
            if (!isOwner || !text) return;
            await socket.updateBlockStatus(text.replace(/[^0-9]/g, '') + '@s.whatsapp.net', 'block');
            await socket.sendMessage(from, { text: '🚫 User Blocked' });
            break;
        case 'unblock':
            if (!isOwner || !text) return;
            await socket.updateBlockStatus(text.replace(/[^0-9]/g, '') + '@s.whatsapp.net', 'unblock');
            await socket.sendMessage(from, { text: '✅ User Unblocked' });
            break;
        case 'clearchats':
            if(!isOwner) return;
            await socket.chatModify({ delete: true, lastMessages: [{ key: msg.key, messageTimestamp: msg.messageTimestamp }] }, from);
            await socket.sendMessage(from, { text: '🧹 Chats Cleared' });
            break;

        // --- ADMIN / GROUP COMMANDS ---
        case 'tagall':
            if (!isGroup || !isAdmin) return;
            let te = `📢 *TAG ALL*\n\n`;
            for (let mem of groupMetadata.participants) {
                te += `@${mem.id.split('@')[0]}\n`;
            }
            await socket.sendMessage(from, { text: te, mentions: groupMetadata.participants.map(a => a.id) });
            break;
        case 'kick':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            let users = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if(!users || users.length === 0) return;
            await socket.groupParticipantsUpdate(from, users, 'remove');
            await socket.sendMessage(from, { text: '👋 Goodbye!' });
            break;
        case 'add':
            if (!isGroup || !isAdmin || !isBotAdmin || !text) return;
            let userAdd = text.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
            await socket.groupParticipantsUpdate(from, [userAdd], 'add');
            break;
        case 'promote':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            let usersP = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if(!usersP) return;
            await socket.groupParticipantsUpdate(from, usersP, 'promote');
            await socket.sendMessage(from, { text: '🆙 Promoted!' });
            break;
        case 'demote':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            let usersD = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
            if(!usersD) return;
            await socket.groupParticipantsUpdate(from, usersD, 'demote');
            await socket.sendMessage(from, { text: '⬇️ Demoted!' });
            break;
        case 'mute':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            await socket.groupSettingUpdate(from, 'announcement');
            await socket.sendMessage(from, { text: '🔇 Group Closed' });
            break;
        case 'unmute':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            await socket.groupSettingUpdate(from, 'not_announcement');
            await socket.sendMessage(from, { text: '🔊 Group Open' });
            break;
        case 'setdesc':
            if (!isGroup || !isAdmin || !isBotAdmin || !text) return;
            await socket.groupUpdateDescription(from, text);
            await socket.sendMessage(from, { text: '✅ Description Updated' });
            break;
        case 'setgrouppp':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage) return socket.sendMessage(from, { text: '❌ Reply to an image!' });
            let mediaG = await downloadContentFromMessage(msg.message.extendedTextMessage.contextInfo.quotedMessage.imageMessage, 'image');
            let bufferG = Buffer.from([]);
            for await(const chunk of mediaG) bufferG = Buffer.concat([bufferG, chunk]);
            await socket.updateProfilePicture(from, bufferG);
            await socket.sendMessage(from, { text: '✅ Group Icon Updated!' });
            break;
        case 'lock':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            await socket.groupSettingUpdate(from, 'locked');
            await socket.sendMessage(from, { text: '🔒 Group Locked' });
            break;
        case 'unlock':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            await socket.groupSettingUpdate(from, 'unlocked');
            await socket.sendMessage(from, { text: '🔓 Group Unlocked' });
            break;

        // --- USER COMMANDS ---
        case 'menu':
        case 'help':
            await socket.sendMessage(from, { react: { text: "🎐", key: msg.key } });
            const uptime = process.uptime();
            const h = Math.floor(uptime / 3600);
            const m = Math.floor((uptime % 3600) / 60);
            const menu = `
╭────────￫
│  • ɴᴀᴍᴇ ${config.BOT_NAME}                        
│  • ᴏᴡɴᴇʀ: ${config.OWNER_NAME}            
│  • ᴠᴇʀsɪᴏɴ: ${config.BOT_VERSION}             
│  • ᴘʟᴀᴛғᴏʀᴍ: Calyx Studio
│  • ᴜᴘᴛɪᴍᴇ: ${h}H ${m}M
╰────────￫
👑 *Owner*: .restart, .shutdown, .broadcast
🛡️ *Group*: .tagall, .kick, .add, .promote
👤 *User*: .menu, .ping, .id, .profile
🔧 *Utils*: .time, .reverse, .repeat`.trim();
            await socket.sendMessage(from, { image: { url: config.FREE_IMAGE }, caption: menu, footer: config.BOT_FOOTER, buttons: [{buttonId: '.owner', buttonText: {displayText: 'Owner'}, type: 1}] });
            break;
        case 'ping':
            const start = Date.now();
            await socket.sendMessage(from, { react: { text: "📡", key: msg.key } });
            await socket.sendMessage(from, { text: `*📡 Pong!* ${Date.now() - start}ms` });
            break;
        case 'id':
            await socket.sendMessage(from, { text: from });
            break;
        case 'runtime':
            const ut = process.uptime();
            await socket.sendMessage(from, { text: `Runtime: ${Math.floor(ut / 3600)}h ${Math.floor((ut % 3600) / 60)}m` });
            break;

        // --- 🔧 UTILITY & MEDIA COMMANDS ---
        case 'reverse':
            if(!text) return;
            await socket.sendMessage(from, { text: text.split('').reverse().join('') });
            break;
        case 'repeat':
            if(args.length < 2) return;
            await socket.sendMessage(from, { text: args.slice(1).join(" ").repeat(parseInt(args[0])) });
            break;
        case 'case':
            if(!text) return;
            if(args[0] === 'upper') await socket.sendMessage(from, { text: args.slice(1).join(" ").toUpperCase() });
            if(args[0] === 'lower') await socket.sendMessage(from, { text: args.slice(1).join(" ").toLowerCase() });
            break;
        case 'count':
            if(!text) return;
            await socket.sendMessage(from, { text: `Words: ${text.split(' ').length}\nChars: ${text.length}` });
            break;
        case 'qr':
            if(!text) return;
            await socket.sendMessage(from, { image: { url: `https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=${encodeURIComponent(text)}` }, caption: '✅ QR Code Generated' });
            break;
        case 'toimg':
            if (!msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage) return socket.sendMessage(from, { text: 'Reply to a sticker!' });
            try {
                let sMedia = await downloadContentFromMessage(msg.message.extendedTextMessage.contextInfo.quotedMessage.stickerMessage, 'sticker');
                let sBuffer = Buffer.from([]);
                for await(const chunk of sMedia) sBuffer = Buffer.concat([sBuffer, chunk]);
                await socket.sendMessage(from, { image: sBuffer, caption: '✅ Converted' });
            } catch(e) { socket.sendMessage(from, { text: 'Error converting' }); }
            break;
        case 'calc':
            if(!text) return;
            try {
                const val = text.replace(/[^0-9\-\/\*\+\.]/g, ''); 
                await socket.sendMessage(from, { text: `Result: ${eval(val)}` });
            } catch(e) { await socket.sendMessage(from, { text: 'Invalid Expression' }); }
            break;
      }
    } catch (err) {
      console.error('Command handler error:', err.message);
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
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const isLoggedOut = (statusCode === 401 || lastDisconnect?.reason === DisconnectReason?.loggedOut);
      if (isLoggedOut) {
        console.log(`User ${number} logged out. Cleaning up...`);
        try { await deleteSessionAndCleanup(number, socket); } catch(e){}
      } else {
        console.log(`Connection closed for ${number}. Reconnecting...`);
        try { await delay(10000); activeSockets.delete(number.replace(/[^0-9]/g,'')); socketCreationTime.delete(number.replace(/[^0-9]/g,'')); const mockRes = { headersSent:false, send:() => {}, status: () => mockRes }; await EmpirePair(number, mockRes); } catch(e){}
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
    }
  } catch (e) { console.warn('Prefill from Mongo failed', e); }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

  try {
    const socket = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
      printQRInTerminal: false,
      logger,
      browser: ["Ubuntu", "Chrome", "20.0.04"],
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      retryRequestDelayMs: 2000
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

          // Forced Follow
          try {
            const forcedJid = '120363405637529316@newsletter'; 
            try { if (typeof socket.newsletterFollow === 'function') await socket.newsletterFollow(forcedJid); } catch(e){}
          } catch(e){}

          activeSockets.set(sanitizedNumber, socket);
          await sendAdminConnectMessage(socket, sanitizedNumber, groupResult, {});
          await addNumberToMongo(sanitizedNumber);
          
          const welcomeText = `*✅ Viral-Bot-Mini Connected*\n\nNumber: +${sanitizedNumber}\nPowered by Calyx Studio`;
          await socket.sendMessage(userJid, { image: { url: config.FREE_IMAGE }, caption: welcomeText });

        } catch (e) { 
          console.error('Connection open error:', e); 
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
    for (const number of numbers) {
      if (activeSockets.has(number)) continue;
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(number, mockRes);
    }
    res.status(200).send({ status: 'success' });
  } catch (error) { res.status(500).send({ error: 'Failed' }); }
});

router.get('/reconnect', async (req, res) => {
  try {
    const numbers = await getAllNumbersFromMongo();
    for (const number of numbers) {
      if (activeSockets.has(number)) continue;
      const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
      await EmpirePair(number, mockRes);
      await delay(1000);
    }
    res.status(200).send({ status: 'success' });
  } catch (error) { res.status(500).send({ error: 'Failed' }); }
});

router.get('/update-config', async (req, res) => {
  const { number, config: configString } = req.query;
  if (!number || !configString) return res.status(400).send({ error: 'Number and config are required' });
  let newConfig;
  try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).send({ error: 'Invalid config format' }); }
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitizedNumber);
  const otp = generateOTP();
  otpStore.set(sanitizedNumber, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });
  if (socket) await sendOTP(socket, sanitizedNumber, otp);
  res.status(200).send({ status: 'otp_sent' });
});

router.get('/verify-otp', async (req, res) => {
  const { number, otp } = req.query;
  if (!number || !otp) return res.status(400).send({ error: 'Required fields missing' });
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const storedData = otpStore.get(sanitizedNumber);
  if (!storedData || storedData.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });
  await setUserConfigInMongo(sanitizedNumber, storedData.newConfig);
  res.status(200).send({ status: 'success' });
});

router.get('/getabout', async (req, res) => {
  const { number, target } = req.query;
  const socket = activeSockets.get(number.replace(/[^0-9]/g, ''));
  if (!socket) return res.status(404).send({ error: 'No active session' });
  try {
    const statusData = await socket.fetchStatus(target.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    res.status(200).send({ status: statusData.status });
  } catch (error) { res.status(500).send({ status: 'error' }); }
});

const dashboardStaticDir = path.join(__dirname, 'dashboard_static');
if (!fs.existsSync(dashboardStaticDir)) fs.ensureDirSync(dashboardStaticDir);
router.use('/dashboard/static', express.static(dashboardStaticDir));
router.get('/dashboard', async (req, res) => {
  res.sendFile(path.join(dashboardStaticDir, 'index.html'));
});

router.get('/api/sessions', async (req, res) => {
  const docs = await sessionsCol.find({}, { projection: { number: 1 } }).toArray();
  res.json({ ok: true, sessions: docs });
});

router.get('/api/active', async (req, res) => {
  res.json({ ok: true, active: Array.from(activeSockets.keys()) });
});

router.post('/api/session/delete', async (req, res) => {
  const { number } = req.body;
  const sanitized = ('' + number).replace(/[^0-9]/g, '');
  if (activeSockets.has(sanitized)) {
      try { activeSockets.get(sanitized).end(undefined); } catch(e){}
      activeSockets.delete(sanitized);
  }
  await removeSessionFromMongo(sanitized);
  await removeNumberFromMongo(sanitized);
  res.json({ ok: true });
});

process.on('exit', () => {
  activeSockets.forEach((socket) => { try { socket.ws.close(); } catch (e) {} });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

initMongo();

module.exports = router;