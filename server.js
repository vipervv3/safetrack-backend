const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// In-memory storage (in production, use a real database)
const users = new Map(); // userId -> user data
const userSockets = new Map(); // userId -> socket.id
const emergencyContacts = new Map(); // userId -> array of contact userIds
const activeTracking = new Map(); // userId -> tracking data

// Middleware
app.use(express.json());
app.use(cors({
  origin: true,
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per 15 minutes
  message: { 
    error: 'Too many requests from this IP. Please try again later.',
    retryAfter: '15 minutes'
  }
});
app.use('/api', limiter);

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'SafeTrack Real-time Communication Server',
    status: 'ready',
    timestamp: new Date().toISOString(),
    connectedUsers: users.size,
    activeTracking: activeTracking.size
  });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    service: 'SafeTrack Backend',
    timestamp: new Date().toISOString(),
    stats: {
      totalUsers: users.size,
      connectedUsers: userSockets.size,
      activeTracking: activeTracking.size
    }
  });
});

// User registration/login
app.post('/api/user/register', (req, res) => {
  try {
    const { name, userId } = req.body;
    
    if (!name || !userId) {
      return res.status(400).json({
        success: false,
        error: 'Name and userId are required'
      });
    }

    // Check if userId already exists
    if (users.has(userId)) {
      return res.status(409).json({
        success: false,
        error: 'User ID already exists. Please choose a different one.'
      });
    }

    const user = {
      name,
      userId,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString()
    };

    users.set(userId, user);
    emergencyContacts.set(userId, []);

    console.log(`✅ User registered: ${userId} (${name})`);

    res.json({
      success: true,
      user: user
    });

  } catch (error) {
    console.error('❌ Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Registration failed'
    });
  }
});

// Get user info
app.get('/api/user/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const user = users.get(userId);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    res.json({
      success: true,
      user: {
        name: user.name,
        userId: user.userId,
        isOnline: userSockets.has(userId),
        lastActive: user.lastActive
      }
    });

  } catch (error) {
    console.error('❌ Get user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get user info'
    });
  }
});

// Add emergency contact
app.post('/api/contacts/add', (req, res) => {
  try {
    const { userId, contactUserId } = req.body;

    if (!userId || !contactUserId) {
      return res.status(400).json({
        success: false,
        error: 'userId and contactUserId are required'
      });
    }

    // Check if both users exist
    if (!users.has(userId) || !users.has(contactUserId)) {
      return res.status(404).json({
        success: false,
        error: 'One or both users not found'
      });
    }

    const userContacts = emergencyContacts.get(userId) || [];
    
    // Check if contact already exists
    if (userContacts.includes(contactUserId)) {
      return res.status(409).json({
        success: false,
        error: 'Contact already exists'
      });
    }

    userContacts.push(contactUserId);
    emergencyContacts.set(userId, userContacts);

    const contactUser = users.get(contactUserId);

    console.log(`📱 Contact added: ${userId} -> ${contactUserId}`);

    res.json({
      success: true,
      contact: {
        name: contactUser.name,
        userId: contactUser.userId,
        isOnline: userSockets.has(contactUserId)
      }
    });

  } catch (error) {
    console.error('❌ Add contact error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to add contact'
    });
  }
});

// Get emergency contacts
app.get('/api/contacts/:userId', (req, res) => {
  try {
    const { userId } = req.params;
    const userContacts = emergencyContacts.get(userId) || [];
    
    const contacts = userContacts.map(contactId => {
      const user = users.get(contactId);
      return {
        name: user.name,
        userId: user.userId,
        isOnline: userSockets.has(contactId),
        lastActive: user.lastActive
      };
    }).filter(Boolean);

    res.json({
      success: true,
      contacts: contacts
    });

  } catch (error) {
    console.error('❌ Get contacts error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get contacts'
    });
  }
});

// Start safety tracking
app.post('/api/tracking/start', (req, res) => {
  try {
    const { userId, duration, location } = req.body;

    if (!userId || !duration) {
      return res.status(400).json({
        success: false,
        error: 'userId and duration are required'
      });
    }

    const trackingData = {
      userId,
      duration,
      startTime: new Date().toISOString(),
      location: location || null,
      isActive: true
    };

    activeTracking.set(userId, trackingData);

    // Notify user's contacts that tracking started
    const userContacts = emergencyContacts.get(userId) || [];
    const user = users.get(userId);

    userContacts.forEach(contactId => {
      const contactSocketId = userSockets.get(contactId);
      if (contactSocketId) {
        io.to(contactSocketId).emit('contact_tracking_started', {
          from: {
            name: user.name,
            userId: user.userId
          },
          duration: duration,
          startTime: trackingData.startTime,
          timestamp: new Date().toISOString()
        });
      }
    });

    console.log(`🛡️ Tracking started: ${userId} for ${duration}s`);

    res.json({
      success: true,
      tracking: trackingData
    });

  } catch (error) {
    console.error('❌ Start tracking error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start tracking'
    });
  }
});

// Stop safety tracking
app.post('/api/tracking/stop', (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const trackingData = activeTracking.get(userId);
    if (trackingData) {
      activeTracking.delete(userId);
      
      // Notify contacts that tracking stopped
      const userContacts = emergencyContacts.get(userId) || [];
      const user = users.get(userId);

      userContacts.forEach(contactId => {
        const contactSocketId = userSockets.get(contactId);
        if (contactSocketId) {
          io.to(contactSocketId).emit('contact_tracking_stopped', {
            from: {
              name: user.name,
              userId: user.userId
            },
            timestamp: new Date().toISOString()
          });
        }
      });

      console.log(`🛑 Tracking stopped: ${userId}`);
    }

    res.json({
      success: true
    });

  } catch (error) {
    console.error('❌ Stop tracking error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to stop tracking'
    });
  }
});

// Send emergency alert
app.post('/api/emergency/alert', (req, res) => {
  try {
    const { userId, location } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required'
      });
    }

    const user = users.get(userId);
    const userContacts = emergencyContacts.get(userId) || [];

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    if (userContacts.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No emergency contacts configured'
      });
    }

    const emergencyAlert = {
      from: {
        name: user.name,
        userId: user.userId
      },
      location: location || null,
      timestamp: new Date().toISOString(),
      message: `🚨 EMERGENCY: ${user.name} has not responded to their safety check and may need assistance.`
    };

    let notifiedCount = 0;
    let totalContacts = userContacts.length;

    // Send real-time notifications to online contacts
    userContacts.forEach(contactId => {
      const contactSocketId = userSockets.get(contactId);
      if (contactSocketId) {
        io.to(contactSocketId).emit('emergency_alert', emergencyAlert);
        notifiedCount++;
        console.log(`🚨 Emergency alert sent to: ${contactId}`);
      }
    });

    // Remove from active tracking
    activeTracking.delete(userId);

    console.log(`🚨 EMERGENCY ALERT: ${userId} - ${notifiedCount}/${totalContacts} contacts notified`);

    res.json({
      success: true,
      alert: emergencyAlert,
      stats: {
        totalContacts: totalContacts,
        notifiedContacts: notifiedCount,
        onlineContacts: notifiedCount
      }
    });

  } catch (error) {
    console.error('❌ Emergency alert error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send emergency alert'
    });
  }
});

// WebSocket connection handling
io.on('connection', (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  // User authentication
  socket.on('authenticate', (data) => {
    const { userId } = data;
    
    if (userId && users.has(userId)) {
      userSockets.set(userId, socket.id);
      socket.userId = userId;
      
      // Update last active
      const user = users.get(userId);
      user.lastActive = new Date().toISOString();
      users.set(userId, user);

      socket.emit('authenticated', { 
        success: true, 
        userId: userId,
        timestamp: new Date().toISOString()
      });

      // Notify contacts that user is online
      const userContacts = emergencyContacts.get(userId) || [];
      userContacts.forEach(contactId => {
        const contactSocketId = userSockets.get(contactId);
        if (contactSocketId) {
          io.to(contactSocketId).emit('contact_online', {
            userId: userId,
            name: user.name,
            timestamp: new Date().toISOString()
          });
        }
      });

      console.log(`✅ User authenticated: ${userId}`);
    } else {
      socket.emit('authentication_failed', { 
        success: false, 
        error: 'Invalid user ID' 
      });
    }
  });

  // Safety acknowledgment
  socket.on('safety_acknowledged', (data) => {
    const { userId, location } = data;
    
    if (userId && users.has(userId)) {
      const user = users.get(userId);
      const userContacts = emergencyContacts.get(userId) || [];

      // Notify contacts of acknowledgment
      userContacts.forEach(contactId => {
        const contactSocketId = userSockets.get(contactId);
        if (contactSocketId) {
          io.to(contactSocketId).emit('contact_acknowledged', {
            from: {
              name: user.name,
              userId: user.userId
            },
            location: location || null,
            timestamp: new Date().toISOString()
          });
        }
      });

      console.log(`✅ Safety acknowledged: ${userId}`);
    }
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    if (socket.userId) {
      const userId = socket.userId;
      userSockets.delete(userId);

      // Notify contacts that user went offline
      const userContacts = emergencyContacts.get(userId) || [];
      const user = users.get(userId);
      
      if (user) {
        userContacts.forEach(contactId => {
          const contactSocketId = userSockets.get(contactId);
          if (contactSocketId) {
            io.to(contactSocketId).emit('contact_offline', {
              userId: userId,
              name: user.name,
              timestamp: new Date().toISOString()
            });
          }
        });
      }

      console.log(`🔌 User disconnected: ${userId}`);
    }
    
    console.log(`🔌 Socket disconnected: ${socket.id}`);
  });
});

// Global error handling
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 SafeTrack Backend running on port ${PORT}`);
  console.log(`📡 Health check: http://localhost:${PORT}/api/health`);
  console.log(`🔌 WebSocket ready for real-time communication`);
  console.log(`📱 Ready for device-to-device notifications`);
});

module.exports = { app, server };
