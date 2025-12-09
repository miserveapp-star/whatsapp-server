import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import QRCode from 'qrcode';
import fs from 'fs';
import path from 'path';
import pino from 'pino';

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'miserve_whatsapp_2024_SUPERSECRET123';
const SESSIONS_DIR = './auth_sessions';

app.use(cors());
app.use(express.json());

const logger = pino({ level: 'silent' });

// ========================================
// 🆕 MULTI-TENANT: Gestione sessioni per utente
// ========================================

// Mappa delle sessioni attive: { odAd: { sock, status, qrCode, phoneNumber, reconnectAttempts } }
const sessions = new Map();

// Crea cartella sessioni se non esiste
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// 🔐 MIDDLEWARE AUTENTICAZIONE
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Non autorizzato' });
  }
  
  const token = authHeader.substring(7);
  
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Token non valido' });
  }
  
  next();
}

// 📁 Ottieni percorso auth per utente
function getAuthDir(userId) {
  return path.join(SESSIONS_DIR, userId);
}

// 🗑️ Elimina sessione utente
async function clearUserSession(userId) {
  try {
    const authDir = getAuthDir(userId);
    if (fs.existsSync(authDir)) {
      console.log(`[WA:${userId}] 🗑️ Pulizia sessione...`);
      fs.rmSync(authDir, { recursive: true, force: true });
      console.log(`[WA:${userId}] ✅ Sessione eliminata`);
    }
    // Rimuovi dalla mappa
    const session = sessions.get(userId);
    if (session?.sock) {
      try {
        await session.sock.logout();
      } catch (e) {
        // Ignora errori logout
      }
    }
    sessions.delete(userId);
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore pulizia sessione:`, error);
  }
}

// 📊 Ottieni stato sessione utente
function getSessionStatus(userId) {
  const session = sessions.get(userId);
  if (!session) {
    return {
      status: 'disconnected',
      connected: false,
      qrCode: null,
      phoneNumber: null,
      hasQR: false
    };
  }
  return {
    status: session.status,
    connected: session.status === 'connected',
    qrCode: session.qrCode,
    phoneNumber: session.phoneNumber,
    hasQR: session.qrCode !== null
  };
}

// 🔄 Connetti WhatsApp per utente specifico
async function connectUserWhatsApp(userId, forceNewQR = false) {
  const MAX_RECONNECT_ATTEMPTS = 3;
  
  try {
    const authDir = getAuthDir(userId);
    
    // Se forziamo nuovo QR, eliminiamo la sessione esistente
    if (forceNewQR) {
      console.log(`[WA:${userId}] 🔄 Rigenerazione QR forzata...`);
      await clearUserSession(userId);
    }
    
    // Inizializza sessione in mappa
    if (!sessions.has(userId)) {
      sessions.set(userId, {
        sock: null,
        status: 'initializing',
        qrCode: null,
        phoneNumber: null,
        reconnectAttempts: 0
      });
    }
    
    const session = sessions.get(userId);
    session.status = 'initializing';
    
    console.log(`[WA:${userId}] 🚀 Avvio connessione...`);
    
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      browser: ['MiServe', 'Chrome', '120.0.0'],
      getMessage: async (key) => {
        return { conversation: '' };
      }
    });
    
    session.sock = sock;
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // 📱 GENERAZIONE QR CODE
      if (qr) {
        console.log(`[WA:${userId}] 📱 QR Code generato`);
        session.status = 'qr_ready';
        
        // 🔥 FIX: QR di alta qualità per Android
        session.qrCode = await QRCode.toDataURL(qr, {
          width: 400,                    // Dimensione maggiore (era default ~200)
          margin: 2,                     // Margine bianco
          errorCorrectionLevel: 'M',     // Correzione errori media (bilancia dimensione/affidabilità)
          color: {
            dark: '#000000',             // Nero puro
            light: '#FFFFFF'             // Bianco puro
          }
        });
        
        session.reconnectAttempts = 0;
      }
      
      // ❌ CONNESSIONE CHIUSA
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`[WA:${userId}] ❌ Connessione chiusa - Status: ${statusCode}`);
        
        session.status = 'disconnected';
        session.phoneNumber = null;
        
        // 🔍 CASO 1: Logout esplicito
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[WA:${userId}] 🚫 Logout - Rigenerazione QR...`);
          await clearUserSession(userId);
          setTimeout(() => connectUserWhatsApp(userId, true), 2000);
        }
        // 🔍 CASO 2: Disconnessione dal telefono
        else if (statusCode === DisconnectReason.connectionClosed || 
                 statusCode === DisconnectReason.connectionLost ||
                 statusCode === DisconnectReason.timedOut) {
          
          session.reconnectAttempts++;
          console.log(`[WA:${userId}] 📱 Tentativo riconnessione ${session.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
          
          if (session.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.log(`[WA:${userId}] 🔄 Troppi tentativi - Rigenerazione QR...`);
            await clearUserSession(userId);
            setTimeout(() => connectUserWhatsApp(userId, true), 2000);
          } else {
            session.qrCode = null;
            setTimeout(() => connectUserWhatsApp(userId), 3000);
          }
        }
        // 🔍 CASO 3: Altri errori
        else if (shouldReconnect) {
          console.log(`[WA:${userId}] 🔄 Riconnessione generica...`);
          session.qrCode = null;
          setTimeout(() => connectUserWhatsApp(userId), 3000);
        }
      } 
      // ✅ CONNESSIONE APERTA
      else if (connection === 'open') {
        console.log(`[WA:${userId}] ✅ Connesso con successo!`);
        session.status = 'connected';
        session.qrCode = null;
        session.reconnectAttempts = 0;
        
        const user = sock.user;
        session.phoneNumber = user?.id?.split(':')[0] || null;
        console.log(`[WA:${userId}] 📞 Numero: ${session.phoneNumber}`);
      }
      // 🔄 CONNESSIONE IN CORSO
      else if (connection === 'connecting') {
        console.log(`[WA:${userId}] 🔄 Connessione in corso...`);
        session.status = 'connecting';
      }
    });
    
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore connessione:`, error);
    const session = sessions.get(userId);
    if (session) {
      session.status = 'error';
    }
    setTimeout(() => connectUserWhatsApp(userId), 5000);
  }
}

// 📤 Invia messaggio per utente specifico
async function sendUserMessage(userId, phoneNumber, message) {
  const session = sessions.get(userId);
  
  if (!session || !session.sock || session.status !== 'connected') {
    throw new Error(`WhatsApp non connesso per utente ${userId}`);
  }
  
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
  
  const result = await session.sock.sendMessage(jid, { text: message });
  
  return result.key.id || Date.now().toString();
}

// 📤 Invia immagine per utente specifico
async function sendUserImage(userId, phoneNumber, imageBuffer, mimeType, caption) {
  const session = sessions.get(userId);
  
  if (!session || !session.sock || session.status !== 'connected') {
    throw new Error(`WhatsApp non connesso per utente ${userId}`);
  }
  
  const cleanNumber = phoneNumber.replace(/\D/g, '');
  const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
  
  const result = await session.sock.sendMessage(jid, {
    image: imageBuffer,
    caption: caption || '',
    mimetype: mimeType
  });
  
  return result.key.id || Date.now().toString();
}

// ========================================
// ROUTES API - MULTI-TENANT
// ========================================

// 🏠 HOME - Info server
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MiServe WhatsApp Server',
    version: '3.1.0-multitenant-qrfix',
    activeSessions: sessions.size,
    uptime: process.uptime(),
    features: ['multi-tenant', 'send', 'send-image', 'status', 'disconnect', 'regenerate-qr', 'hd-qr-codes']
  });
});

// 📊 STATUS - Stato connessione utente
app.get('/status', authenticate, (req, res) => {
  const userId = req.query.userId || req.headers['x-user-id'];
  
  if (!userId) {
    return res.status(400).json({ 
      success: false,
      error: 'userId richiesto (query param o header x-user-id)' 
    });
  }
  
  const status = getSessionStatus(userId);
  
  res.json({
    success: true,
    userId: userId,
    ...status,
    timestamp: new Date().toISOString()
  });
});

// 🔄 CONNECT - Avvia connessione per utente
app.post('/connect', authenticate, async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false,
      error: 'userId richiesto' 
    });
  }
  
  try {
    console.log(`[WA:${userId}] 🔌 Richiesta connessione`);
    
    // Verifica se già connesso
    const session = sessions.get(userId);
    if (session?.status === 'connected') {
      return res.json({
        success: true,
        message: 'Già connesso',
        ...getSessionStatus(userId)
      });
    }
    
    // Avvia connessione
    connectUserWhatsApp(userId, false);
    
    res.json({ 
      success: true,
      message: 'Connessione avviata...',
      status: 'initializing'
    });
    
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore connect:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// 🔄 REGENERATE QR - Forza nuovo QR code per utente
app.post('/regenerate-qr', authenticate, async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false,
      error: 'userId richiesto' 
    });
  }
  
  try {
    console.log(`[WA:${userId}] 🔄 Richiesta rigenerazione QR`);
    
    await clearUserSession(userId);
    
    setTimeout(() => connectUserWhatsApp(userId, true), 1000);
    
    res.json({ 
      success: true,
      message: 'QR Code in generazione...',
      status: 'initializing'
    });
    
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore rigenerazione QR:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// 📤 SEND - Invio messaggio testuale
app.post('/send', authenticate, async (req, res) => {
  const { userId, phoneNumber, message } = req.body;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false,
      error: 'userId richiesto' 
    });
  }
  
  if (!phoneNumber || !message) {
    return res.status(400).json({ 
      success: false,
      error: 'phoneNumber e message richiesti' 
    });
  }
  
  try {
    console.log(`[WA:${userId}] 📤 Invio messaggio a: ${phoneNumber}`);
    
    const messageId = await sendUserMessage(userId, phoneNumber, message);
    
    console.log(`[WA:${userId}] ✅ Messaggio inviato`);
    
    res.json({ 
      success: true,
      messageId: messageId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore invio:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// 🖼️ SEND-IMAGE - Invio messaggio con immagine
app.post('/send-image', authenticate, async (req, res) => {
  const { userId, phoneNumber, imageUrl, caption } = req.body;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false,
      error: 'userId richiesto' 
    });
  }
  
  if (!phoneNumber || !imageUrl) {
    return res.status(400).json({ 
      success: false,
      error: 'phoneNumber e imageUrl richiesti' 
    });
  }
  
  try {
    console.log(`[WA:${userId}] 🖼️ Invio immagine a: ${phoneNumber}`);
    
    let imageBuffer;
    let mimeType = 'image/jpeg';
    
    if (imageUrl.startsWith('data:')) {
      const matches = imageUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) {
        return res.status(400).json({ 
          success: false,
          error: 'Formato base64 non valido' 
        });
      }
      mimeType = matches[1];
      imageBuffer = Buffer.from(matches[2], 'base64');
    } else {
      const axios = (await import('axios')).default;
      const imageResponse = await axios.get(imageUrl, {
        responseType: 'arraybuffer',
        timeout: 30000
      });
      imageBuffer = Buffer.from(imageResponse.data);
      mimeType = imageResponse.headers['content-type'] || 'image/jpeg';
    }
    
    if (imageBuffer.length > 16 * 1024 * 1024) {
      return res.status(400).json({ 
        success: false,
        error: 'Immagine troppo grande (max 16MB)' 
      });
    }
    
    const messageId = await sendUserImage(userId, phoneNumber, imageBuffer, mimeType, caption);
    
    console.log(`[WA:${userId}] ✅ Immagine inviata`);
    
    res.json({ 
      success: true,
      messageId: messageId,
      timestamp: new Date().toISOString(),
      imageSize: imageBuffer.length
    });
    
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore invio immagine:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// 🔌 DISCONNECT - Disconnessione utente
app.post('/disconnect', authenticate, async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ 
      success: false,
      error: 'userId richiesto' 
    });
  }
  
  try {
    console.log(`[WA:${userId}] 🔌 Richiesta disconnessione`);
    
    await clearUserSession(userId);
    
    console.log(`[WA:${userId}] ✅ Disconnesso`);
    
    res.json({ 
      success: true,
      message: 'Disconnesso'
    });
    
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore disconnessione:`, error);
    res.status(500).json({ 
      success: false,
      error: error.message
    });
  }
});

// 📊 ADMIN - Lista tutte le sessioni attive (solo admin)
app.get('/admin/sessions', authenticate, (req, res) => {
  const sessionList = [];
  
  sessions.forEach((session, odAd) => {
    sessionList.push({
      odAd,
      status: session.status,
      phoneNumber: session.phoneNumber,
      hasQR: session.qrCode !== null
    });
  });
  
  res.json({
    success: true,
    totalSessions: sessions.size,
    sessions: sessionList
  });
});

// 🚀 AVVIO SERVER
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`✅ MiServe WhatsApp Server MULTI-TENANT`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🔐 Auth token configurato`);
  console.log(`📱 Versione: 3.1.0-multitenant-qrfix`);
  console.log(`📂 Sessioni in: ${SESSIONS_DIR}`);
  console.log(`🔥 QR HD: 400px, correzione errori M`);
  console.log('='.repeat(60));
});

// 🔄 RESTORE SESSIONI ESISTENTI ALL'AVVIO
async function restoreExistingSessions() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    
    const userDirs = fs.readdirSync(SESSIONS_DIR);
    console.log(`[RESTORE] Trovate ${userDirs.length} sessioni da ripristinare...`);
    
    for (const odAd of userDirs) {
      const authDir = path.join(SESSIONS_DIR, odAd);
      const credsPath = path.join(authDir, 'creds.json');
      
      if (fs.existsSync(credsPath)) {
        console.log(`[RESTORE] Ripristino sessione: ${odAd}`);
        connectUserWhatsApp(odAd, false);
        
        // Attendi un po' tra le connessioni per non sovraccaricare
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log('[RESTORE] ✅ Ripristino completato');
  } catch (error) {
    console.error('[RESTORE] ❌ Errore ripristino sessioni:', error);
  }
}

// Avvia ripristino dopo 3 secondi dall'avvio
setTimeout(restoreExistingSessions, 3000);