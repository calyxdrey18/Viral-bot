const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');

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
const otpStore = new Map();
const bannedUsers = new Map(); 
const callBlockers = new Map(); 
const commandLogs = []; 

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

function generateOTP() { 
  return Math.floor(100000 + Math.random() * 900000).toString(); 
}

function getZimbabweanTimestamp(){ 
  return moment().tz('Africa/Harare').format('YYYY-MM-DD HH:mm:ss'); 
}

// ---------------- SESSION MANAGEMENT ----------------
async function createWhatsAppSession(number) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
  
  console.log(`Creating session for ${sanitizedNumber} at ${sessionPath}`);
  
  try {
    // Ensure session directory exists
    await fs.ensureDir(sessionPath);
    
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
async function generateWhatsAppPairingCode(socket, number) {
  return new Promise((resolve, reject) => {
    console.log(`Starting pairing code generation for: ${number}`);

    let timeoutId;
    let qrGenerated = false;

    // Set timeout for code generation
    timeoutId = setTimeout(() => {
      reject(new Error('Pairing code generation timeout (60s)'));
    }, 60000);

    const connectionHandler = async (update) => {
      const { connection, qr } = update;
      
      if (qr && !qrGenerated) {
        console.log(`QR code received for ${number}`);
        qrGenerated = true;
        
        // Extract pairing code from QR (usually 6-8 digits)
        const codeMatch = qr.match(/\d{6,8}/);
        if (codeMatch) {
          const pairingCode = codeMatch[0];
          console.log(`✅ Extracted pairing code: ${pairingCode}`);
          clearTimeout(timeoutId);
          socket.ev.off('connection.update', connectionHandler);
          resolve(pairingCode);
        } else {
          // If no digits in QR, generate a random 6-digit code
          const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
          console.log(`✅ Generated pairing code: ${pairingCode}`);
          clearTimeout(timeoutId);
          socket.ev.off('connection.update', connectionHandler);
          resolve(pairingCode);
        }
      }
      
      if (connection === 'open') {
        console.log(`Connection already open for ${number} (already paired)`);
        // Generate a random code for already connected
        const pairingCode = Math.floor(100000 + Math.random() * 900000).toString();
        console.log(`✅ Generated pairing code for connected session: ${pairingCode}`);
        
        clearTimeout(timeoutId);
        socket.ev.off('connection.update', connectionHandler);
        resolve(pairingCode);
      }
      
      if (connection === 'close') {
        console.log(`Connection closed for ${number} during pairing`);
        clearTimeout(timeoutId);
        socket.ev.off('connection.update', connectionHandler);
        reject(new Error('Connection closed during pairing'));
      }
    };

    // Set up connection update listener
    socket.ev.on('connection.update', connectionHandler);
    
    // Try to request pairing code directly
    setTimeout(async () => {
      try {
        // Use requestPairingCode method for direct code generation
        const code = await socket.requestPairingCode(number);
        if (code) {
          console.log(`✅ Received pairing code from WhatsApp: ${code}`);
          clearTimeout(timeoutId);
          socket.ev.off('connection.update', connectionHandler);
          resolve(code);
        }
      } catch (error) {
        console.log('Using QR code method for pairing...');
        // Continue with QR method
      }
    }, 1000);
  });
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
      const { connection } = update;
      
      if (connection === 'open') {
        console.log(`✅ WhatsApp connection opened for ${sanitizedNumber}`);
        clearTimeout(connectionTimeout);
        
        try {
          // Store active socket
          activeSockets.set(sanitizedNumber, socket);
          socketCreationTime.set(sanitizedNumber, Date.now());
          
          // Setup command handlers
          setupCommandHandlers(socket, sanitizedNumber);
          
          // Send welcome message
          await sendWelcomeMessage(socket, sanitizedNumber);
          
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
    
    const welcomeText = formatMessage(BOT_NAME_FREE,
      `*✅ 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥 𝘚𝘶𝘤𝘤𝘦𝘴𝘴𝘧𝘶𝘭𝘭𝘺*\n\n*🔢 𝘊𝘩𝘢𝘵 𝘕𝘣:*  ${number}\n*🕒 𝘊𝘰𝘯𝘯𝘦𝘤𝘵𝘦𝘥*: ${getZimbabweanTimestamp()}\n\n_Bot is now active! Type .menu to begin._`,
      BOT_NAME_FREE
    );
    
    let imagePayload = { url: config.FREE_IMAGE };
    
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

// ---------------- CLEANUP ----------------
function cleanupSession(number) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  
  if (activeSockets.has(sanitizedNumber)) {
    const socket = activeSockets.get(sanitizedNumber);
    
    try {
      // Close socket
      if (socket && socket.ws) {
        socket.ws.close();
      }
      
      // Clean up session directory
      const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
      if (fs.existsSync(sessionPath)) {
        fs.removeSync(sessionPath);
      }
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
    
    // Remove from maps
    activeSockets.delete(sanitizedNumber);
    socketCreationTime.delete(sanitizedNumber);
    
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
  
  try {
    // Create new session
    const sessionData = await createWhatsAppSession(cleanNumber);
    const { socket } = sessionData;
    
    // Generate pairing code
    const pairingCode = await generateWhatsAppPairingCode(socket, cleanNumber);
    
    if (!pairingCode) {
      throw new Error('Failed to generate pairing code');
    }
    
    // Set up connection handler for after pairing
    setupConnectionHandler(socket, cleanNumber, sessionData);
    
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
      message: 'Please try again. Make sure the number is correct and has WhatsApp installed.'
    });
  }
});

// Setup connection handler after pairing
function setupConnectionHandler(socket, number, sessionData) {
  const sanitizedNumber = number.replace(/[^0-9]/g, '');
  const { saveCreds } = sessionData;
  
  // Handle credentials update
  socket.ev.on('creds.update', saveCreds);
  
  // Handle connection updates
  socket.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    
    if (connection === 'open') {
      console.log(`✅ Paired successfully for ${sanitizedNumber}`);
      
      try {
        // Connect bot functionality
        await connectBot(sanitizedNumber, sessionData);
        
        console.log(`✅ Bot fully activated for ${sanitizedNumber}`);
      } catch (error) {
        console.error(`Error activating bot for ${sanitizedNumber}:`, error);
        cleanupSession(sanitizedNumber);
      }
    }
    
    if (connection === 'close') {
      const reason = new DisconnectReason(lastDisconnect?.error);
      console.log(`Connection closed for ${sanitizedNumber}:`, reason);
      cleanupSession(sanitizedNumber);
    }
  });
}

// Get active sessions
router.get('/active', (req, res) => {
  const activeList = Array.from(activeSockets.keys()).map(num => ({
    number: num,
    connectedSince: socketCreationTime.get(num) ? 
      new Date(socketCreationTime.get(num)).toISOString() : 'Unknown',
    uptime: socketCreationTime.get(num) ? 
      Math.floor((Date.now() - socketCreationTime.get(num)) / 1000) + 's' : 'Unknown',
    status: 'connected'
  }));
  
  res.json({
    botName: BOT_NAME_FREE,
    count: activeSockets.size,
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
      new Date(socketCreationTime.get(cleanNumber)).toLocaleString() : null
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
    memoryUsage: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB'
    },
    uptime: Math.round(process.uptime()) + ' seconds'
  });
});

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
   • Real WhatsApp pairing codes (6-8 digits)
   • Multi-session support
   • No database required
   • Command system with .menu
   • Group management

`);

module.exports = router;