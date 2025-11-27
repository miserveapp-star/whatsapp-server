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
import axios from 'axios';

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'miserve_whatsapp_2024_SUPERSECRET123';
const AUTH_DIR = './auth_info_baileys';

app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let phoneNumber = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 3;

const logger = pino({ level: 'silent' });

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

// 🗑️ FUNZIONE: Elimina sessione corrotta
async function clearAuthSession() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      console.log('[WHATSAPP] 🗑️ Pulizia sessione corrotta...');
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log('[WHATSAPP] ✅ Sessione eliminata');
    }
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore pulizia sessione:', error);
  }
}

// 🔄 FUNZIONE: Connessione WhatsApp
async function connectToWhatsApp(forceNewQR = false) {
  try {
    // Se forziamo nuovo QR, eliminiamo la sessione esistente
    if (forceNewQR) {
      console.log('[WHATSAPP] 🔄 Rigenerazione QR forzata...');
      await clearAuthSession();
      connectionStatus = 'initializing';
      qrCodeData = null;
      phoneNumber = null;
      reconnectAttempts = 0;
    }

    console.log('[WHATSAPP] 🚀 Avvio connessione...');
    
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
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
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // 📱 GENERAZIONE QR CODE
      if (qr) {
        console.log('[WHATSAPP] 📱 QR Code generato');
        connectionStatus = 'qr_ready';
        qrCodeData = await QRCode.toDataURL(qr);
        reconnectAttempts = 0;
        
        // Mostra QR in console per debug
        qrcode.generate(qr, { small: true });
      }
      
      // ❌ CONNESSIONE CHIUSA
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log('[WHATSAPP] ❌ Connessione chiusa');
        console.log('[WHATSAPP] 📊 Status Code:', statusCode);
        console.log('[WHATSAPP] 📊 Disconnect Reason:', DisconnectReason[statusCode] || 'Unknown');
        
        connectionStatus = 'disconnected';
        phoneNumber = null;
        
        // 🔍 CASO 1: Logout esplicito
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[WHATSAPP] 🚫 Logout effettuato - Rigenerazione QR...');
          await clearAuthSession();
          qrCodeData = null;
          setTimeout(() => connectToWhatsApp(true), 2000);
        }
        // 🔍 CASO 2: Disconnessione dal telefono
        else if (statusCode === DisconnectReason.connectionClosed || 
                 statusCode === DisconnectReason.connectionLost ||
                 statusCode === DisconnectReason.timedOut) {
          
          reconnectAttempts++;
          console.log(`[WHATSAPP] 📱 Disconnessione rilevata (tentativo ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
          
          if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.log('[WHATSAPP] 🔄 Troppi tentativi falliti - Rigenerazione QR...');
            await clearAuthSession();
            qrCodeData = null;
            reconnectAttempts = 0;
            setTimeout(() => connectToWhatsApp(true), 2000);
          } else {
            console.log('[WHATSAPP] 🔄 Riconnessione automatica...');
            qrCodeData = null;
            setTimeout(() => connectToWhatsApp(), 3000);
          }
        }
        // 🔍 CASO 3: Altri errori
        else if (shouldReconnect) {
          console.log('[WHATSAPP] 🔄 Riconnessione generica...');
          qrCodeData = null;
          setTimeout(() => connectToWhatsApp(), 3000);
        }
      } 
      // ✅ CONNESSIONE APERTA
      else if (connection === 'open') {
        console.log('[WHATSAPP] ✅ Connesso con successo!');
        connectionStatus = 'connected';
        qrCodeData = null;
        reconnectAttempts = 0;
        
        const user = sock.user;
        phoneNumber = user?.id?.split(':')[0] || null;
        console.log('[WHATSAPP] 📞 Numero:', phoneNumber);
      }
      // 🔄 CONNESSIONE IN CORSO
      else if (connection === 'connecting') {
        console.log('[WHATSAPP] 🔄 Connessione in corso...');
        connectionStatus = 'connecting';
      }
    });
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore connessione:', error);
    connectionStatus = 'error';
    setTimeout(() => connectToWhatsApp(), 5000);
  }
}

// 🚀 AVVIO AUTOMATICO
connectToWhatsApp();

// ========================================
// ROUTES API
// ========================================

// 🏠 HOME - Info server
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MiServe WhatsApp Server',
    version: '2.1.0',  // 🆕 Versione aggiornata
    connectionStatus: connectionStatus,
    connected: connectionStatus === 'connected',
    hasQR: qrCodeData !== null,
    phoneNumber: phoneNumber,
    uptime: process.uptime(),
    features: ['send', 'send-image', 'status', 'disconnect', 'regenerate-qr']  // 🆕
  });
});

// 📊 STATUS - Stato connessione + QR
app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    qrCode: qrCodeData,
    phoneNumber: phoneNumber,
    hasQR: qrCodeData !== null,
    reconnectAttempts: reconnectAttempts,
    timestamp: new Date().toISOString()
  });
});

// 🔄 REGENERATE QR - Forza nuovo QR code
app.post('/regenerate-qr', authenticate, async (req, res) => {
  try {
    console.log('[WHATSAPP] 🔄 Richiesta rigenerazione QR');
    
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.log('[WHATSAPP] ⚠️ Errore logout socket (ignorato):', err.message);
      }
      sock = null;
    }
    
    await clearAuthSession();
    
    connectionStatus = 'initializing';
    phoneNumber = null;
    qrCodeData = null;
    reconnectAttempts = 0;
    
    setTimeout(() => connectToWhatsApp(true), 1000);
    
    res.json({ 
      success: true,
      message: 'QR Code in generazione...',
      status: 'initializing'
    });
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore rigenerazione QR:', error);
    res.status(500).json({ 
      success: false,
      error: 'Errore rigenerazione QR',
      details: error.message
    });
  }
});

// 📤 SEND - Invio messaggio testuale
app.post('/send', authenticate, async (req, res) => {
  try {
    const { phoneNumber: targetNumber, message } = req.body;
    
    if (!targetNumber || !message) {
      return res.status(400).json({ 
        success: false,
        error: 'phoneNumber e message richiesti' 
      });
    }
    
    if (!sock || connectionStatus !== 'connected') {
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp non connesso',
        status: connectionStatus
      });
    }
    
    console.log('[WHATSAPP] 📤 Invio messaggio a:', targetNumber);
    
    const cleanNumber = targetNumber.replace(/\D/g, '');
    const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    const result = await sock.sendMessage(jid, { text: message });
    
    console.log('[WHATSAPP] ✅ Messaggio inviato');
    
    res.json({ 
      success: true,
      messageId: result.key.id || Date.now().toString(),
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore invio:', error);
    res.status(500).json({ 
      success: false,
      error: 'Errore invio messaggio',
      details: error.message 
    });
  }
});

// ========================================
// 🆕 SEND-IMAGE - Invio messaggio con immagine
// ========================================
app.post('/send-image', authenticate, async (req, res) => {
  try {
    const { phoneNumber: targetNumber, imageUrl, caption } = req.body;
    
    if (!targetNumber) {
      return res.status(400).json({ 
        success: false,
        error: 'phoneNumber è richiesto' 
      });
    }
    
    if (!imageUrl) {
      return res.status(400).json({ 
        success: false,
        error: 'imageUrl è richiesto' 
      });
    }
    
    if (!sock || connectionStatus !== 'connected') {
      return res.status(503).json({ 
        success: false,
        error: 'WhatsApp non connesso',
        status: connectionStatus
      });
    }
    
    console.log('[WHATSAPP] 🖼️ Invio immagine a:', targetNumber);
    console.log('[WHATSAPP] 🔗 URL Immagine:', imageUrl.substring(0, 100) + '...');
    
    const cleanNumber = targetNumber.replace(/\D/g, '');
    const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    let imageBuffer;
    let mimeType = 'image/jpeg';
    
    // 🔍 Controlla se è un URL o base64
    if (imageUrl.startsWith('data:')) {
      // È un base64
      console.log('[WHATSAPP] 📦 Immagine in formato base64');
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
      // È un URL - scarica l'immagine
      console.log('[WHATSAPP] 🌐 Download immagine da URL...');
      try {
        const imageResponse = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'User-Agent': 'MiServe WhatsApp Bot/2.1.0'
          }
        });
        imageBuffer = Buffer.from(imageResponse.data);
        mimeType = imageResponse.headers['content-type'] || 'image/jpeg';
        console.log('[WHATSAPP] ✅ Immagine scaricata, dimensione:', imageBuffer.length, 'bytes');
      } catch (downloadError) {
        console.error('[WHATSAPP] ❌ Errore download immagine:', downloadError.message);
        return res.status(400).json({ 
          success: false,
          error: 'Impossibile scaricare l\'immagine',
          details: downloadError.message
        });
      }
    }
    
    // Verifica dimensione (max 16MB per WhatsApp)
    if (imageBuffer.length > 16 * 1024 * 1024) {
      return res.status(400).json({ 
        success: false,
        error: 'Immagine troppo grande (max 16MB)' 
      });
    }
    
    // 📤 Invia messaggio con immagine
    const result = await sock.sendMessage(jid, {
      image: imageBuffer,
      caption: caption || '',
      mimetype: mimeType
    });
    
    console.log('[WHATSAPP] ✅ Immagine inviata con successo');
    
    res.json({ 
      success: true,
      messageId: result.key.id || Date.now().toString(),
      timestamp: new Date().toISOString(),
      imageSize: imageBuffer.length
    });
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore invio immagine:', error);
    res.status(500).json({ 
      success: false,
      error: 'Errore invio immagine',
      details: error.message 
    });
  }
});

// 🔌 DISCONNECT - Disconnessione
app.post('/disconnect', authenticate, async (req, res) => {
  try {
    console.log('[WHATSAPP] 🔌 Richiesta disconnessione');
    
    if (sock) {
      await sock.logout();
      sock = null;
    }
    
    await clearAuthSession();
    
    connectionStatus = 'disconnected';
    phoneNumber = null;
    qrCodeData = null;
    reconnectAttempts = 0;
    
    console.log('[WHATSAPP] ✅ Disconnesso');
    
    res.json({ 
      success: true,
      message: 'Disconnesso - usa /regenerate-qr per riconnetterti'
    });
    
    // Avvia rigenerazione QR dopo 2 secondi
    setTimeout(() => {
      console.log('[WHATSAPP] 🔄 Auto-rigenerazione QR...');
      connectToWhatsApp(true);
    }, 2000);
    
  } catch (error) {
    console.error('[WHATSAPP] ❌ Errore disconnessione:', error);
    res.status(500).json({ 
      success: false,
      error: 'Errore disconnessione',
      details: error.message
    });
  }
});

// 🚀 AVVIO SERVER
app.listen(PORT, () => {
  console.log(`✅ Server WhatsApp in ascolto su porta ${PORT}`);
  console.log(`🔐 Auth token configurato`);
  console.log(`📱 Versione: 2.1.0`);
  console.log(`🖼️ Supporto immagini: ATTIVO`);
  console.log(`🔄 Max tentativi riconnessione: ${MAX_RECONNECT_ATTEMPTS}`);
});