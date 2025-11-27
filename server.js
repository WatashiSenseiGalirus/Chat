const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
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
  transports: ['websocket', 'polling'] // Important for Vercel
});

// In-memory storage untuk Vercel (karena filesystem read-only)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Storage configuration untuk Vercel
const storage = multer.memoryStorage(); // Gunakan memory storage di Vercel
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

// Simulate file storage in memory untuk Vercel
const fileStorage = new Map();

// Load chat history dari memory (di Vercel filesystem read-only)
const loadChatHistory = () => {
  // Di Vercel, kita simpan di memory saja
  // Atau bisa menggunakan database external nanti
  console.log('Chat history akan disimpan di memory (Vercel environment)');
};

loadChatHistory();

// Routes
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
  if (name) {
    res.json({ success: true });
  } else {
    res.status(400).json({ success: false, message: 'Semua data harus diisi' });
  }
});

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).send('No file uploaded or file too large.');
  }
  
  // Simpan file di memory untuk Vercel
  const fileId = Date.now().toString();
  fileStorage.set(fileId, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    originalname: req.file.originalname
  });

  const fileData = {
    filename: req.file.originalname,
    path: `/api/file/${fileId}`, // Endpoint khusus untuk serve file
    mimetype: req.file.mimetype,
    fileId: fileId
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
  res.send(fileData.buffer);
});

app.post('/delete-message', (req, res) => {
  const { timestamp, password } = req.body;
  if (password !== deletePassword) {
    return res.status(403).send('Akses ditolak: password salah.');
  }

  messages = messages.filter(message => message.timestamp !== timestamp);
  res.sendStatus(200);
});

// Health check endpoint untuk Vercel
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    uptime: Math.floor((Date.now() - serverStartTime) / 1000),
    onlineUsers: onlineUsers.length,
    totalMessages: messages.length
  });
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
    onlineUsers.push({ id: socket.id, ip, connectedAt: new Date() });
  } else {
    onlineUsers = onlineUsers.map(user => 
      user.ip === ip ? { ...user, id: socket.id } : user
    );
  }

  io.emit('online users', onlineUsers.length);
  socket.emit('user ip', ip);

  // Kirim history chat ke user baru
  messages.forEach(message => {
    socket.emit('chat message', message);
  });

  socket.on('chat message', (message) => {
    // Sanitize input
    message.text = escape(message.text);
    message.name = escape(message.name);
    
    // Handle file data untuk Vercel
    if (message.file && message.file.content) {
      // Untuk file yang di-upload, kita sudah punya endpoint khusus
      if (message.file.content.startsWith('data:')) {
        // Convert data URL ke buffer dan simpan di memory
        const matches = message.file.content.match(/^data:(.+);base64,(.+)$/);
        if (matches) {
          const fileId = Date.now().toString();
          const buffer = Buffer.from(matches[2], 'base64');
          
          fileStorage.set(fileId, {
            buffer: buffer,
            mimetype: matches[1],
            originalname: message.file.name
          });
          
          // Replace dengan endpoint yang aman
          message.file.content = `/api/file/${fileId}`;
        }
      }
    }

    messages.push(message);
    
    // Batasi jumlah messages di memory (prevent memory leak)
    if (messages.length > 1000) {
      messages = messages.slice(-500); // Keep only last 500 messages
    }

    io.emit('chat message', message);
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

// Cleanup interval untuk hapus file lama dari memory
setInterval(() => {
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  for (const [fileId, fileData] of fileStorage.entries()) {
    const fileTimestamp = parseInt(fileId);
    if (fileTimestamp < oneHourAgo) {
      fileStorage.delete(fileId);
    }
  }
}, 30 * 60 * 1000); // Run every 30 minutes

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
    console.log(`Server berjalan di http://localhost:${PORT}/login`);
    console.log('Environment:', process.env.NODE_ENV || 'development');
  });
}
