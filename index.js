import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import express from 'express';
import cors from 'cors';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';

const app = express();
const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'miapp-secret-token-2024-change-this';

app.use(cors());
app.use(express.json());

let sock = null;
let qrCodeData = null;
let isConnected = false;
let phoneNumber = null;

// Middleware autenticazione (solo per send e disconnect)
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

// Funzione connessione WhatsApp
async function connectToWhatsApp() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();
    
    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: true
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('[WA] QR Code generato');
        qrCodeData = await QRCode.toDataURL(qr);
        qrcode.generate(qr, { small: true });
      }
      
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
        console.log('[WA] Connessione chiusa. Riconnessione:', shouldReconnect);
        
        isConnected = false;
        phoneNumber = null;
        qrCodeData = null;
        
        if (shouldReconnect) {
          setTimeout(() => connectToWhatsApp(), 5000);
        }
      } else if (connection === 'open') {
        console.log('[WA] Connesso a WhatsApp');
        isConnected = true;
        qrCodeData = null;
        
        try {
          const user = sock.user;
          phoneNumber = user?.id?.split(':')[0] || null;
          console.log('[WA] Numero connesso:', phoneNumber);
        } catch (error) {
          console.error('[WA] Errore recupero numero:', error);
        }
      }
    });
    
    sock.ev.on('messages.upsert', async ({ messages }) => {
      console.log('[WA] Messaggio ricevuto:', messages[0]?.key?.remoteJid);
    });
    
  } catch (error) {
    console.error('[WA] Errore connessione:', error);
    setTimeout(() => connectToWhatsApp(), 10000);
  }
}

// Avvia connessione all'avvio
connectToWhatsApp();

// ROUTES

// Health check (pubblico)
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    service: 'MiApp WhatsApp Server',
    version: '1.0.0'
  });
});

// Status endpoint (PUBBLICO - no auth)
app.get('/status', (req, res) => {
  console.log('[STATUS] Richiesta stato');
  
  res.json({
    connected: isConnected,
    qrCode: qrCodeData,
    phoneNumber: phoneNumber
  });
});

// Send message (con auth)
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
    
    console.log('[SEND] Invio messaggio a:', targetNumber);
    
    const cleanNumber = targetNumber.replace(/\D/g, '');
    const jid = cleanNumber.includes('@') ? cleanNumber : `${cleanNumber}@s.whatsapp.net`;
    
    await sock.sendMessage(jid, { text: message });
    
    console.log('[SEND] Messaggio inviato con successo');
    
    res.json({ 
      success: true,
      messageId: Date.now().toString()
    });
    
  } catch (error) {
    console.error('[SEND] Errore invio:', error);
    res.status(500).json({ 
      error: 'Errore invio messaggio',
      details: error.message 
    });
  }
});

// Disconnect (con auth)
app.post('/disconnect', authenticate, async (req, res) => {
  try {
    console.log('[DISCONNECT] Richiesta disconnessione');
    
    if (sock) {
      await sock.logout();
      sock = null;
    }
    
    isConnected = false;
    phoneNumber = null;
    qrCodeData = null;
    
    console.log('[DISCONNECT] Disconnesso con successo');
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('[DISCONNECT] Errore:', error);
    res.status(500).json({ 
      error: 'Errore disconnessione',
      details: error.message 
    });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint non trovato' });
});

// Error handler
app.use((error, req, res, next) => {
  console.error('[ERROR]', error);
  res.status(500).json({ error: 'Errore server interno' });
});

// Avvia server
app.listen(PORT, () => {
  console.log(`[SERVER] In ascolto su porta ${PORT}`);
  console.log(`[SERVER] Ambiente: ${process.env.NODE_ENV || 'development'}`);
});