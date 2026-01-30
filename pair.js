const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const qrcode = require('qrcode');

// Import the command handler
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
const bannedUsers = new Map(); 
const callBlockers = new Map(); 
const commandLogs = []; 
const activeSessions = new Map();
const userConfigs = new Map();
const pairingCodes = new Map(); // Store pairing codes temporarily

// Fake VCard
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

// ---------------- HELPER FUNCTIONS ----------------
function formatMessage(title, content, footer) {
  return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function getZimbabweanTimestamp(){ 
  return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss'); 
}

function generateSessionId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// ---------------- SESSION MANAGEMENT ----------------
async function createWhatsAppSession(number) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionId = generateSessionId();
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}_${sessionId}`);
  
  console.log(`Creating session for ${sanitizedNumber} at ${sessionPath}`);
  
  try {
    // Ensure session directory exists
    await fs.ensureDir(sessionPath);
    
    // Create initial credentials if they don't exist
    const credsPath = path.join(sessionPath, 'creds.json');
    if (!fs.existsSync(credsPath)) {
      await fs.writeJSON(credsPath, {
        noiseKey: { private: {}, public: {} },
        signedIdentityKey: { private: {}, public: {} },
        signedPreKey: { keyPair: {} },
        registrationId: 0,
        advSecretKey: '',
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSettings: { unarchiveChats: false }
      });
    }
    
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'silent' });
    
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
      emitOwnEvents: true,
      defaultQueryTimeoutMs: 60000,
      connectTimeoutMs: 30000,
      keepAliveIntervalMs: 15000
    });
    
    return { socket, state, saveCreds, sessionPath };
  } catch (error) {
    console.error('Error creating WhatsApp session:', error);
    throw error;
  }
}

// ---------------- PAIRING CODE GENERATION ----------------
async function generatePairingCode(socket, number) {
  try {
    console.log(`Requesting pairing code for ${number}`);
    
    // Request pairing code from WhatsApp
    const code = await socket.requestPairingCode(number);
    
    if (!code || code.length !== 6) {
      throw new Error('Invalid pairing code received');
    }
    
    console.log(`✅ Successfully generated pairing code for ${number}: ${code}`);
    
    // Store the code temporarily (expires in 2 minutes)
    pairingCodes.set(number, {
      code: code,
      timestamp: Date.now(),
      expiresAt: Date.now() + 120000 // 2 minutes
    });
    
    // Clean up expired codes
    setTimeout(() => {
      if (pairingCodes.has(number)) {
        pairingCodes.delete(number);
      }
    }, 120000);
    
    return code;
  } catch (error) {
    console.error(`Failed to generate pairing code for ${number}:`, error);
    throw error;
  }
}

// ---------------- BOT CONNECTION HANDLER ----------------
async function connectBot(number, sessionData) {
  const { socket, saveCreds, sessionPath } = sessionData;
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  
  return new Promise((resolve, reject) => {
    let connectionTimeout = setTimeout(() => {
      reject(new Error('Connection timeout'));
    }, 60000);
    
    // Handle credentials update
    socket.ev.on('creds.update', async () => {
      try {
        await saveCreds();
        console.log(`Credentials updated for ${sanitizedNumber}`);
      } catch (e) {
        console.error('Error saving credentials:', e);
      }
    });
    
    // Handle connection updates
    socket.ev.on('connection.update', async (update) => {
      const { connection, qr } = update;
      
      if (qr) {
        console.log(`QR code generated for ${sanitizedNumber}`);
        // You could send QR code to frontend here if needed
      }
      
      if (connection === 'open') {
        console.log(`✅ WhatsApp connection opened for ${sanitizedNumber}`);
        clearTimeout(connectionTimeout);
        
        try {
          // Store active socket
          activeSockets.set(sanitizedNumber, socket);
          socketCreationTime.set(sanitizedNumber, Date.now());
          activeSessions.set(sanitizedNumber, {
            socket: socket,
            connectedAt: Date.now(),
            sessionPath: sessionPath
          });
          
          // Setup command handlers
          setupCommandHandlers(socket, sanitizedNumber);
          
          // Send welcome message
          await sendWelcomeMessage(socket, sanitizedNumber);
          
          // Try to join group if configured
          if (config.GROUP_INVITE_LINK) {
            await joinGroup(socket);
          }
          
          resolve({
            success: true,
            number: sanitizedNumber,
            message: 'Bot connected successfully'
          });
        } catch (error) {
          console.error('Error in connection setup:', error);
          reject(error);
        }
      }
      
      if (connection === 'close') {
        console.log(`Connection closed for ${sanitizedNumber}`);
        cleanupSession(sanitizedNumber);
      }
    });
    
    // Handle errors
    socket.ev.on('connection.error', (error) => {
      console.error(`Connection error for ${sanitizedNumber}:`, error);
      clearTimeout(connectionTimeout);
      reject(error);
    });
  });
}

// ---------------- SETUP COMMAND HANDLERS ----------------
function setupCommandHandlers(socket, number) {
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    await handleCommand(socket, msg, {
      config,
      store: { 
        activeSockets, 
        socketCreationTime, 
        bannedUsers, 
        callBlockers, 
        commandLogs 
      }
    });
  });
  
  // Auto status viewing/liking
  socket.ev.on('messages.upsert', async ({ messages }) => {
    const message = messages[0];
    if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant) return;
    
    try {
      if (config.AUTO_VIEW_STATUS === 'true') {
        await socket.readMessages([message.key]);
      }
      if (config.AUTO_LIKE_STATUS === 'true') {
        const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
        await socket.sendMessage(message.key.remoteJid, { 
          react: { text: randomEmoji, key: message.key } 
        }, { statusJidList: [message.key.participant] });
      }
    } catch (error) {
      // Silent fail for status updates
    }
  });
}

// ---------------- SEND WELCOME MESSAGE ----------------
async function sendWelcomeMessage(socket, number) {
  try {
    const userJid = jidNormalizedUser(socket.user.id);
    const userConfig = userConfigs.get(number) || {};
    const botName = userConfig.botName || BOT_NAME_FREE;
    const logo = userConfig.logo || config.FREE_IMAGE;
    
    const welcomeText = formatMessage(botName,
      `*✅ 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥 𝘚𝘶𝘤𝘤𝘦𝘴𝘴𝘧𝘶𝘭𝘭𝘺*\n\n*🔢 𝘊𝘩𝘢𝘵 𝘕𝘣:*  ${number}\n*🕒 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥*: ${getZimbabweanTimestamp()}\n\n_Bot is now active! Type .menu to begin._`,
      botName
    );
    
    let imagePayload = { url: logo };
    
    await socket.sendMessage(userJid, { 
      image: imagePayload, 
      caption: welcomeText,
      footer: config.BOT_FOOTER,
      headerType: 4
    }, { quoted: fakevcard });
    
    console.log(`Welcome message sent to ${number}`);
  } catch (error) {
    console.error('Error sending welcome message:', error);
  }
}

// ---------------- JOIN GROUP ----------------
async function joinGroup(socket) {
  try {
    const inviteCodeMatch = config.GROUP_INVITE_LINK.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
    if (!inviteCodeMatch) return { success: false, error: 'Invalid invite link' };
    
    const inviteCode = inviteCodeMatch[1];
    const response = await socket.groupAcceptInvite(inviteCode);
    
    if (response?.gid) {
      console.log(`✅ Joined group: ${response.gid}`);
      return { success: true, groupId: response.gid };
    }
    
    return { success: false, error: 'Failed to join group' };
  } catch (error) {
    console.error('Error joining group:', error);
    return { success: false, error: error.message };
  }
}

// ---------------- CLEANUP ----------------
function cleanupSession(number) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  
  if (activeSessions.has(sanitizedNumber)) {
    const session = activeSessions.get(sanitizedNumber);
    
    try {
      // Close socket
      if (session.socket && session.socket.ws) {
        session.socket.ws.close();
      }
      
      // Clean up session directory
      if (session.sessionPath && fs.existsSync(session.sessionPath)) {
        fs.removeSync(session.sessionPath);
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
    
    // Remove from maps
    activeSockets.delete(sanitizedNumber);
    socketCreationTime.delete(sanitizedNumber);
    activeSessions.delete(sanitizedNumber);
    userConfigs.delete(sanitizedNumber);
    
    console.log(`Cleaned up session for ${sanitizedNumber}`);
  }
}

// ---------------- ROUTES ----------------

// Main pairing endpoint
router.get('/', async (req, res) => {
  const { number } = req.query;
  
  if (!number) {
    return res.status(400).json({ 
      error: 'Phone number is required',
      example: '/code?number=263786624966'
    });
  }
  
  const cleanNumber = number.replace(/[^0-9]/g, '');
  
  if (cleanNumber.length < 10) {
    return res.status(400).json({ 
      error: 'Invalid phone number',
      message: 'Number should be at least 10 digits'
    });
  }
  
  console.log(`Pairing request for: ${cleanNumber}`);
  
  try {
    // Check if already connected
    if (activeSockets.has(cleanNumber)) {
      return res.json({
        status: 'already_connected',
        message: 'This number is already connected to the bot',
        number: cleanNumber,
        connectedSince: socketCreationTime.get(cleanNumber) ? 
          new Date(socketCreationTime.get(cleanNumber)).toLocaleString() : 'Unknown'
      });
    }
    
    // Create new session
    const sessionData = await createWhatsAppSession(cleanNumber);
    
    // Generate pairing code
    const pairingCode = await generatePairingCode(sessionData.socket, cleanNumber);
    
    // Store session data temporarily (will be connected after pairing)
    activeSessions.set(cleanNumber, {
      socket: sessionData.socket,
      sessionData: sessionData,
      pairingCode: pairingCode,
      pairingTime: Date.now()
    });
    
    // Set up connection handler for after pairing
    setupConnectionHandler(sessionData.socket, cleanNumber, sessionData);
    
    // Return pairing code to user
    res.json({
      success: true,
      code: pairingCode,
      message: 'Pairing code generated successfully',
      instructions: 'Open WhatsApp → Settings → Linked Devices → Link a Device → Enter this code',
      expiresIn: '2 minutes',
      number: cleanNumber
    });
    
  } catch (error) {
    console.error('Pairing error:', error);
    
    // Clean up on error
    cleanupSession(cleanNumber);
    
    res.status(500).json({
      error: 'Failed to generate pairing code',
      details: error.message,
      message: 'Please try again or check if the number is valid'
    });
  }
});

// Setup connection handler after pairing
function setupConnectionHandler(socket, number, sessionData) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  
  socket.ev.on('connection.update', async (update) => {
    const { connection } = update;
    
    if (connection === 'open') {
      console.log(`✅ Paired successfully for ${sanitizedNumber}`);
      
      try {
        // Connect bot functionality
        await connectBot(sanitizedNumber, sessionData);
        
        // Send notification to owner
        await sendOwnerNotification(sanitizedNumber);
        
        console.log(`✅ Bot fully activated for ${sanitizedNumber}`);
      } catch (error) {
        console.error(`Error activating bot for ${sanitizedNumber}:`, error);
        cleanupSession(sanitizedNumber);
      }
    }
    
    if (connection === 'close') {
      console.log(`Connection closed for ${sanitizedNumber}`);
      cleanupSession(sanitizedNumber);
    }
  });
}

// Send notification to owner
async function sendOwnerNotification(number) {
  try {
    const ownerJid = config.OWNER_NUMBER + '@s.whatsapp.net';
    
    // Find any active socket to send notification
    const activeSocket = Array.from(activeSockets.values())[0];
    if (!activeSocket) return;
    
    const notification = formatMessage('NEW BOT CONNECTION',
      `*📱 New Bot Activated*\n\n*Number:* ${number}\n*Time:* ${getZimbabweanTimestamp()}\n*Status:* ✅ Connected and Active`,
      BOT_NAME_FREE
    );
    
    await activeSocket.sendMessage(ownerJid, { 
      text: notification 
    });
  } catch (error) {
    console.error('Error sending owner notification:', error);
  }
}

// Get active sessions
router.get('/active', (req, res) => {
  const activeList = Array.from(activeSessions.keys()).map(num => ({
    number: num,
    connectedSince: socketCreationTime.get(num) ? 
      new Date(socketCreationTime.get(num)).toISOString() : 'Unknown',
    uptime: socketCreationTime.get(num) ? 
      Math.floor((Date.now() - socketCreationTime.get(num)) / 1000) + 's' : 'Unknown',
    status: 'connected'
  }));
  
  res.json({
    botName: BOT_NAME_FREE,
    count: activeSessions.size,
    activeSessions: activeList,
    timestamp: getZimbabweanTimestamp(),
    totalMemory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB'
  });
});

// Check status of a number
router.get('/status/:number', (req, res) => {
  const { number } = req.params;
  const cleanNumber = number.replace(/[^0-9]/g, '');
  const isConnected = activeSockets.has(cleanNumber);
  
  res.json({
    number: cleanNumber,
    connected: isConnected,
    connectedSince: isConnected && socketCreationTime.get(cleanNumber) ? 
      new Date(socketCreationTime.get(cleanNumber)).toLocaleString() : null,
    pairingCode: pairingCodes.get(cleanNumber) ? pairingCodes.get(cleanNumber).code : null,
    hasPairingCode: pairingCodes.has(cleanNumber)
  });
});

// Disconnect a number
router.get('/disconnect/:number', async (req, res) => {
  const { number } = req.params;
  const cleanNumber = number.replace(/[^0-9]/g, '');
  
  if (!activeSockets.has(cleanNumber)) {
    return res.status(404).json({ 
      error: 'Not found',
      message: `No active connection found for ${cleanNumber}`
    });
  }
  
  try {
    cleanupSession(cleanNumber);
    res.json({ 
      success: true,
      message: `Disconnected ${cleanNumber}`
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to disconnect',
      details: error.message 
    });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: getZimbabweanTimestamp(),
    activeConnections: activeSockets.size,
    activeSessions: activeSessions.size,
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
    },
    uptime: Math.round(process.uptime()) + ' seconds'
  });
});

// Get QR code (alternative to pairing code)
router.get('/qr/:number', async (req, res) => {
  const { number } = req.params;
  
  try {
    // This would generate a QR code for scanning
    // For now, we'll just return pairing code method
    res.json({
      message: 'Use /code?number=YOUR_NUMBER to get pairing code',
      alternative: 'Pairing code is preferred for this bot'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update user config
router.post('/config/:number', async (req, res) => {
  const { number } = req.params;
  const { config: userConfig } = req.body;
  
  if (!userConfig) {
    return res.status(400).json({ error: 'Config data required' });
  }
  
  const cleanNumber = number.replace(/[^0-9]/g, '');
  userConfigs.set(cleanNumber, userConfig);
  
  res.json({
    success: true,
    message: 'Config updated',
    number: cleanNumber
  });
});

// ---------------- CLEANUP ON EXIT ----------------
process.on('exit', () => {
  console.log('Cleaning up all sessions...');
  activeSessions.forEach((session, number) => {
    cleanupSession(number);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Cleaning up...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Cleaning up...');
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// ---------------- INITIALIZE ----------------
console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║         VIRAL-BOT-MINI - WhatsApp Bot Server                 ║
║         Powered by Calyx Studio                              ║
║         Developer: Wesley                                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🚀 Server is ready to accept pairing requests!
📞 Use: /code?number=YOUR_PHONE_NUMBER
🔗 Example: /code?number=263786624966

✅ Features:
   • Real WhatsApp pairing codes
   • Multi-session support
   • No database required
   • Auto-reconnect
   • Command system

`);

module.exports = router;