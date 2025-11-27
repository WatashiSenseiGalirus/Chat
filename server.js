const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const { escape } = require('html-escaper');

const app = express();
const server = http.createServer(app);

// Socket.IO configuration untuk Vercel
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// In-memory storage untuk Vercel
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Memory storage untuk Vercel
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: { fileSize: MAX_FILE_SIZE }
});

// Server setup
const serverStartTime = Date.now();
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Data storage in-memory untuk Vercel
let onlineUsers = [];
let messages = [];
const deletePassword = "12345";

// File storage in memory
const fileStorage = new Map();

// Load chat history
const loadChatHistory = () => {
  console.log('Chat history di-memory untuk Vercel environment');
};

loadChatHistory();

// Routes - tetap sama seperti original
app.get('/login', (req, res) => {
  res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(publicDir, 'chat.html'));
});

app.get('/chat-history', (req, res) => {
  res.json(messages);
});

app.post('/login', express.json(), (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: 'Semua data harus diisi' });
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: 'No file uploaded or file too large.' });
  }
  
  // Simpan file di memory
  const fileId = Date.now().toString();
  fileStorage.set(fileId, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    originalname: req.file.originalname,
    size: req.file.size
  });

  const fileData = {
    filename: req.file.originalname,
    path: `/api/file/${fileId}`,
    mimetype: req.file.mimetype,
    fileId: fileId,
    size: req.file.size
  };
  
  res.json({ success: true, file: fileData });
});

// Endpoint untuk serve file dari memory
app.get('/api/file/:fileId', (req, res) => {
  const fileId = req.params.fileId;
  const fileData = fileStorage.get(fileId);
  
  if (!fileData) {
    return res.status(404).send('File not found');
  }
  
  res.setHeader('Content-Type', fileData.mimetype);
  res.setHeader('Content-Length', fileData.size);
  res.send(fileData.buffer);
});

app.post('/delete-message', (req, res) => {
  const { timestamp, password } = req.body;
  if (password !== deletePassword) {
    return res.status(403).json({ success: false, message: 'Akses ditolak: password salah.' });
  }

  const initialLength = messages.length;
  messages = messages.filter(message => message.timestamp !== timestamp);
  
  if (messages.length < initialLength) {
    res.json({ success: true, message: 'Pesan berhasil dihapus' });
  } else {
    res.status(404).json({ success: false, message: 'Pesan tidak ditemukan' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    onlineUsers: onlineUsers.length,
    totalMessages: messages.length,
    totalFiles: fileStorage.size
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.redirect('/login');
});

// WebSocket Connection
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  let ip = socket.handshake.headers['x-forwarded-for'] || 
           socket.handshake.address || 
           socket.request.connection.remoteAddress;
  
  if (ip.includes(',')) ip = ip.split(',')[0].trim();
  if (ip === '::1') ip = 'localhost';

  const userExists = onlineUsers.some(user => user.ip === ip);

  if (!userExists) {
    onlineUsers.push({ 
      id: socket.id, 
      ip, 
      connectedAt: new Date().toISOString() 
    });
  } else {
    onlineUsers = onlineUsers.map(user => 
      user.ip === ip ? { ...user, id: socket.id, lastSeen: new Date().toISOString() } : user
    );
  }

  io.emit('online users', onlineUsers.length);
  socket.emit('user ip', ip);

  // Kirim history chat ke user baru
  if (messages.length > 0) {
    socket.emit('chat history', messages);
  }

  socket.on('chat message', (message) => {
    try {
      // Validasi dan sanitize
      if (!message.name || !message.text) {
        return;
      }

      message.name = escape(message.name.trim());
      message.text = escape(message.text.trim());
      message.timestamp = message.timestamp || new Date().toISOString();

      // Handle file data
      if (message.file && message.file.content && message.file.content.startsWith('data:')) {
        const matches = message.file.content.match(/^data:(.+);base64,(.+)$/);
        if (matches && matches[2]) {
          const fileId = Date.now().toString();
          const buffer = Buffer.from(matches[2], 'base64');
          
          fileStorage.set(fileId, {
            buffer: buffer,
            mimetype: matches[1],
            originalname: message.file.name || 'file',
            size: buffer.length
          });
          
          message.file.content = `/api/file/${fileId}`;
        }
      }

      messages.push(message);
      
      // Batasi messages di memory (prevent memory leak)
      if (messages.length > 500) {
        messages = messages.slice(-250);
      }

      io.emit('chat message', message);
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });

  // Uptime interval
  const uptimeInterval = setInterval(() => {
    const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
    socket.emit('server uptime', uptime);
  }, 1000);

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    onlineUsers = onlineUsers.filter(user => user.id !== socket.id);
    io.emit('online users', onlineUsers.length);
    clearInterval(uptimeInterval);
  });

  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Cleanup interval untuk hapus file lama (24 jam)
setInterval(() => {
  const twentyFourHoursAgo = Date.now() - (24 * 60 * 60 * 1000);
  let deletedCount = 0;
  
  for (const [fileId, fileData] of fileStorage.entries()) {
    const fileTimestamp = parseInt(fileId);
    if (fileTimestamp < twentyFourHoursAgo) {
      fileStorage.delete(fileId);
      deletedCount++;
    }
  }
  
  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} old files`);
  }
}, 60 * 60 * 1000); // Run every 1 hour

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start Server
const PORT = process.env.PORT || 3000;

// Export untuk Vercel
module.exports = app;

// Only listen if not in Vercel environment
if (process.env.VERCEL !== '1') {
  server.listen(PORT, () => {
    console.log(`🚀 Server berjalan di http://localhost:${PORT}/login`);
    console.log('📁 Public directory:', publicDir);
    console.log('⚡ Socket.IO ready untuk koneksi real-time');
  });
}
