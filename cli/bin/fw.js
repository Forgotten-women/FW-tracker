#!/usr/bin/env node

/**
 * FW Tracker - Master IT CLI Tool
 * Runs directly on your Admin Laptop to manage employee workstations.
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

// Configuration
const CONFIG_DIR = path.join(os.homedir(), '.fw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '').trim();
      return JSON.parse(raw);
    } catch (_) {}
  }
  return {
    serverUrl: process.env.FW_SERVER_URL || 'https://api.fwtracker.tech',
    relayUrl: process.env.FW_RELAY_URL || 'wss://api.fwtracker.tech/api/it/relay',
    masterKey: process.env.FW_MASTER_KEY || '',
  };
}

const config = loadConfig();

if (!config.masterKey) {
  console.error('\x1b[31m[Error] IT Master Key not configured. Please ensure ~/.fw/config.json exists.\x1b[0m');
  process.exit(1);
}

function getWebSocket(onOpen) {
  const ws = new WebSocket(`${config.relayUrl}?role=admin&token=${encodeURIComponent(config.masterKey)}`);
  ws.on('open', () => onOpen(ws));
  ws.on('error', (err) => {
    console.error(`\x1b[31m[Error] Could not connect to Relay (${config.relayUrl}): ${err.message}\x1b[0m`);
    process.exit(1);
  });
  return ws;
}

// CLI Routing
const args = process.argv.slice(2);
const command = args[0] || 'help';

switch (command) {
  case 'list':
    cmdList();
    break;
  case 'diag':
    cmdDiag(args[1]);
    break;
  case 'exec':
    cmdExec(args[1], args.slice(2).join(' '));
    break;
  case 'push':
    cmdPush(args[1], args[2], args[3]);
    break;
  case 'pull':
    cmdPull(args[1], args[2], args[3]);
    break;
  case 'connect':
    cmdConnect(args[1]);
    break;
  case 'help':
  default:
    printHelp();
    break;
}

function printHelp() {
  console.log(`
\x1b[1m\x1b[36mFW Tracker IT Workstation CLI\x1b[0m
Master Fleet Administration (User-Level Management)

\x1b[1mUSAGE:\x1b[0m
  fw <command> [target] [arguments...]

\x1b[1mCOMMANDS:\x1b[0m
  \x1b[32mlist\x1b[0m                                 List all employee workstations (Windows & macOS)
  \x1b[32mdiag\x1b[0m    <target>                     Show real-time hardware & OS health metrics
  \x1b[32mexec\x1b[0m    <target> "<cmd>"             Execute a single command on target workstation
  \x1b[32mpush\x1b[0m    <target> <local> <remote>    Upload a file to remote workstation
  \x1b[32mpull\x1b[0m    <target> <remote> <local>    Download a file from remote workstation
  \x1b[32mconnect\x1b[0m <target>                     Open an interactive live shell session (zsh/PowerShell)

\x1b[1mTARGET IDENTIFIER:\x1b[0m
  Target can be an Employee Code (e.g. \x1b[33mPK018\x1b[0m) or Device ID (e.g. \x1b[33mdev_00d6fdb50c3cb4cd\x1b[0m).

\x1b[1mEXAMPLES:\x1b[0m
  fw list
  fw diag PK018
  fw exec PK005 "whoami"
  fw push PK004 ./patch.ps1 "C:\\Users\\Kanwal\\patch.ps1"
  fw connect PK018
`);
}

function cmdList() {
  const urlObj = new URL(`${config.serverUrl}/api/it/workstations`);
  const reqModule = urlObj.protocol === 'https:' ? https : http;

  const req = reqModule.get(urlObj.toString(), {
    headers: {
      'x-it-key': config.masterKey,
    },
  }, (res) => {
    let raw = '';
    res.on('data', chunk => raw += chunk);
    res.on('end', () => {
      try {
        const data = JSON.parse(raw);
        if (data.status === 'SUCCESS') {
          console.log('\n\x1b[1m\x1b[36mREGISTERED WORKSTATIONS:\x1b[0m');
          if (!data.workstations || data.workstations.length === 0) {
            console.log('  No workstations found.\n');
          } else {
            console.table(data.workstations.map(w => ({
              'Code': w.employeeNumber,
              'Employee Name': w.employeeName,
              'Platform': w.platform,
              'Model': w.model,
              'Status': w.status,
              'Device ID': w.deviceId,
            })));
          }
        } else {
          console.error(`\x1b[31mError: ${data.message}\x1b[0m`);
        }
      } catch (err) {
        console.error('\x1b[31mFailed to parse response from server.\x1b[0m');
      }
    });
  });

  req.on('error', (err) => {
    console.error(`\x1b[31mConnection error: ${err.message}\x1b[0m`);
  });
}

function cmdDiag(target) {
  if (!target) {
    console.error('\x1b[31mError: Target required. e.g. fw diag PK018\x1b[0m');
    process.exit(1);
  }

  getWebSocket((ws) => {
    const reqId = crypto.randomBytes(4).toString('hex');
    ws.send(JSON.stringify({ action: 'forward', target, type: 'diag', reqId }));

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'diag_res' && msg.reqId === reqId) {
        console.log(`\n\x1b[1m\x1b[32m--- WORKSTATION DIAGNOSTICS [${target}] ---\x1b[0m`);
        console.log(`  \x1b[1mHostname:\x1b[0m    ${msg.hostname}`);
        console.log(`  \x1b[1mActive User:\x1b[0m ${msg.user}`);
        console.log(`  \x1b[1mOS Version:\x1b[0m  ${msg.os}`);
        console.log(`  \x1b[1mCPUs:\x1b[0m        ${msg.cpus} cores`);
        console.log(`  \x1b[1mMemory:\x1b[0m      ${msg.memory}`);
        console.log(`  \x1b[1mUptime:\x1b[0m      ${msg.uptime}`);
        console.log(`  \x1b[1mStatus:\x1b[0m      \x1b[32mONLINE\x1b[0m\n`);
        ws.close();
      } else if (msg.type === 'error' || msg.type === 'queued') {
        console.log(`\x1b[33m${msg.message}\x1b[0m`);
        ws.close();
      }
    });
  });
}

function cmdExec(target, command) {
  if (!target || !command) {
    console.error('\x1b[31mError: Target and command required. e.g. fw exec PK018 "<cmd>"\x1b[0m');
    process.exit(1);
  }

  getWebSocket((ws) => {
    const reqId = crypto.randomBytes(4).toString('hex');
    ws.send(JSON.stringify({ action: 'forward', target, type: 'exec', command, reqId }));

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'queued') {
        console.log(`\x1b[33m${msg.message}\x1b[0m`);
        ws.close();
        process.exit(0);
      }
      if (msg.reqId !== reqId) return;

      if (msg.type === 'exec_out') {
        process.stdout.write(msg.data);
      } else if (msg.type === 'exec_err') {
        process.stderr.write(msg.data);
      } else if (msg.type === 'exec_done') {
        ws.close();
        process.exit(msg.code || 0);
      } else if (msg.type === 'error') {
        console.error(`\x1b[31m${msg.message}\x1b[0m`);
        ws.close();
        process.exit(1);
      }
    });
  });
}

function cmdPush(target, localPath, remotePath) {
  if (!target || !localPath || !remotePath) {
    console.error('\x1b[31mError: Target, local file and remote destination required.\x1b[0m');
    process.exit(1);
  }

  if (!fs.existsSync(localPath)) {
    console.error(`\x1b[31mLocal file not found: ${localPath}\x1b[0m`);
    process.exit(1);
  }

  const content = fs.readFileSync(localPath).toString('base64');
  getWebSocket((ws) => {
    const reqId = crypto.randomBytes(4).toString('hex');
    ws.send(JSON.stringify({ action: 'forward', target, type: 'push', destPath: remotePath, content, reqId }));

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.reqId !== reqId) return;

      if (msg.type === 'push_res') {
        if (msg.success) {
          console.log(`\x1b[32m✓ File successfully pushed to ${msg.path} (${msg.size} bytes)\x1b[0m`);
        } else {
          console.error(`\x1b[31mFailed to push file: ${msg.error}\x1b[0m`);
        }
        ws.close();
      }
    });
  });
}

function cmdPull(target, remotePath, localDest) {
  if (!target || !remotePath || !localDest) {
    console.error('\x1b[31mError: Target, remote source and local destination required.\x1b[0m');
    process.exit(1);
  }

  getWebSocket((ws) => {
    const reqId = crypto.randomBytes(4).toString('hex');
    ws.send(JSON.stringify({ action: 'forward', target, type: 'pull', srcPath: remotePath, reqId }));

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.reqId !== reqId) return;

      if (msg.type === 'pull_res') {
        if (msg.success) {
          const destFile = fs.existsSync(localDest) && fs.statSync(localDest).isDirectory()
            ? path.join(localDest, path.basename(remotePath))
            : localDest;
          fs.writeFileSync(destFile, Buffer.from(msg.content, 'base64'));
          console.log(`\x1b[32m✓ File successfully downloaded to ${destFile}\x1b[0m`);
        } else {
          console.error(`\x1b[31mFailed to pull file: ${msg.error}\x1b[0m`);
        }
        ws.close();
      }
    });
  });
}

function cmdConnect(target) {
  if (!target) {
    console.error('\x1b[31mError: Target required. e.g. fw connect PK018\x1b[0m');
    process.exit(1);
  }

  console.log(`\x1b[33mConnecting to interactive shell on ${target}...\x1b[0m`);
  console.log(`\x1b[90m(Type 'exit' to terminate the remote session)\x1b[0m\n`);

  getWebSocket((ws) => {
    ws.send(JSON.stringify({ action: 'forward', target, type: 'shell_start' }));

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    process.stdin.on('data', (chunk) => {
      ws.send(JSON.stringify({ action: 'forward', target, type: 'shell_input', data: chunk.toString() }));
    });

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'shell_output') {
        process.stdout.write(msg.data);
      } else if (msg.type === 'shell_closed') {
        cleanup();
        console.log(`\n\x1b[33mRemote shell closed (exit code ${msg.code}).\x1b[0m`);
        process.exit(0);
      } else if (msg.type === 'error' || msg.type === 'queued') {
        cleanup();
        console.error(`\x1b[31m${msg.message}\x1b[0m`);
        process.exit(1);
      }
    });

    function cleanup() {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    }

    ws.on('close', () => {
      cleanup();
    });
  });
}
