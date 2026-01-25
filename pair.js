const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const { MongoClient } = require('mongodb');

// Import the split command handler
const handleCommand = require('./commands'); 

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
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
  
  // SUPPORT NEWSLETTER
  SUPPORT_NEWSLETTER: {
    jid: '120363405637529316@newsletter',
    emojis: ['❤️', '🌟', '🔥', '💯'],
    name: 'Viral-Bot-Mini',
    description: 'Bot updates & support channel by Calyx Drey'
  },
  
  // DEFAULT NEWSLETTERS (Kept for reference, but hard force follow removed)
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
const bannedUsers = new Map(); 
const callBlockers = new Map(); 
const commandLogs = []; 

// ---------------- MONGO SETUP ----------------

// 🔴 FIX: Removed 'process.env.MONGO_URI ||' to force the new database
const MONGO_URI = 'mongodb+srv://calyxdrey11:viral_bot@drey.qptc9q8.mongodb.net/?appName=Drey';
const MONGO_DB = 'Viral-Bot_Mini';

let mongoClient, mongoDB;
let sessionsCol, numbersCol, adminsCol, newsletterCol, configsCol, newsletterReactsCol, groupsCol;

async function initMongo() {
  try {
    if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected && mongoClient.topology.isConnected()) return;
  } catch(e){}
  // Removed deprecated options for compatibility with newer drivers
  mongoClient = new MongoClient(MONGO_URI, { 
      serverSelectionTimeoutMS: 5000 
  });
  await mongoClient.connect();
  mongoDB = mongoClient.db(MONGO_DB);

  sessionsCol = mongoDB.collection('sessions');
  numbersCol = mongoDB.collection('numbers');
  adminsCol = mongoDB.collection('admins');
  newsletterCol = mongoDB.collection('newsletter_list');
  configsCol = mongoDB.collection('configs');
  newsletterReactsCol = mongoDB.collection('newsletter_reacts');
  groupsCol = mongoDB.collection('groups');

  // Indexes
  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  await newsletterCol.createIndex({ jid: 1 }, { unique: true });
  await newsletterReactsCol.createIndex({ jid: 1 }, { unique: true });
  await configsCol.createIndex({ number: 1 }, { unique: true });
  await groupsCol.createIndex({ _id: 1 }, { unique: true });
  console.log('✅ Mongo initialized and collections ready');
}

// ---------------- Mongo Helpers ----------------
const mongoHelpers = {
    saveCredsToMongo: async (number, creds, keys = null) => {
        try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await sessionsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, creds, keys, updatedAt: new Date() } }, { upsert: true }); } catch (e) { console.error('saveCreds error:', e); }
    },
    loadCredsFromMongo: async (number) => {
        try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); return await sessionsCol.findOne({ number: sanitized }); } catch (e) { return null; }
    },
    removeSessionFromMongo: async (number) => {
        try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await sessionsCol.deleteOne({ number: sanitized }); } catch (e) {}
    },
    addNumberToMongo: async (number) => {
        try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true }); } catch (e) {}
    },
    removeNumberFromMongo: async (number) => {
        try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await numbersCol.deleteOne({ number: sanitized }); } catch (e) {}
    },
    getAllNumbersFromMongo: async () => {
        try { await initMongo(); const docs = await numbersCol.find({}).toArray(); return docs.map(d => d.number); } catch (e) { return []; }
    },
    loadAdminsFromMongo: async () => {
        try { await initMongo(); const docs = await adminsCol.find({}).toArray(); return docs.map(d => d.jid || d.number).filter(Boolean); } catch (e) { return []; }
    },
    addAdminToMongo: async (jidOrNumber) => {
        try { await initMongo(); await adminsCol.updateOne({ jid: jidOrNumber }, { $set: { jid: jidOrNumber } }, { upsert: true }); } catch (e) {}
    },
    removeAdminFromMongo: async (jidOrNumber) => {
        try { await initMongo(); await adminsCol.deleteOne({ jid: jidOrNumber }); } catch (e) {}
    },
    addNewsletterToMongo: async (jid, emojis = []) => {
        try { await initMongo(); await newsletterCol.updateOne({ jid }, { $set: { jid, emojis, addedAt: new Date() } }, { upsert: true }); } catch (e) {}
    },
    removeNewsletterFromMongo: async (jid) => {
        try { await initMongo(); await newsletterCol.deleteOne({ jid }); } catch (e) {}
    },
    listNewslettersFromMongo: async () => {
        try { await initMongo(); return await newsletterCol.find({}).toArray(); } catch (e) { return []; }
    },
    setUserConfigInMongo: async (number, conf) => {
        try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); await configsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, config: conf, updatedAt: new Date() } }, { upsert: true }); } catch (e) {}
    },
    loadUserConfigFromMongo: async (number) => {
        try { await initMongo(); const sanitized = number.replace(/[^0-9]/g, ''); const doc = await configsCol.findOne({ number: sanitized }); return doc ? doc.config : null; } catch (e) { return null; }
    },
    listNewsletterReactsFromMongo: async () => {
        try { await initMongo(); return await newsletterReactsCol.find({}).toArray(); } catch (e) { return []; }
    },
    saveNewsletterReaction: async (jid, messageId, emoji, sessionNumber) => {
        try { await initMongo(); await mongoDB.collection('newsletter_reactions_log').insertOne({ jid, messageId, emoji, sessionNumber, ts: new Date() }); } catch (e) {}
    },
    getGroupSettings: async (jid) => {
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
    },
    updateGroupSettings: async (jid, update) => {
        try {
            await initMongo();
            await groupsCol.updateOne({ _id: jid }, { $set: update }, { upsert: true });
        } catch (e) { console.error('Error updating group settings:', e); }
    },
    isGroupAdmin: async (socket, groupJid, userJid) => {
        try {
            const metadata = await socket.groupMetadata(groupJid);
            const participant = metadata.participants.find(p => p.id === userJid);
            return participant && ['admin', 'superadmin'].includes(participant.admin);
        } catch { return false; }
    },
    isBotAdmin: async (socket, groupJid) => {
        const botJid = socket.user.id.split(':')[0] + '@s.whatsapp.net';
        try {
            const metadata = await socket.groupMetadata(groupJid);
            const participant = metadata.participants.find(p => p.id === botJid);
            return participant && ['admin', 'superadmin'].includes(participant.admin);
        } catch { return false; }
    }
};

// ---------------- LOCAL HELPERS ----------------

function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }
function getZimbabweanTimestamp(){ return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss'); }

// Fake VCard for the initial connection message
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
  const admins = await mongoHelpers.loadAdminsFromMongo();
  const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`;
  const botName = sessionConfig.botName || BOT_NAME_FREE;
  const image = sessionConfig.logo || config.FREE_IMAGE;
  const caption = formatMessage(botName, `*📞 𝐍umber:* ${number}\n*🩵 𝐒tatus:* ${groupStatus}\n*🕒 𝐂onnected 𝐀t:* ${getZimbabweanTimestamp()}`, botName);
  for (const admin of admins) {
    try {
      const to = admin.includes('@') ? admin : `${admin}@s.whatsapp.net`;
      let imagePayload;
      if (String(image).startsWith('http')) {
        imagePayload = { url: image };
      } else {
        try { imagePayload = fs.readFileSync(image); } 
        catch (e) { imagePayload = { url: config.FREE_IMAGE }; }
      }
      await socket.sendMessage(to, { image: imagePayload, caption }, { quoted: fakevcard });
    } catch (err) {}
  }
}

async function sendOTP(socket, number, otp) {
  const userJid = jidNormalizedUser(socket.user.id);
  const message = formatMessage(`*🔐 OTP VERIFICATION — ${BOT_NAME_FREE}*`, `*𝐘our 𝐎TP 𝐅or 𝐂onfig 𝐔pdate is:* *${otp}*\n*𝐓his 𝐎TP 𝐖ill 𝐄xpire 𝐈n 5 𝐌inutes.*\n\n*𝐍umber:* ${number}`, BOT_NAME_FREE);
  try { await socket.sendMessage(userJid, { text: message }); }
  catch (error) { throw error; }
}

// ---------------- HANDLERS ----------------

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        await handleCommand(socket, msg, {
            config,
            mongo: mongoHelpers,
            store: { 
                activeSockets, 
                socketCreationTime, 
                otpStore, 
                bannedUsers, 
                callBlockers, 
                commandLogs 
            }
        });
    });
}

function setupMessageHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;
    if (config.AUTO_RECORDING === 'true') {
      try { await socket.sendPresenceUpdate('recording', msg.key.remoteJid); } catch (e) {}
    }
  });
}

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
        console.log(`User ${number} logged out.`);
        try { await deleteSessionAndCleanup(number, socket); } catch(e){ console.error(e); }
      } else {
        console.log(`Connection closed for ${number}. Reconnecting...`);
        try { await delay(10000); activeSockets.delete(number.replace(/[^0-9]/g,'')); socketCreationTime.delete(number.replace(/[^0-9]/g,'')); const mockRes = { headersSent:false, send:() => {}, status: () => mockRes }; await EmpirePair(number, mockRes); } catch(e){ console.error('Reconnect failed', e); }
      }
    }
  });
}

async function deleteSessionAndCleanup(number, socketInstance) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    const sessionPath = path.join(os.tmpdir(), `session_${sanitized}`);
    try { if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); } catch(e){}
    activeSockets.delete(sanitized); socketCreationTime.delete(sanitized);
    try { await mongoHelpers.removeSessionFromMongo(sanitized); } catch(e){}
    try { await mongoHelpers.removeNumberFromMongo(sanitized); } catch(e){}
    console.log(`Cleanup completed for ${sanitized}`);
  } catch (err) { console.error('deleteSessionAndCleanup error:', err); }
}

async function setupNewsletterHandlers(socket, sessionNumber) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        // Keeping basic reaction logic can go here if needed
    });
}

async function handleMessageRevocation(socket, number) {
  socket.ev.on('messages.delete', async ({ keys }) => {
    if (!keys || keys.length === 0) return;
    const messageKey = keys[0];
    const userJid = jidNormalizedUser(socket.user.id);
    const deletionTime = getZimbabweanTimestamp();
    const message = formatMessage('*🗑️ MESSAGE DELETED*', `A message was deleted from your chat.\n*📄 𝐅rom:* ${messageKey.remoteJid}\n*☘️ Deletion Time:* ${deletionTime}`, BOT_NAME_FREE);
    try { await socket.sendMessage(userJid, { image: { url: config.FREE_IMAGE }, caption: message }, { quoted: fakevcard }); }
    catch (error) {}
  });
}

async function setupStatusHandlers(socket) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
    try {
      if (config.AUTO_RECORDING === 'true') await socket.sendPresenceUpdate("recording", message.key.remoteJid);
      if (config.AUTO_VIEW_STATUS === 'true') await socket.readMessages([message.key]);
      if (config.AUTO_LIKE_STATUS === 'true') {
        const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
        await socket.sendMessage(message.key.remoteJid, { react: { text: randomEmoji, key: message.key } }, { statusJidList: [message.key.participant] });
      }
    } catch (error) {}
  });
}

// ---------------- MAIN CONNECTION LOGIC ----------------

async function EmpirePair(number, res) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  await initMongo().catch(()=>{});
  
  try {
    const mongoDoc = await mongoHelpers.loadCredsFromMongo(sanitizedNumber);
    if (mongoDoc && mongoDoc.creds) {
      fs.ensureDirSync(sessionPath);
      fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
      if (mongoDoc.keys) fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
    }
  } catch (e) {}

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const logger = pino({ level: 'fatal' });

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
      await saveCreds();
      const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
      const keysObj = state.keys || null;
      await mongoHelpers.saveCredsToMongo(sanitizedNumber, JSON.parse(fileContent), keysObj);
    });

    socket.ev.on('connection.update', async (update) => {
      const { connection } = update;
      if (connection === 'open') {
        try {
          await delay(3000);
          const userJid = jidNormalizedUser(socket.user.id);
          const groupResult = await joinGroup(socket).catch(()=>({ status: 'failed', error: 'joinGroup' }));
          
          activeSockets.set(sanitizedNumber, socket);
          await mongoHelpers.addNumberToMongo(sanitizedNumber);
          
          // ✅ Get User Config for styled message
          const userConfig = await mongoHelpers.loadUserConfigFromMongo(sanitizedNumber) || {};
          const useBotName = userConfig.botName || BOT_NAME_FREE;
          const useLogo = userConfig.logo || config.FREE_IMAGE;

          // ✅ Styled Connection Message
          const connectedCaption = formatMessage(useBotName,
            `*✅ 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥 𝘚𝘶𝘤𝘤𝘦𝘴𝘴𝘧𝘶𝘭𝘭𝘺*\n\n*🔢 𝘊𝘩𝘢𝘵 𝘕𝘣:*  ${sanitizedNumber}\n*🕒 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥*: ${getZimbabweanTimestamp()}\n\n_Bot is now active! Type .menu to begin._`,
            useBotName
          );

          let imagePayload;
          if (String(useLogo).startsWith('http')) {
              imagePayload = { url: useLogo };
          } else {
              try { imagePayload = fs.readFileSync(useLogo); }
              catch(e) { imagePayload = { url: config.FREE_IMAGE }; }
          }

          // Send to Self
          await socket.sendMessage(userJid, { 
              image: imagePayload, 
              caption: connectedCaption,
              footer: config.BOT_FOOTER,
              headerType: 4
          }, { quoted: fakevcard });

          // Send to Admins
          await sendAdminConnectMessage(socket, sanitizedNumber, groupResult, userConfig);

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
    socketCreationTime.delete(sanitizedNumber);
    if (!res.headersSent) res.status(503).send({ error: 'Service Unavailable' });
  }
}

// ---------------- ROUTES ----------------

router.post('/newsletter/add', async (req, res) => {
  const { jid, emojis } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try { await mongoHelpers.addNewsletterToMongo(jid, emojis); res.status(200).send({ status: 'ok', jid }); } 
  catch (e) { res.status(500).send({ error: e.message }); }
});

router.post('/admin/add', async (req, res) => {
  const { jid } = req.body;
  if (!jid) return res.status(400).send({ error: 'jid required' });
  try { await mongoHelpers.addAdminToMongo(jid); res.status(200).send({ status: 'ok', jid }); } 
  catch (e) { res.status(500).send({ error: e.message }); }
});

router.get('/', async (req, res) => {
  const { number } = req.query;
  if (!number) return res.status(400).send({ error: 'Number parameter is required' });
  if (activeSockets.has(number.replace(/[^0-9]/g, ''))) return res.status(200).send({ status: 'already_connected' });
  await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
  res.status(200).send({ botName: BOT_NAME_FREE, count: activeSockets.size, numbers: Array.from(activeSockets.keys()), timestamp: getZimbabweanTimestamp() });
});

router.get('/update-config', async (req, res) => {
  const { number, config: configString } = req.query;
  if (!number || !configString) return res.status(400).send({ error: 'Missing params' });
  let newConfig;
  try { newConfig = JSON.parse(configString); } catch (error) { return res.status(400).send({ error: 'Invalid config' }); }
  const sanitized = number.replace(/[^0-9]/g, '');
  const socket = activeSockets.get(sanitized);
  if (!socket) return res.status(404).send({ error: 'No active session' });
  
  const otp = generateOTP();
  otpStore.set(sanitized, { otp, expiry: Date.now() + config.OTP_EXPIRY, newConfig });
  try { await sendOTP(socket, sanitized, otp); res.status(200).send({ status: 'otp_sent' }); }
  catch (error) { otpStore.delete(sanitized); res.status(500).send({ error: 'Failed to send OTP' }); }
});

router.get('/verify-otp', async (req, res) => {
  const { number, otp } = req.query;
  if (!number || !otp) return res.status(400).send({ error: 'Missing params' });
  const sanitized = number.replace(/[^0-9]/g, '');
  const data = otpStore.get(sanitized);
  if (!data) return res.status(400).send({ error: 'No request found' });
  if (Date.now() >= data.expiry) { otpStore.delete(sanitized); return res.status(400).send({ error: 'Expired' }); }
  if (data.otp !== otp) return res.status(400).send({ error: 'Invalid OTP' });
  
  try {
    await mongoHelpers.setUserConfigInMongo(sanitized, data.newConfig);
    otpStore.delete(sanitized);
    const sock = activeSockets.get(sanitized);
    if (sock) await sock.sendMessage(jidNormalizedUser(sock.user.id), { text: '✅ Configuration updated successfully!' });
    res.status(200).send({ status: 'success' });
  } catch (error) { res.status(500).send({ error: 'Update failed' }); }
});

// Dashboard Static
const dashboardStaticDir = path.join(__dirname, 'dashboard_static');
if (!fs.existsSync(dashboardStaticDir)) fs.ensureDirSync(dashboardStaticDir);
router.use('/dashboard/static', express.static(dashboardStaticDir));
router.get('/dashboard', async (req, res) => { res.sendFile(path.join(dashboardStaticDir, 'index.html')); });

// Process Events
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
});

// Init
initMongo().catch(err => console.warn('Mongo init failed', err));
(async()=>{ try { const nums = await mongoHelpers.getAllNumbersFromMongo(); if (nums && nums.length) { for (const n of nums) { if (!activeSockets.has(n)) { const mockRes = { headersSent:false, send:()=>{}, status:()=>mockRes }; await EmpirePair(n, mockRes); await delay(500); } } } } catch(e){} })();

module.exports = router;
