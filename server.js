require('dotenv').config();
const dns = require('dns');

// Fix for querySrv ECONNREFUSED issues on some networks
if (dns.setServers) {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
}

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const admin = require('firebase-admin');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const DeviceData = require('./models/DeviceData');

// Create uploads directory if it doesn't exist
const uploadDir = 'uploads';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage: storage });

// Initialize Firebase Admin
let serviceAccount;
if (process.env.FIREBASE_PROJECT_ID) {
  serviceAccount = {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // Replace literal '\n' with actual linebreaks so the private key works
    privateKey: process.env.FIREBASE_PRIVATE_KEY ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
  };
} else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
  } catch (err) {
    console.warn("No Firebase service account found. Please provide env vars or serviceAccountKey.json");
  }
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/tracking_app';
console.log('Using MongoDB URI:', MONGODB_URI);

// Middleware
app.use(cors({
  origin: '*', // Allow all for debugging
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/streams', express.static(path.join(__dirname, 'streams')));

// MongoDB Connection
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// Routes
// Receiving data from the app (supports both JSON and Multipart/Form-Data for images)
app.post('/api/submit', upload.single('image'), async (req, res) => {
  try {
    const data = req.body;
    const deviceId = data.deviceId || data.device_id;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId or device_id is required' });
    }

    // If a file was uploaded, add its path to the data
    if (req.file) {
      data.imageUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      data.imagePath = req.file.path;
      console.log(`Image received and saved: ${req.file.filename}`);
    }

    // Map location if it's a string to location_string to avoid schema collision
    if (typeof data.location === 'string') {
      data.location_string = data.location;
    }

    // Parse any top-level stringified JSON fields automatically
    Object.keys(data).forEach(key => {
      if (typeof data[key] === 'string' && (data[key].startsWith('{') || data[key].startsWith('['))) {
        try {
          data[key] = JSON.parse(data[key]);
        } catch (e) {
          // Keep as string if parsing fails
        }
      }
    });

    const newEntry = new DeviceData(data);
    newEntry.deviceId = deviceId; // Ensure deviceId is set for the model
    await newEntry.save({ validateBeforeSave: false });

    console.log(`Data saved for device: ${deviceId} at ${new Date().toISOString()}`);
    res.status(201).json({ 
      message: 'Data saved successfully', 
      id: newEntry._id,
      imageUrl: data.imageUrl || null 
    });
  } catch (err) {
    console.error('Error saving data:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Status endpoint
app.get('/api/status', (req, res) => {
  res.json({ status: 'Backend is running' });
});

// Sending FCM notification
app.post('/api/send-notification', async (req, res) => {
  try {
    const { to, data } = req.body;

    if (!to) {
      return res.status(400).json({ error: 'Recipient token (to) is required' });
    }

    const message = {
      token: to,
      data: data || {}
    };

    const response = await admin.messaging().send(message);
    console.log('Successfully sent message:', response);
    res.status(200).json({ message: 'Notification sent successfully', response });
  } catch (err) {
    // FCM token is no longer valid (app uninstalled, token rotated, etc.)
    if (err.errorInfo && err.errorInfo.code === 'messaging/registration-token-not-registered') {
      console.warn(`FCM token is no longer registered (stale/expired): ${req.body.to}`);

      // Optional: remove the stale token from the database
      try {
        await DeviceData.updateMany(
          { fcmToken: req.body.to },
          { $unset: { fcmToken: '' } }
        );
        console.log('Stale FCM token removed from database.');
      } catch (dbErr) {
        console.error('Failed to remove stale token from DB:', dbErr.message);
      }

      return res.status(410).json({
        error: 'FCM token is no longer registered. The device token is stale or expired.',
        code: err.errorInfo.code
      });
    }

    console.error('Error sending notification:', err);
    res.status(500).json({ error: 'Failed to send notification', details: err.message });
  }
});

// Admin routes
app.get('/api/admin/data', async (req, res) => {
  try {
    const data = await DeviceData.find().sort({ submittedAt: -1 });
    res.status(200).json(data);
  } catch (err) {
    console.error('Error fetching admin data:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Admin route to get data for a specific device
app.get('/api/admin/device/:deviceId', async (req, res) => {
  try {
    const { deviceId } = req.params;
    const data = await DeviceData.find({ deviceId }).sort({ submittedAt: -1 });
    res.status(200).json(data);
  } catch (err) {
    console.error(`Error fetching data for device ${req.params.deviceId}:`, err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Admin route to get latest data for each unique device
app.get('/api/admin/devices', async (req, res) => {
  try {
    const devices = await DeviceData.aggregate([
      { $sort: { submittedAt: -1 } },
      {
        $group: {
          _id: "$deviceId",
          latestSubmission: { $first: "$$ROOT" }
        }
      },
      { $replaceRoot: { newRoot: "$latestSubmission" } }
    ]);
    res.status(200).json(devices);
  } catch (err) {
    console.error('Error fetching unique devices:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// Socket.io connection handler
io.on('connection', (socket) => {
  // Extract device_id from query or auth object
  const deviceId = socket.handshake.query.device_id || socket.handshake.auth.device_id;
  
  if (deviceId) {
    socket.deviceId = deviceId;
    socket.join(deviceId); // Join a room named by deviceId for targeted emits
    console.log(`[Socket] New client: ${socket.id} (Device ID: ${deviceId}) joined room: ${deviceId}`);
  } else {
    console.log(`[Socket] New client: ${socket.id} (No Device ID provided)`);
  }

  // Also listen for an explicit 'device_id' event in case it's sent after connection
  socket.on('device_id', (data) => {
    const receivedId = typeof data === 'string' ? data : data.device_id;
    if (receivedId) {
      socket.deviceId = receivedId;
      socket.join(receivedId);
      console.log(`[Socket] Received Device ID via event from ${socket.id}: ${receivedId}`);
      socket.emit('device_id_confirmed', { device_id: receivedId });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[Socket] Client disconnected: ${socket.id}${socket.deviceId ? ` (Device ID: ${socket.deviceId})` : ''}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
