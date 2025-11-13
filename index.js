import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';
import fs from 'fs';
import pino from 'pino';

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'miapp-secret-token-2024';
const AUTH_DIR = './auth_info_baileys';

app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected'; // 'disconnected' | 'qr_ready' | 'connecting' | 'connected'
let phoneNumber = null;
let isConnecting = false;

const logger = pino({ level: 'warn' });

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

function clearAuthFiles() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      console.log('[CLEANUP] 🧹 Rimozione cartella auth...');
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[CLEANUP] ✅ Cartella auth rimossa con successo');
      return true;
    }
    return true;
  } catch (error) {
    console.error('[CLEANUP] ❌ Errore rimozione auth:', error);
    return false;
  }
}

async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('[WA] ⚠️ Connessione già in corso, skip');
    return;
  }
  
  try {
    isConnecting = true;
    connectionStatus = 'connecting';
    console.log('[WA] 🔄 Avvio connessione...');
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    
    console.log(`[WA] 📱 Baileys v${version.join('.')}, latest: ${isLatest}`);
    
    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      printQRInTerminal: true,
      logger,
      browser: ['MiServe', 'Chrome', '110.0.0'],
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      markOnlineOnConnect: true,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('[WA] 📱 QR Code generato');
        connectionStatus = 'qr_ready';
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          qrcode.generate(qr, { small: true });
          console.log('[WA] ✅ QR Code convertito in Data URL');
        } catch (err) {
          console.error('[WA] ❌ Errore generazione QR:', err);
        }
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log('[WA] ⛔ Connessione chiusa. Codice:', statusCode);
        console.log('[WA] 📋 Tipo errore:', lastDisconnect?.error?.message);
        
        connectionStatus = 'disconnected';
        phoneNumber = null;
        qrCodeData = null;
        isConnecting = false;
        
        // CASO 1: Logout esplicito dal server
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[WA] 🧹 Logout esplicito dal server');
          clearAuthFiles();
          sock = null;
          setTimeout(() => {
            console.log('[WA] 🔄 Rigenerazione QR dopo logout...');
            connectToWhatsApp();
          }, 3000);
        } 
        // CASO 2: Disconnesso dal telefono (401, 403, 440)
        else if (statusCode === 401 || statusCode === 403 || statusCode === 440) {
          console.log('[WA] 📱 Disconnesso dal telefono, rigenerazione QR...');
          clearAuthFiles();
          sock = null;
          setTimeout(() => connectToWhatsApp(), 3000);
        }
        // CASO 3: QR scaduto o sessione invalida (428, 500, 515)
        else if (statusCode === 428 || statusCode === 500 || statusCode === 515) {
          console.log('[WA] 🧹 Sessione invalida (code: ' + statusCode + '), pulizia e retry');
          clearAuthFiles();
          sock = null;
          setTimeout(() => connectToWhatsApp(), 3000);
        }
        // CASO 4: Errore connessione generica (riprova senza pulire)
        else if (shouldReconnect && statusCode) {
          console.log('[WA] 🔄 Errore temporaneo (code: ' + statusCode + '), riconnessione tra 5 secondi...');
          setTimeout(() => connectToWhatsApp(), 5000);
        }
        // CASO 5: Nessun codice specifico (pulisci preventivamente)
        else {
          console.log('[WA] ⚠️ Connessione chiusa senza codice valido, pulizia preventiva');
          clearAuthFiles();
          sock = null;
          setTimeout(() => connectToWhatsApp(), 3000);
        }
      } 
      else if (connection === 'open') {
        console.log('[WA] ✅ Connesso a WhatsApp');
        connectionStatus = 'connected';
        qrCodeData = null;
        isConnecting = false;
        
        try {
          const user = sock.user;
          phoneNumber = user?.id?.split(':')[0] || null;
          console.log('[WA] 📞 Numero connesso:', phoneNumber);
        } catch (error) {
          console.error('[WA] ❌ Errore recupero numero:', error);
        }
      }
      else if (connection === 'connecting') {
        console.log('[WA] 🔄 Connessione in corso...');
        connectionStatus = 'connecting';
      }
    });
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
      const msg = messages[0];
      if (msg?.key?.remoteJid) {
        console.log('[WA] 📨 Messaggio ricevuto da:', msg.key.remoteJid);
      }
    });
    
  } catch (error) {
    console.error('[WA] ❌ Errore connessione:', error);
    isConnecting = false;
    connectionStatus = 'disconnected';
    
    if (error.message?.includes('invalid') || error.message?.includes('unauthorized')) {
      console.log('[WA] 🧹 Errore critico, pulizia auth');
      clearAuthFiles();
    }
    
    setTimeout(() => connectToWhatsApp(), 10000);
  }
}

connectToWhatsApp();

// ========================================
// ROUTES
// ========================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MiApp WhatsApp Server',
    version: '1.4.0',
    connectionStatus: connectionStatus,
    connected: connectionStatus === 'connected',
    isConnecting: isConnecting
  });
});

// ✅ ROUTE /status CORRETTA
app.get('/status', authenticate, (req, res) => {
  console.log('[STATUS] 📊 Richiesta stato ricevuta');
  console.log('[STATUS] connectionStatus:', connectionStatus);
  console.log('[STATUS] qrCodeData presente?:', !!qrCodeData);
  console.log('[STATUS] phoneNumber:', phoneNumber);
  
  res.json({
    success: true,
    status: connectionStatus || 'disconnected',
    connected: connectionStatus === 'connected',
    qrCode: qrCodeData,
    phoneNumber: phoneNumber,
    timestamp: new Date().toISOString()
  });
});

app.post('/send', authenticate, async (req, res) => {
  try {
    const { phoneNumber: targetNumber, message } = req.body;
    
    if (!targetNumber || !message) {
      return res.status(400).json({ 
        error: 'phoneNumber e message richiesti' 
      });
    }
    
    if (!sock || connectionStatus !== 'connected') {
      return res.status(503).json({ 
        error: 'WhatsApp non connesso',
        currentStatus: connectionStatus
      });
    }
    
    console.log('[SEND] 📤 Invio messaggio a:', targetNumber);
    
    const cleanNumber = targetNumber.replace(/\D/g, '');
    const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    await sock.sendMessage(jid, { text: message });
    
    console.log('[SEND] ✅ Messaggio inviato con successo');
    
    res.json({ 
      success: true,
      messageId: Date.now().toString(),
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[SEND] ❌ Errore invio:', error);
    res.status(500).json({ 
      error: 'Errore invio messaggio',
      details: error.message 
    });
  }
});

app.post('/disconnect', authenticate, async (req, res) => {
  try {
    console.log('[DISCONNECT] 🔌 Richiesta disconnessione completa');
    
    if (sock) {
      try {
        await sock.logout();
        console.log('[DISCONNECT] ✅ Logout WhatsApp completato');
      } catch (error) {
        console.error('[DISCONNECT] ⚠️ Errore logout:', error);
      }
      sock = null;
    }
    
    connectionStatus = 'disconnected';
    phoneNumber = null;
    qrCodeData = null;
    isConnecting = false;
    
    const cleaned = clearAuthFiles();
    
    console.log('[DISCONNECT] ✅ Disconnessione completata');
    
    res.json({ 
      success: true,
      authFilesCleared: cleaned,
      message: 'Disconnesso e pronto per nuovo QR'
    });
    
    setTimeout(() => {
      console.log('[DISCONNECT] 🔄 Riavvio connessione per nuovo QR...');
      connectToWhatsApp();
    }, 2000);
    
  } catch (error) {
    console.error('[DISCONNECT] ❌ Errore:', error);
    res.status(500).json({ 
      error: 'Errore disconnessione',
      details: error.message 
    });
  }
});

app.post('/reconnect', authenticate, async (req, res) => {
  try {
    console.log('[RECONNECT] 🔄 Richiesta riconnessione forzata');
    
    if (sock) {
      try {
        await sock.logout();
      } catch (error) {
        console.log('[RECONNECT] ⚠️ Errore logout:', error);
      }
      sock = null;
    }
    
    connectionStatus = 'disconnected';
    phoneNumber = null;
    qrCodeData = null;
    isConnecting = false;
    
    clearAuthFiles();
    
    setTimeout(() => {
      console.log('[RECONNECT] 🔄 Riavvio connessione...');
      connectToWhatsApp();
    }, 1000);
    
    res.json({ 
      success: true, 
      message: 'Riconnessione avviata. Controlla /status per il QR code.' 
    });
    
  } catch (error) {
    console.error('[RECONNECT] ❌ Errore:', error);
    res.status(500).json({ 
      error: 'Errore riconnessione',
      details: error.message 
    });
  }
});

app.post('/force-clean', authenticate, async (req, res) => {
  try {
    console.log('[FORCE CLEAN] 🧹 Pulizia forzata auth...');
    
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {
        console.log('[FORCE CLEAN] Socket già chiuso');
      }
      sock = null;
    }
    
    connectionStatus = 'disconnected';
    phoneNumber = null;
    qrCodeData = null;
    isConnecting = false;
    
    const cleaned = clearAuthFiles();
    
    console.log('[FORCE CLEAN] ✅ Pulizia completata');
    
    res.json({ 
      success: true, 
      cleaned: cleaned,
      message: 'Auth pulita completamente. Chiama /reconnect per riavviare.' 
    });
    
  } catch (error) {
    console.error('[FORCE CLEAN] ❌ Errore:', error);
    res.status(500).json({ 
      error: 'Errore pulizia',
      details: error.message 
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint non trovato' });
});

app.use((error, req, res, next) => {
  console.error('[ERROR]', error);
  res.status(500).json({ error: 'Errore server interno' });
});

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`🚀 [SERVER] In ascolto su porta ${PORT}`);
  console.log(`🌍 [SERVER] Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔐 [SERVER] Auth Token: ${AUTH_TOKEN.substring(0, 10)}...`);
  console.log(`📊 [SERVER] Status iniziale: ${connectionStatus}`);
  console.log('='.repeat(60));
});