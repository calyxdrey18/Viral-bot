const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');

// Import the split command handler
const handleCommand = require('./commands'); 

const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
  DisconnectReason,
  fetchLatestBaileysVersion
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
const activeSessions = new Map();
const userConfigs = new Map();
const pairingAttempts = new Map();

// In-memory helpers
const memoryHelpers = {
    addNumber: (number) => {
        const sanitized = number.replace(/[^0-9]/g, '');
        activeSessions.set(sanitized, true);
        return sanitized;
    },
    removeNumber: (number) => {
        const sanitized = number.replace(/[^0-9]/g, '');
        activeSessions.delete(sanitized);
        return sanitized;
    },
    getAllNumbers: () => Array.from(activeSessions.keys()),
    setUserConfig: (number, conf) => {
        const sanitized = number.replace(/[^0-9]/g, '');
        userConfigs.set(sanitized, conf);
        return sanitized;
    },
    getUserConfig: (number) => {
        const sanitized = number.replace(/[^0-9]/g, '');
        return userConfigs.get(sanitized) || {};
    },
    incrementPairingAttempt: (number) => {
        const sanitized = number.replace(/[^0-9]/g, '');
        const attempts = pairingAttempts.get(sanitized) || 0;
        pairingAttempts.set(sanitized, attempts + 1);
        return attempts + 1;
    },
    getPairingAttempts: (number) => {
        const sanitized = number.replace(/[^0-9]/g, '');
        return pairingAttempts.get(sanitized) || 0;
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
  // Since no MongoDB admins, only send to owner
  const adminJid = config.OWNER_NUMBER + '@s.whatsapp.net';
  const groupStatus = groupResult.status === 'success' ? `Joined (ID: ${groupResult.gid})` : `Failed to join group: ${groupResult.error}`;
  const botName = sessionConfig.botName || BOT_NAME_FREE;
  const image = sessionConfig.logo || config.FREE_IMAGE;
  const caption = formatMessage(botName, `*📞 𝐍umber:* ${number}\n*🩵 𝐒tatus:* ${groupStatus}\n*🕒 𝐂onnected 𝐀t:* ${getZimbabweanTimestamp()}`, botName);
  
  try {
    let imagePayload;
    if (String(image).startsWith('http')) {
        imagePayload = { url: image };
    } else {
        try { imagePayload = fs.readFileSync(image); } 
        catch (e) { imagePayload = { url: config.FREE_IMAGE }; }
    }
    await socket.sendMessage(adminJid, { image: imagePayload, caption }, { quoted: fakevcard });
  } catch (err) {}
}

// ---------------- HANDLERS ----------------

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        await handleCommand(socket, msg, {
            config,
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
        console.log(`User ${number} logged out. Cleaning up...`);
        try { await deleteSessionAndCleanup(number, socket); } catch(e){ console.error(e); }
      } else {
        console.log(`Connection closed for ${number}. Attempting reconnect in 5 seconds...`);
        try { 
          await delay(5000); 
          activeSockets.delete(number.replace(/[^0-9]/g,'')); 
          socketCreationTime.delete(number.replace(/[^0-9]/g,'')); 
          console.log(`Reconnecting ${number}...`);
          // Don't auto-reconnect - let user initiate new pairing
        } catch(e){ console.error('Reconnect cleanup failed', e); }
      }
    }
  });
}

async function deleteSessionAndCleanup(number, socketInstance) {
  const sanitized = number.replace(/[^0-9]/g, '');
  try {
    const sessionPath = path.join(os.tmpdir(), `session_${sanitized}`);
    try { 
      if (fs.existsSync(sessionPath)) {
        console.log(`Cleaning session directory for ${sanitized}`);
        await fs.remove(sessionPath); 
      }
    } catch(e){ console.error('Session cleanup error:', e); }
    
    activeSockets.delete(sanitized); 
    socketCreationTime.delete(sanitized);
    memoryHelpers.removeNumber(sanitized);
    
    // Try to close socket gracefully
    try {
      if (socketInstance && socketInstance.ws && socketInstance.ws.readyState !== 3) {
        socketInstance.ws.close();
      }
    } catch(e) {}
    
    console.log(`Cleanup completed for ${sanitized}`);
  } catch (err) { 
    console.error('deleteSessionAndCleanup error:', err); 
  }
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
  
  // Track pairing attempts
  const attempt = memoryHelpers.incrementPairingAttempt(sanitizedNumber);
  console.log(`Pairing attempt ${attempt} for ${sanitizedNumber}`);
  
  try {
    // Clean up any existing session first
    if (activeSockets.has(sanitizedNumber)) {
      console.log(`Cleaning existing session for ${sanitizedNumber}`);
      const oldSocket = activeSockets.get(sanitizedNumber);
      await deleteSessionAndCleanup(sanitizedNumber, oldSocket);
      await delay(1000);
    }
    
    // Ensure session directory exists
    await fs.ensureDir(sessionPath);
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' }); // Reduced logging
    
    // Get latest version for better compatibility
    const { version } = await fetchLatestBaileysVersion();
    
    const socket = makeWASocket({
      auth: { 
        creds: state.creds, 
        keys: makeCacheableSignalKeyStore(state.keys, logger) 
      },
      printQRInTerminal: false,
      logger,
      browser: Browsers.macOS('Safari'),
      version: version,
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: true,
      retryRequestDelayMs: 1000,
      maxMsgRetryCount: 3,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000
    });

    socketCreationTime.set(sanitizedNumber, Date.now());

    // Setup handlers
    setupStatusHandlers(socket);
    setupCommandHandlers(socket, sanitizedNumber);
    setupMessageHandlers(socket);
    setupAutoRestart(socket, sanitizedNumber);
    handleMessageRevocation(socket, sanitizedNumber);

    // Check if already registered
    if (!socket.authState.creds.registered) {
      console.log(`Requesting pairing code for ${sanitizedNumber}`);
      let retries = config.MAX_RETRIES;
      let code;
      let success = false;
      
      while (retries > 0 && !success) {
        try {
          await delay(2000);
          code = await socket.requestPairingCode(sanitizedNumber);
          console.log(`Got pairing code for ${sanitizedNumber}: ${code}`);
          success = true;
          break;
        } catch (error) {
          retries--;
          console.error(`Pairing code attempt failed for ${sanitizedNumber}:`, error.message);
          if (retries > 0) {
            await delay(3000 * (config.MAX_RETRIES - retries));
          }
        }
      }
      
      if (success && code) {
        if (!res.headersSent) {
          res.send({ 
            code,
            status: 'success',
            message: 'Pairing code generated successfully',
            attempts: attempt
          });
        }
      } else {
        if (!res.headersSent) {
          res.status(500).send({ 
            error: 'Failed to generate pairing code after multiple attempts',
            status: 'failed'
          });
        }
      }
      return; // Stop here for pairing
    }

    // Handle credential updates
    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        console.log(`Credentials updated for ${sanitizedNumber}`);
      } catch (e) {
        console.error('Error saving creds:', e);
      }
    });

    // Handle connection updates
    socket.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log(`QR code received for ${sanitizedNumber}`);
      }
      
      if (connection === 'open') {
        console.log(`✅ Connection opened for ${sanitizedNumber}`);
        try {
          await delay(3000);
          const userJid = jidNormalizedUser(socket.user.id);
          
          // Join group if configured
          let groupResult = { status: 'skipped' };
          if (config.GROUP_INVITE_LINK) {
            groupResult = await joinGroup(socket).catch(()=>({ status: 'failed', error: 'joinGroup failed' }));
          }
          
          // Store active socket
          activeSockets.set(sanitizedNumber, socket);
          memoryHelpers.addNumber(sanitizedNumber);
          
          // Get user config
          const userConfig = memoryHelpers.getUserConfig(sanitizedNumber);
          const useBotName = userConfig.botName || BOT_NAME_FREE;
          const useLogo = userConfig.logo || config.FREE_IMAGE;

          // Send connection success message
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

          // Send welcome message
          await socket.sendMessage(userJid, { 
              image: imagePayload, 
              caption: connectedCaption,
              footer: config.BOT_FOOTER,
              headerType: 4
          }, { quoted: fakevcard });

          // Send admin notification
          await sendAdminConnectMessage(socket, sanitizedNumber, groupResult, userConfig);
          
          console.log(`✅ ${sanitizedNumber} is now fully connected and active`);

        } catch (e) { 
            console.error('Connection open error:', e); 
        }
      }
      
      if (connection === 'close') {
        console.log(`Connection closed for ${sanitizedNumber}`);
        const shouldReconnect = (lastDisconnect?.error?.output?.statusCode !== 401);
        
        if (!shouldReconnect) {
          console.log(`User ${sanitizedNumber} logged out or disconnected`);
          try { 
            await deleteSessionAndCleanup(sanitizedNumber, socket); 
          } catch(e) { 
            console.error('Cleanup error on close:', e); 
          }
        }
      }
    });

    // Store socket reference
    activeSockets.set(sanitizedNumber, socket);
    
    // If already connected and registered, return success
    if (socket.authState.creds.registered && !res.headersSent) {
      res.send({ 
        status: 'already_connected',
        message: 'Already connected and ready',
        number: sanitizedNumber
      });
    }

  } catch (error) {
    console.error(`EmpirePair error for ${sanitizedNumber}:`, error);
    
    // Clean up on error
    socketCreationTime.delete(sanitizedNumber);
    activeSockets.delete(sanitizedNumber);
    
    if (!res.headersSent) {
      res.status(200).send({ 
        error: 'Connection attempt completed',
        details: error.message,
        status: 'processing',
        message: 'Please check your WhatsApp for pairing request'
      });
    }
  }
}

// ---------------- ROUTES ----------------

router.get('/', async (req, res) => {
  const { number } = req.query;
  
  if (!number) {
    return res.status(400).send({ 
      error: 'Number parameter is required',
      example: '/code?number=263786624966'
    });
  }
  
  // Validate number
  const cleanNumber = number.replace(/[^0-9]/g, '');
  if (cleanNumber.length < 10) {
    return res.status(400).send({ 
      error: 'Invalid phone number',
      message: 'Number should be at least 10 digits'
    });
  }
  
  console.log(`New pairing request for: ${cleanNumber}`);
  
  try {
    await EmpirePair(cleanNumber, res);
  } catch (err) {
    console.error('Route handler error:', err);
    if (!res.headersSent) {
      res.status(200).send({ 
        status: 'processing',
        message: 'Please try again in a moment'
      });
    }
  }
});

router.get('/active', (req, res) => {
  const activeList = Array.from(activeSockets.keys()).map(num => ({
    number: num,
    connectedSince: socketCreationTime.get(num) ? 
      new Date(socketCreationTime.get(num)).toISOString() : 'Unknown',
    uptime: socketCreationTime.get(num) ? 
      Math.floor((Date.now() - socketCreationTime.get(num)) / 1000) + 's' : 'Unknown'
  }));
  
  res.status(200).send({ 
    botName: BOT_NAME_FREE, 
    count: activeSockets.size, 
    activeSessions: activeList,
    timestamp: getZimbabweanTimestamp() 
  });
});

router.get('/status/:number', (req, res) => {
  const { number } = req.params;
  const cleanNumber = number.replace(/[^0-9]/g, '');
  const isConnected = activeSockets.has(cleanNumber);
  
  res.status(200).send({
    number: cleanNumber,
    connected: isConnected,
    connectedSince: isConnected && socketCreationTime.get(cleanNumber) ? 
      new Date(socketCreationTime.get(cleanNumber)).toISOString() : null,
    pairingAttempts: memoryHelpers.getPairingAttempts(cleanNumber)
  });
});

router.get('/disconnect/:number', async (req, res) => {
  const { number } = req.params;
  const cleanNumber = number.replace(/[^0-9]/g, '');
  
  if (activeSockets.has(cleanNumber)) {
    const socket = activeSockets.get(cleanNumber);
    try {
      await deleteSessionAndCleanup(cleanNumber, socket);
      res.status(200).send({ 
        status: 'success',
        message: `Disconnected ${cleanNumber}`
      });
    } catch (err) {
      res.status(500).send({ 
        error: 'Failed to disconnect',
        details: err.message 
      });
    }
  } else {
    res.status(404).send({ 
      error: 'Not found',
      message: `No active connection found for ${cleanNumber}`
    });
  }
});

router.get('/update-config', async (req, res) => {
  const { number, config: configString } = req.query;
  if (!number || !configString) return res.status(400).send({ error: 'Missing params' });
  
  let newConfig;
  try { 
    newConfig = JSON.parse(configString); 
  } catch (error) { 
    return res.status(400).send({ error: 'Invalid config JSON' }); 
  }
  
  const sanitized = number.replace(/[^0-9]/g, '');
  memoryHelpers.setUserConfig(sanitized, newConfig);
  
  res.status(200).send({ 
    status: 'success', 
    message: 'Config updated in memory',
    number: sanitized 
  });
});

// Health check endpoint
router.get('/health', (req, res) => {
  res.status(200).send({
    status: 'ok',
    timestamp: getZimbabweanTimestamp(),
    activeConnections: activeSockets.size,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime()
  });
});

// Process Events
process.on('exit', () => {
  console.log('Cleaning up all sessions on exit...');
  activeSockets.forEach((socket, number) => {
    try { 
      if (socket && socket.ws) socket.ws.close(); 
    } catch (e) {}
    activeSockets.delete(number);
    socketCreationTime.delete(number);
    try { 
      const sessionPath = path.join(os.tmpdir(), `session_${number}`);
      if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath); 
    } catch(e){}
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

module.exports = router;