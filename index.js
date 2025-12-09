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

// Mappa delle sessioni attive
const sessions = new Map();

// 🔒 LOCK per evitare race condition - NUOVA AGGIUNTA
const connectionLocks = new Map();

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

// 🔒 Acquisisci lock per userId
async function acquireLock(userId) {
  // Se c'è già un lock attivo, aspetta che si liberi
  while (connectionLocks.get(userId)) {
    console.log(`[WA:${userId}] ⏳ In attesa del lock...`);
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  connectionLocks.set(userId, true);
  console.log(`[WA:${userId}] 🔒 Lock acquisito`);
}

// 🔓 Rilascia lock per userId
function releaseLock(userId) {
  connectionLocks.delete(userId);
  console.log(`[WA:${userId}] 🔓 Lock rilasciato`);
}

// 🗑️ Elimina sessione utente (SENZA riconnessione automatica)
async function clearUserSession(userId, skipLogout = false) {
  try {
    const session = sessions.get(userId);
    
    // Chiudi socket esistente in modo pulito
    if (session?.sock) {
      console.log(`[WA:${userId}] 🔌 Chiusura socket...`);
      
      // Rimuovi tutti i listener per evitare eventi a cascata
      session.sock.ev.removeAllListeners('connection.update');
      session.sock.ev.removeAllListeners('creds.update');
      
      try {
        // Prima end(), poi logout() se necessario
        session.sock.end(undefined);
        
        if (!skipLogout) {
          await session.sock.logout().catch(() => {});
        }
      } catch (e) {
        console.log(`[WA:${userId}] ⚠️ Errore chiusura socket (ignorato):`, e.message);
      }
    }
    
    // Rimuovi dalla mappa PRIMA di eliminare i file
    sessions.delete(userId);
    
    // Elimina cartella auth
    const authDir = getAuthDir(userId);
    if (fs.existsSync(authDir)) {
      console.log(`[WA:${userId}] 🗑️ Eliminazione file sessione...`);
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    
    console.log(`[WA:${userId}] ✅ Sessione pulita`);
    
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
async function connectUserWhatsApp(userId, options = {}) {
  const { forceNewQR = false, isReconnect = false, skipLock = false } = options;
  const MAX_RECONNECT_ATTEMPTS = 3;
  
  // 🔒 Acquisisci lock (a meno che non sia già dentro una riconnessione interna)
  if (!skipLock) {
    await acquireLock(userId);
  }
  
  try {
    const authDir = getAuthDir(userId);
    
    // Verifica se c'è già una connessione attiva
    const existingSession = sessions.get(userId);
    if (existingSession?.status === 'connected' && !forceNewQR) {
      console.log(`[WA:${userId}] ✅ Già connesso, skip`);
      return;
    }
    
    // Se forziamo nuovo QR, eliminiamo la sessione esistente
    if (forceNewQR && existingSession) {
      console.log(`[WA:${userId}] 🔄 Rigenerazione QR - pulizia sessione...`);
      await clearUserSession(userId, true);
      // Piccola pausa per assicurarsi che tutto sia pulito
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Inizializza sessione in mappa
    const session = {
      sock: null,
      status: 'initializing',
      qrCode: null,
      phoneNumber: null,
      reconnectAttempts: isReconnect ? (existingSession?.reconnectAttempts || 0) : 0
    };
    sessions.set(userId, session);
    
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
      },
      // 🔥 Nuove opzioni per stabilità
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      retryRequestDelayMs: 500
    });
    
    session.sock = sock;
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // Verifica che la sessione sia ancora valida (potrebbe essere stata eliminata)
      const currentSession = sessions.get(userId);
      if (!currentSession || currentSession.sock !== sock) {
        console.log(`[WA:${userId}] ⚠️ Sessione non più valida, ignoro evento`);
        return;
      }
      
      // 📱 GENERAZIONE QR CODE
      if (qr) {
        console.log(`[WA:${userId}] 📱 QR Code generato`);
        currentSession.status = 'qr_ready';
        
        currentSession.qrCode = await QRCode.toDataURL(qr, {
          width: 400,
          margin: 2,
          errorCorrectionLevel: 'M',
          color: {
            dark: '#000000',
            light: '#FFFFFF'
          }
        });
        
        currentSession.reconnectAttempts = 0;
      }
      
      // ❌ CONNESSIONE CHIUSA
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        
        console.log(`[WA:${userId}] ❌ Connessione chiusa - Status: ${statusCode}`);
        
        currentSession.status = 'disconnected';
        currentSession.qrCode = null;
        
        // 🔍 CASO 1: Logout esplicito (401)
        if (statusCode === DisconnectReason.loggedOut) {
          console.log(`[WA:${userId}] 🚫 Logout esplicito - attendo nuova richiesta utente`);
          await clearUserSession(userId, true);
          // NON riconnettiamo automaticamente - aspettiamo che l'utente clicchi "Connetti"
        }
        // 🔍 CASO 2: Stream conflict (515) - qualcun altro si è connesso
        else if (statusCode === 515) {
          console.log(`[WA:${userId}] ⚠️ Stream conflict - altra sessione attiva`);
          currentSession.status = 'conflict';
          // NON riconnettiamo - c'è un conflitto
        }
        // 🔍 CASO 3: Disconnessione temporanea - riprova
        else if (statusCode === DisconnectReason.connectionClosed || 
                 statusCode === DisconnectReason.connectionLost ||
                 statusCode === DisconnectReason.timedOut ||
                 statusCode === DisconnectReason.restartRequired) {
          
          currentSession.reconnectAttempts++;
          console.log(`[WA:${userId}] 📱 Tentativo riconnessione ${currentSession.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
          
          if (currentSession.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.log(`[WA:${userId}] ❌ Troppi tentativi falliti`);
            currentSession.status = 'failed';
            // Attendi nuova richiesta utente
          } else {
            // Riconnetti dopo un delay
            setTimeout(() => {
              connectUserWhatsApp(userId, { isReconnect: true, skipLock: false });
            }, 3000 * currentSession.reconnectAttempts); // Backoff incrementale
          }
        }
        // 🔍 CASO 4: Richiede riavvio
        else if (statusCode === DisconnectReason.restartRequired) {
          console.log(`[WA:${userId}] 🔄 Riavvio richiesto`);
          setTimeout(() => {
            connectUserWhatsApp(userId, { isReconnect: true, skipLock: false });
          }, 2000);
        }
        // 🔍 CASO 5: Altri errori
        else {
          console.log(`[WA:${userId}] ⚠️ Errore sconosciuto: ${statusCode}`);
          currentSession.status = 'error';
        }
      } 
      // ✅ CONNESSIONE APERTA
      else if (connection === 'open') {
        console.log(`[WA:${userId}] ✅ Connesso con successo!`);
        currentSession.status = 'connected';
        currentSession.qrCode = null;
        currentSession.reconnectAttempts = 0;
        
        const user = sock.user;
        currentSession.phoneNumber = user?.id?.split(':')[0] || null;
        console.log(`[WA:${userId}] 📞 Numero: ${currentSession.phoneNumber}`);
      }
      // 🔄 CONNESSIONE IN CORSO
      else if (connection === 'connecting') {
        console.log(`[WA:${userId}] 🔄 Connessione in corso...`);
        currentSession.status = 'connecting';
      }
    });
    
  } catch (error) {
    console.error(`[WA:${userId}] ❌ Errore connessione:`, error);
    const session = sessions.get(userId);
    if (session) {
      session.status = 'error';
    }
  } finally {
    // 🔓 Rilascia lock
    if (!skipLock) {
      releaseLock(userId);
    }
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
    version: '3.2.0-multitenant-lockfix',
    activeSessions: sessions.size,
    activeConnections: [...sessions.values()].filter(s => s.status === 'connected').length,
    uptime: process.uptime(),
    features: ['multi-tenant', 'connection-locks', 'send', 'send-image', 'status', 'disconnect', 'regenerate-qr']
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
  const isLocked = connectionLocks.has(userId);
  
  res.json({
    success: true,
    userId: userId,
    ...status,
    isProcessing: isLocked,
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
  
  // 🔒 Verifica se c'è già un'operazione in corso
  if (connectionLocks.has(userId)) {
    return res.json({
      success: true,
      message: 'Connessione già in corso...',
      status: 'processing'
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
    
    // Avvia connessione in background (non bloccante per la response)
    connectUserWhatsApp(userId, { forceNewQR: false });
    
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
  
  // 🔒 Verifica se c'è già un'operazione in corso
  if (connectionLocks.has(userId)) {
    return res.json({
      success: false,
      message: 'Operazione già in corso, attendi...',
      status: 'processing'
    });
  }
  
  try {
    console.log(`[WA:${userId}] 🔄 Richiesta rigenerazione QR`);
    
    // Avvia rigenerazione in background
    connectUserWhatsApp(userId, { forceNewQR: true });
    
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
  
  // 🔒 Verifica se c'è già un'operazione in corso
  if (connectionLocks.has(userId)) {
    return res.json({
      success: false,
      message: 'Operazione in corso, attendi...',
      status: 'processing'
    });
  }
  
  try {
    console.log(`[WA:${userId}] 🔌 Richiesta disconnessione`);
    
    await acquireLock(userId);
    await clearUserSession(userId, false);
    releaseLock(userId);
    
    console.log(`[WA:${userId}] ✅ Disconnesso`);
    
    res.json({ 
      success: true,
      message: 'Disconnesso'
    });
    
  } catch (error) {
    releaseLock(userId);
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
      hasQR: session.qrCode !== null,
      reconnectAttempts: session.reconnectAttempts
    });
  });
  
  res.json({
    success: true,
    totalSessions: sessions.size,
    connectedSessions: sessionList.filter(s => s.status === 'connected').length,
    activeLocks: connectionLocks.size,
    sessions: sessionList
  });
});

// 🚀 AVVIO SERVER
app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`✅ MiServe WhatsApp Server MULTI-TENANT`);
  console.log(`📡 Porta: ${PORT}`);
  console.log(`🔐 Auth token configurato`);
  console.log(`📱 Versione: 3.2.0-multitenant-lockfix`);
  console.log(`📂 Sessioni in: ${SESSIONS_DIR}`);
  console.log(`🔒 Sistema lock: ATTIVO`);
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
        await connectUserWhatsApp(odAd, { forceNewQR: false });
        
        // Attendi tra le connessioni per non sovraccaricare
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    console.log('[RESTORE] ✅ Ripristino completato');
  } catch (error) {
    console.error('[RESTORE] ❌ Errore ripristino sessioni:', error);
  }
}

// Avvia ripristino dopo 5 secondi dall'avvio
setTimeout(restoreExistingSessions, 5000);

// 🧹 CLEANUP PERIODICO - Rimuovi sessioni morte
setInterval(() => {
  let cleaned = 0;
  sessions.forEach((session, odAd) => {
    if (session.status === 'error' || session.status === 'failed') {
      // Sessioni in errore da più di 10 minuti - rimuovi
      sessions.delete(odAd);
      cleaned++;
    }
  });
  if (cleaned > 0) {
    console.log(`[CLEANUP] Rimosse ${cleaned} sessioni in errore`);
  }
}, 10 * 60 * 1000); // Ogni 10 minuti