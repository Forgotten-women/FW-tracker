// Secure IT Administration & Workstation Relay
// Provides isolated, user-level remote shell, file transfer, and fleet diagnostics.
// Completely separated from dashboard and restricted to IT Master Key holders.

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { db } = require('../db');
const T = require('../util/time');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s || '')).digest('hex');
}

let cachedMasterKey = null;
let lastKeyFetch = 0;

async function getMasterKey() {
  const now = Date.now();
  if (cachedMasterKey && now - lastKeyFetch < 60000) {
    return cachedMasterKey;
  }
  try {
    const row = await db.prepare("SELECT value FROM org_settings WHERE key = 'it_admin_master_key'").get();
    if (row && row.value) {
      cachedMasterKey = String(row.value).trim();
      lastKeyFetch = now;
      return cachedMasterKey;
    }
  } catch (err) {
    console.warn('[itRelay] Error fetching master key from db:', err.message);
  }
  return process.env.IT_MASTER_KEY || null;
}

// Active connections: deviceId -> { ws, meta, employeeNumber, name, platform }
const activeAgents = new Map();
// Active admin connections: Set of ws
const activeAdmins = new Set();
// Command queues for polling fallback: deviceId -> [ { id, command, ... } ]
const pendingCommands = new Map();
// Responses for polling fallback: reqId -> response
const commandResponses = new Map();

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req, clientInfo) => {
  if (clientInfo.role === 'admin') {
    activeAdmins.add(ws);
    console.log('[itRelay] IT Admin CLI connected.');

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'list') {
          const list = await getWorkstationsList();
          ws.send(JSON.stringify({ type: 'list_response', list }));
          return;
        }

        if (msg.action === 'forward' && msg.target) {
          const agentEntry = findAgent(msg.target);
          if (!agentEntry) {
            // Check if device exists in DB
            const exists = await db.prepare('SELECT id FROM devices WHERE id = ? OR employee_id IN (SELECT id FROM employees WHERE employee_number = ?)').get(msg.target, msg.target);
            if (exists) {
              // Queue for polling fallback
              let q = pendingCommands.get(exists.id);
              if (!q) { q = []; pendingCommands.set(exists.id, q); }
              q.push(msg);
              ws.send(JSON.stringify({ type: 'queued', message: `Device ${msg.target} is offline; command queued for next heartbeat.` }));
            } else {
              ws.send(JSON.stringify({ type: 'error', message: `Workstation ${msg.target} not found.` }));
            }
            return;
          }

          // Normalize target to deviceId so client-side agent accepts it
          msg.target = agentEntry.meta.deviceId;
          agentEntry.ws.send(JSON.stringify(msg));
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => {
      activeAdmins.delete(ws);
      console.log('[itRelay] IT Admin CLI disconnected.');
    });

    ws.on('error', () => {
      activeAdmins.delete(ws);
    });

  } else if (clientInfo.role === 'agent') {
    const { deviceId, employeeNumber, employeeName, platform } = clientInfo;

    // Terminate any previous stale connection for this deviceId
    const prev = activeAgents.get(deviceId);
    if (prev && prev.ws && prev.ws !== ws) {
      try { prev.ws.terminate(); } catch (_) {}
    }

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    activeAgents.set(deviceId, {
      ws,
      meta: {
        deviceId,
        employeeNumber,
        employeeName,
        platform,
        connectedAt: Date.now(),
      },
    });
    console.log(`[itRelay] Agent connected: ${deviceId} (${employeeName} / ${employeeNumber})`);

    ws.on('message', (raw) => {
      ws.isAlive = true;
      // Forward agent responses to all connected admin consoles
      const str = raw.toString();
      for (const adminWs of activeAdmins) {
        if (adminWs.readyState === 1) {
          adminWs.send(str);
        }
      }
    });

    ws.on('close', () => {
      const current = activeAgents.get(deviceId);
      if (current && current.ws === ws) {
        activeAgents.delete(deviceId);
      }
      console.log(`[itRelay] Agent disconnected: ${deviceId}`);
    });

    ws.on('error', (err) => {
      const current = activeAgents.get(deviceId);
      if (current && current.ws === ws) {
        activeAgents.delete(deviceId);
      }
      console.warn(`[itRelay] Agent socket error (${deviceId}):`, err.message);
    });
  }
});

function findAgent(target) {
  const direct = activeAgents.get(target);
  if (direct && direct.ws.readyState === 1) return direct;
  // Also lookup by employee number (e.g. PK018)
  for (const entry of activeAgents.values()) {
    if (
      entry.ws.readyState === 1 &&
      entry.meta.employeeNumber &&
      entry.meta.employeeNumber.toUpperCase() === String(target).toUpperCase()
    ) {
      return entry;
    }
  }
  return null;
}

async function getWorkstationsList() {
  try {
    const rows = await db.prepare(`
      SELECT d.id AS device_id, d.model, d.platform, d.last_seen_at,
             e.employee_number, e.name AS employee_name
      FROM devices d
      JOIN employees e ON e.id = d.employee_id
      WHERE d.revoked_at IS NULL AND d.platform IN ('windows', 'macos')
      ORDER BY e.employee_number ASC
    `).all();

    const now = T.now();
    return rows.map((r) => {
      const isWsConnected = activeAgents.has(r.device_id);
      const isRecent = r.last_seen_at && (now - Number(r.last_seen_at) < 180000);
      return {
        deviceId: r.device_id,
        employeeNumber: r.employee_number,
        employeeName: r.employee_name,
        platform: r.platform,
        model: r.model,
        status: isWsConnected ? 'CONNECTED' : (isRecent ? 'ONLINE (POLLING)' : 'OFFLINE'),
        lastSeenAt: r.last_seen_at,
      };
    });
  } catch (err) {
    console.error('[itRelay] Error querying workstations:', err.message);
    return [];
  }
}

function attach(server) {
  server.on('upgrade', async (req, socket, head) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== '/api/it/relay') {
        return; // Let other upgrade listeners handle (if any)
      }

      const role = url.searchParams.get('role');
      const token = url.searchParams.get('token');

      if (role === 'admin') {
        const masterKey = await getMasterKey();
        if (!masterKey || token !== masterKey) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, { role: 'admin' });
        });

      } else if (role === 'agent') {
        const deviceId = url.searchParams.get('deviceId');
        if (!deviceId || !token) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // Authenticate agent using device_token
        const tokenHash = sha256(token);
        const devRow = await db.prepare(`
          SELECT d.id AS device_id, d.platform, d.revoked_at AS device_revoked,
                 e.employee_number, e.name AS employee_name
          FROM device_tokens t
          JOIN devices d ON d.id = t.device_id
          JOIN employees e ON e.id = d.employee_id
          WHERE t.token_hash = ? AND t.device_id = ? AND t.revoked_at IS NULL
        `).get(tokenHash, deviceId);

        if (!devRow || devRow.device_revoked) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        wss.handleUpgrade(req, socket, head, (ws) => {
          wss.emit('connection', ws, req, {
            role: 'agent',
            deviceId: devRow.device_id,
            employeeNumber: devRow.employee_number,
            employeeName: devRow.employee_name,
            platform: devRow.platform,
          });
        });

      } else {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
      }
    } catch (err) {
      console.error('[itRelay] Upgrade error:', err.message);
      socket.destroy();
    }
  });

  // Periodically ping connected agents and evict half-open/sleeping sockets
  const heartbeatInterval = setInterval(() => {
    for (const [deviceId, entry] of activeAgents.entries()) {
      const ws = entry.ws;
      if (!ws || ws.readyState !== 1 || ws.isAlive === false) {
        console.log(`[itRelay] Evicting unresponsive/sleeping agent socket: ${deviceId} (${entry.meta.employeeNumber})`);
        activeAgents.delete(deviceId);
        try { ws.terminate(); } catch (_) {}
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (_) {
        activeAgents.delete(deviceId);
        try { ws.terminate(); } catch (__) {}
      }
    }
  }, 30000);
  if (typeof heartbeatInterval.unref === 'function') {
    heartbeatInterval.unref();
  }

  console.log('[itRelay] IT Workstation Relay attached to HTTP server.');
}

module.exports = {
  attach,
  getWorkstationsList,
  getMasterKey,
};
