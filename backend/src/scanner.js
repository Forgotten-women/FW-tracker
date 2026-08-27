const { exec } = require('child_process');
const { processDeviceSeen, normalizeIp, db } = require('./store');

let isScanning = false;

// Scans local ARP table and subnet broadcast for 100% passive, zero-touch Wi-Fi presence detection
function scanLocalNetwork() {
  if (isScanning) return;
  isScanning = true;

  // Run arp -a on Windows to inspect active Layer-2 Wi-Fi devices
  exec('arp -a', (err, stdout, stderr) => {
    isScanning = false;
    if (err || !stdout) return;

    const lines = stdout.split('\n');
    const detectedDevices = [];

    lines.forEach(line => {
      // Match IPv4 addresses and MACs on subnet 192.168.18.X
      const match = line.trim().match(/^(192\.168\.18\.\d+)\s+([0-9a-fA-F\-]{17})\s+(\w+)/);
      if (match) {
        const ip = match[1].trim();
        const mac = match[2].trim().toLowerCase().replace(/-/g, ':');
        const type = match[3].toLowerCase();

        // Only dynamic entries (real connected devices)
        if (type === 'dynamic' && ip !== '192.168.18.1' && ip !== '192.168.18.68' && ip !== '192.168.18.81' && ip !== '192.168.18.255') {
          detectedDevices.push({ ip, mac });
        }
      }
    });

    // Process all detected active phones/devices into presence engine
    detectedDevices.forEach(device => {
      processDeviceSeen(device.ip, device.mac, 'PASSIVE_WIFI_SCANNER');
    });
  });
}

// Kick off passive ARP sweep every 15 seconds
function startPassiveScanner() {
  console.log('[Passive Scanner] 📡 24/7 Passive Wi-Fi ARP & Hardware Scanner Active');
  scanLocalNetwork();
  setInterval(scanLocalNetwork, 15000);
}

module.exports = {
  startPassiveScanner,
  scanLocalNetwork
};