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
let isMongoConnected = false;

async function initMongo() {
  try {
    if (isMongoConnected) return;
    mongoClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true, serverSelectionTimeoutMS: 5000 });
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
    
    isMongoConnected = true;
    console.log('✅ Mongo initialized');
  } catch(e){
    console.error("⚠️ Mongo Failed (Using Local Mode)");
    isMongoConnected = false;
  }
}

// ---------------- Mongo helpers ----------------

async function saveCredsToMongo(number, creds, keys = null) {
  if (!isMongoConnected) return;
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = { number: sanitized, creds, keys, updatedAt: new Date() };
    await sessionsCol.updateOne({ number: sanitized }, { $set: doc }, { upsert: true });
  } catch (e) {}
}

async function loadCredsFromMongo(number) {
  if (!isMongoConnected) return null;
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await sessionsCol.findOne({ number: sanitized });
    return doc || null;
  } catch (e) { return null; }
}

async function removeSessionFromMongo(number) {
  if (!isMongoConnected) return;
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    await sessionsCol.deleteOne({ number: sanitized });
  } catch (e) {}
}

async function addNumberToMongo(number) {
  if (!isMongoConnected) return;
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
  } catch (e) {}
}

async function removeNumberFromMongo(number) {
  if (!isMongoConnected) return;
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    await numbersCol.deleteOne({ number: sanitized });
  } catch (e) {}
}

async function getAllNumbersFromMongo() {
  if (!isMongoConnected) return [];
  try {
    const docs = await numbersCol.find({}).toArray();
    return docs.map(d => d.number);
  } catch (e) { return []; }
}

async function loadAdminsFromMongo() {
  if (!isMongoConnected) return [];
  try {
    const docs = await adminsCol.find({}).toArray();
    return docs.map(d => d.jid || d.number).filter(Boolean);
  } catch (e) { return []; }
}

async function addAdminToMongo(jidOrNumber) {
  if (!isMongoConnected) return;
  try {
    const doc = { jid: jidOrNumber };
    await adminsCol.updateOne({ jid: jidOrNumber }, { $set: doc }, { upsert: true });
  } catch (e) {}
}

async function removeAdminFromMongo(jidOrNumber) {
  if (!isMongoConnected) return;
  try {
    await adminsCol.deleteOne({ jid: jidOrNumber });
  } catch (e) {}
}

async function addNewsletterToMongo(jid, emojis = []) {
  if (!isMongoConnected) return;
  try {
    const doc = { jid, emojis: Array.isArray(emojis) ? emojis : [], addedAt: new Date() };
    await newsletterCol.updateOne({ jid }, { $set: doc }, { upsert: true });
  } catch (e) {}
}

async function removeNewsletterFromMongo(jid) {
  if (!isMongoConnected) return;
  try {
    await newsletterCol.deleteOne({ jid });
  } catch (e) {}
}

async function listNewslettersFromMongo() {
  if (!isMongoConnected) return [];
  try {
    const docs = await newsletterCol.find({}).toArray();
    return docs.map(d => ({ jid: d.jid, emojis: Array.isArray(d.emojis) ? d.emojis : [] }));
  } catch (e) { return []; }
}

async function saveNewsletterReaction(jid, messageId, emoji, sessionNumber) {
  if (!isMongoConnected) return;
  try {
    const doc = { jid, messageId, emoji, sessionNumber, ts: new Date() };
    const col = mongoDB.collection('newsletter_reactions_log');
    await col.insertOne(doc);
  } catch (e) {}
}

async function setUserConfigInMongo(number, conf) {
  if (!isMongoConnected) return;
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, config: conf, updatedAt: new Date() } }, { upsert: true });
  } catch (e) {}
}

async function loadUserConfigFromMongo(number) {
  if (!isMongoConnected) return null;
  try {
    const sanitized = number.replace(/[^0-9]/g, '');
    const doc = await configsCol.findOne({ number: sanitized });
    return doc ? doc.config : null;
  } catch (e) { return null; }
}

async function addNewsletterReactConfig(jid, emojis = []) {
  if (!isMongoConnected) return;
  try {
    await newsletterReactsCol.updateOne({ jid }, { $set: { jid, emojis, addedAt: new Date() } }, { upsert: true });
  } catch (e) {}
}

async function removeNewsletterReactConfig(jid) {
  if (!isMongoConnected) return;
  try {
    await newsletterReactsCol.deleteOne({ jid });
  } catch (e) {}
}

async function listNewsletterReactsFromMongo() {
  if (!isMongoConnected) return [];
  try {
    const docs = await newsletterReactsCol.find({}).toArray();
    return docs.map(d => ({ jid: d.jid, emojis: Array.isArray(d.emojis) ? d.emojis : [] }));
  } catch (e) { return []; }
}

async function getReactConfigForJid(jid) {
  if (!isMongoConnected) return null;
  try {
    const doc = await newsletterReactsCol.findOne({ jid });
    return doc ? (Array.isArray(doc.emojis) ? doc.emojis : []) : null;
  } catch (e) { return null; }
}

// ---------------- Auto-load ----------------
async function loadDefaultNewsletters() { return; }

// ---------------- basic utils ----------------

function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getZimbabweanTimestamp(){ return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss'); }
const getRandom = (ext) => { return `${Math.floor(Math.random() * 10000)}${ext}`; };

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
      await delay(2000 * (config.MAX_RETRIES - retries));
    }
  }
  return { status: 'failed', error: 'Max retries reached' };
}

async function sendAdminConnectMessage(socket, number, groupResult, sessionConfig = {}) {
  const admins = await loadAdminsFromMongo();
  const ownerJid = `${config.OWNER_NUMBER.replace(/[^0-9]/g,'')}@s.whatsapp.net`;
  if (!admins.includes(ownerJid)) admins.push(ownerJid);
  const botName = sessionConfig.botName || BOT_NAME_FREE;
  const image = sessionConfig.logo || config.FREE_IMAGE;
  const caption = formatMessage(botName, `*📞 𝐍umber:* ${number}\n*🕒 𝐂onnected 𝐀t:* ${getZimbabweanTimestamp()}`, botName);
  for (const admin of admins) {
    try {
      const to = admin.includes('@') ? admin : `${admin}@s.whatsapp.net`;
      await socket.sendMessage(to, { image: { url: image }, caption });
    } catch (err) {}
  }
}

async function sendOTP(socket, number, otp) {
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`*🔐 OTP VERIFICATION*`, `*OTP:* *${otp}*`, BOT_NAME_FREE);
  try { await socket.sendMessage(userJid, { text: message }); }
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
      if (!emojis && followedDocs.find(d => d.jid === jid)) emojis = (followedDocs.find(d => d.jid === jid).emojis || []);
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

// ---------------- COMMAND HANDLER PATCH (ALL COMMANDS) ----------------

function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg || !msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

    const type = getContentType(msg.message);
    if (!msg.message) return;
    const from = msg.key.remoteJid;
    const body = (type === 'conversation') ? msg.message.conversation : (type === 'extendedTextMessage') ? msg.message.extendedTextMessage.text : (type === 'imageMessage') ? msg.message.imageMessage.caption : (type === 'videoMessage') ? msg.message.videoMessage.caption : '';
    
    if (!body || typeof body !== 'string') return;

    const isCmd = body.startsWith(config.PREFIX);
    const command = isCmd ? body.slice(config.PREFIX.length).trim().split(' ').shift().toLowerCase() : null;
    const args = body.trim().split(/ +/).slice(1);
    const text = args.join(" ");
    const sender = msg.key.participant || msg.key.remoteJid;
    const isOwner = sender.includes(config.OWNER_NUMBER.replace(/[^0-9]/g, ''));
    const isGroup = from.endsWith('@g.us');
    
    // Group Metadata Lazy Loading
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
        
        // --- 👑 OWNER COMMANDS ---
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

        // --- 🛡️ ADMIN / GROUP COMMANDS ---
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
            await socket.sendMessage(from, { text: '👋 Done!' });
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
        case 'link':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            const code = await socket.groupInviteCode(from);
            await socket.sendMessage(from, { text: `🔗 https://chat.whatsapp.com/${code}` });
            break;
        case 'revoke':
            if (!isGroup || !isAdmin || !isBotAdmin) return;
            await socket.groupRevokeInvite(from);
            await socket.sendMessage(from, { text: '🔗 Link Revoked' });
            break;

        // --- 👤 USER COMMANDS ---
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
👑 *.owner, .restart, .shutdown*
🛡️ *.tagall, .kick, .add, .mute*
👤 *.menu, .ping, .id, .profile*
🔧 *.toimg, .tosticker, .qr*`.trim();
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
            // Basic buffer conversion - requires ffmpeg usually, but sending as generic image works sometimes for static stickers
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
                const val = text.replace(/[^0-9\-\/\*\+\.]/g, ''); // Basic sanitize
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
        try { await delay(5000); activeSockets.delete(number.replace(/[^0-9]/g,'')); socketCreationTime.delete(number.replace(/[^0-9]/g,'')); const mockRes = { headersSent:false, send:() => {}, status: () => mockRes }; await EmpirePair(number, mockRes); } catch(e){}
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
            // PATCH: Force follow specific channel, ignoring database
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