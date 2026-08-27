const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { registerSseClient, db } = require('./store');
const { startPassiveScanner } = require('./scanner');

const attendanceRoutes = require('./routes/attendance');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());

// Raw and JSON body parser
app.use((req, res, next) => {
  if (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch (err) {
        req.body = {};
      }
      next();
    });
  } else {
    req.body = {};
    next();
  }
});

app.use(morgan(':date[iso] :method :url :status :res[content-length] - :response-time ms'));

// Serve Web Dashboard Static Files
app.use(express.static(path.join(__dirname, '..', 'public')));

// Real-time SSE Stream for Live Dashboard
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  registerSseClient(res);
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'SSE Stream active', time: new Date().toISOString() })}\n\n`);
});

// API Routes
app.use('/api/attendance', attendanceRoutes);
app.use('/api/dashboard', dashboardRoutes);

// Fallback to Dashboard SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\n======================================================');
  console.log(`🚀 Office Presence Sentinel Backend & Dashboard`);
  console.log(`🌐 Web Dashboard: http://localhost:${PORT}`);
  console.log(`📡 Network URL:   http://192.168.18.68:${PORT}`);
  console.log('======================================================\n');

  // Start 24/7 Zero-Touch Wi-Fi Presence Scanner
  startPassiveScanner();
});