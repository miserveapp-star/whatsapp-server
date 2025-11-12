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
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'miapp-secret-token-2024-change-this';
const AUTH_DIR = './auth_info_baileys';

app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeData = null;
let isConnected = false;
let phoneNumber = null;
let isConnecting = false;

// Logger con livello ridotto
const logger = pino({ level: 'warn' });

// Middleware autenticazione
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

// Funzione per pulire auth
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

// Funzione connessione MIGLIORATA
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log('[WA] ⚠️ Connessione già in corso, skip');
    return;
  }
  
  try {
    isConnecting = true;
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
        try {
          qrCodeData = await QRCode.toDataURL(qr);
          qrcode.generate(qr, { small: true });
        } catch (err) {
          console.error('[WA] ❌ Errore generazione QR:', err);
        }
      }
      
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WA] ⛔ Connessione chiusa. Codice:', lastDisconnect?.error?.output?.statusCode);
        console.log('[WA] 🔄 Riconnessione:', shouldReconnect);
        
        isConnected = false;
        phoneNumber = null;
        qrCodeData = null;
        isConnecting = false;
        
        if (lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut) {
          console.log('[WA] 🧹 Logout esplicito, pulizia auth files');
          clearAuthFiles();
          sock = null;
        } 
        else if (lastDisconnect?.error?.output?.statusCode === 401) {
          console.log('[WA] 🧹 Errore 401, pulizia auth e retry');
          clearAuthFiles();
          sock = null;
          setTimeout(() => connectToWhatsApp(), 3000);
        }
        else if (lastDisconnect?.error?.output?.statusCode === 428) {
          console.log('[WA] 🧹 QR scaduto, pulizia auth e retry');
          clearAuthFiles();
          sock = null;
          setTimeout(() => connectToWhatsApp(), 3000);
        }
        else if (shouldReconnect) {
          setTimeout(() => connectToWhatsApp(), 5000);
        }
      } 
      else if (connection === 'open') {
        console.log('[WA] ✅ Connesso a WhatsApp');
        isConnected = true;
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
    
    if (error.message?.includes('invalid') || error.message?.includes('unauthorized')) {
      console.log('[WA] 🧹 Errore critico, pulizia auth');
      clearAuthFiles();
    }
    
    setTimeout(() => connectToWhatsApp(), 10000);
  }
}

// Avvia connessione all'avvio
connectToWhatsApp();

// ========================================
// ROUTES
// ========================================

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MiApp WhatsApp Server',
    version: '1.2.0',
    connected: isConnected,
    isConnecting: isConnecting
  });
});

app.get('/status', (req, res) => {
  console.log('[STATUS] 📊 Richiesta stato');
  
  res.json({
    connected: isConnected,
    qrCode: qrCodeData,
    phoneNumber: phoneNumber,
    isConnecting: isConnecting
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
    
    if (!sock || !isConnected) {
      return res.status(503).json({ 
        error: 'WhatsApp non connesso' 
      });
    }
    
    console.log('[SEND] 📤 Invio messaggio a:', targetNumber);
    
    const cleanNumber = targetNumber.replace(/\D/g, '');
    const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    await sock.sendMessage(jid, { text: message });
    
    console.log('[SEND] ✅ Messaggio inviato con successo');
    
    res.json({ 
      success: true,
      messageId: Date.now().toString()
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
    
    isConnected = false;
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
    
    isConnected = false;
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
    
    isConnected = false;
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
  console.log('='.repeat(60));
});