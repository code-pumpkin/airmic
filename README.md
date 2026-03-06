# VoiceBridge

Turn your phone into a wireless microphone that types speech directly into your Linux desktop. Your phone handles speech recognition, and the text is typed into whatever window is focused — no drivers, no Bluetooth, no pairing headaches.

```
Phone (browser) → WebSocket → Desktop (xdotool types into focused window)
```

## How it works

1. Start VoiceBridge on your desktop — a TUI appears with a QR code
2. Scan the QR code with your phone's camera
3. Tap the mic button and start talking
4. Text appears in your focused desktop window in real-time

Works over your local WiFi network, or over the internet via a relay server.

## Requirements

- Linux desktop with X11 (Wayland not supported — xdotool requirement)
- Node.js 18+
- `xdotool` and `xclip`

```bash
sudo apt install xdotool xclip
```

## Quick start

```bash
# Clone the repo
git clone https://github.com/code-pumpkin/voicebridge.git
cd voicebridge

# Install dependencies
npm install

# Generate a self-signed TLS cert (required — browsers need HTTPS for mic access)
bash gen-cert.sh

# Start VoiceBridge
node server.js
```

A TUI launches with a QR code. Scan it with your phone, accept the self-signed cert warning once, and you're live.

### Headless mode

Run without the TUI (useful for scripts or SSH sessions):

```bash
node server.js --headless
```

## Phone UI

The phone gets a clean, mobile-optimized web app with:

- Large mic button — tap to start/stop, or use push-to-talk (Hold) mode
- Live transcript display with interim results
- Pause, Clipboard, AI, and Hold toggle buttons
- Language selector (13 languages)
- History of sent phrases with resend

No app install needed — it's just a web page served over HTTPS.

## Connection modes

### Local network (same WiFi)

The default. Your phone connects directly to your desktop over your local network. Lowest latency, no internet required.

### Relay server (internet)

For when your phone isn't on the same network as your desktop (mobile data, different WiFi, etc.). A relay server on a VPS brokers the WebSocket connection.

VoiceBridge Cloud is included as a default relay. To use it, press `Ctrl+K` → Relay Servers → select VoiceBridge Cloud.

The phone will automatically try a direct local connection first and fall back to the relay if your desktop isn't reachable locally.

## TUI keyboard shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` | Command palette (access all actions) |
| `Ctrl+P` | Pause / resume |
| `Ctrl+E` | Relay server manager |
| `Ctrl+A` | AI settings |
| `Ctrl+R` | Add word replacement |
| `Ctrl+D` | Delete word replacement |
| `Ctrl+L` | Clear log |
| `Ctrl+Q` | Quit |

## AI summarize

Spoken text is typed immediately, then silently replaced with an AI-cleaned version in the background. Useful for turning rambling speech into clean prose.

Supports OpenAI, Anthropic, and Google AI.

### Setup

1. Add your API key to `.env`:

```bash
cp .env.example .env
# Edit .env and add your key:
# VOICEBRIDGE_AI_KEY=sk-your-key-here
```

Or configure interactively: `Ctrl+A` in the TUI.

2. Toggle AI on/off from the TUI (`Ctrl+A` → `Ctrl+T`) or from the phone's AI button.

| Provider | Default model |
|----------|--------------|
| OpenAI | gpt-4o-mini |
| Anthropic | claude-3-5-haiku-latest |
| Google | gemini-1.5-flash |

You can override the model and system prompt in AI settings.

## Word replacements

Auto-replace words or phrases as they're typed. Useful for fixing consistent misrecognitions or expanding abbreviations.

- `Ctrl+R` to add a replacement (e.g., "gonna" → "going to")
- `Ctrl+D` to remove one

Replacements are saved to `config.json` and apply to all future transcriptions.

## Self-hosting a relay server

### 1. Provision a VPS

Any VPS with Node.js 18+ works. AWS Lightsail $3.50/month (512MB) is plenty. Open port 4001 in the firewall.

### 2. Deploy

```bash
# On your VPS (as root)
git clone <this-repo> /tmp/wmic
cd /tmp/wmic/relay
bash deploy.sh
```

`deploy.sh` installs Node, copies files to `/opt/wireless-mic-relay`, generates a self-signed cert, and starts a systemd service.

### 3. Set a relay secret (recommended)

Edit `/etc/systemd/system/wireless-mic-relay.service`:

```ini
Environment=RELAY_SECRET=your-strong-secret-here
```

```bash
systemctl daemon-reload && systemctl restart wireless-mic-relay
```

### 4. Use a real TLS cert (recommended)

```bash
apt install certbot
certbot certonly --standalone -d yourdomain.com
```

In the service file:

```ini
Environment=CERT_DIR=/etc/letsencrypt/live/yourdomain.com
```

### 5. Connect your desktop

Press `Ctrl+K` → Relay Servers → Add custom server. Enter your relay URL (`wss://yourdomain.com:4001`) and secret.

## Config reference

Config is stored in `config.json` (auto-generated on first run).

| Key | Default | Description |
|-----|---------|-------------|
| `port` | `4000` | Local HTTPS port |
| `language` | `en-US` | Speech recognition language (BCP 47) |
| `clipboardMode` | `false` | Paste via clipboard instead of xdotool typing |
| `wordReplacements` | `{}` | Auto-replace map (e.g., `{"gonna": "going to"}`) |
| `relayUrl` | `""` | Active relay server URL |
| `relaySecret` | `""` | Must match `RELAY_SECRET` on the relay |
| `relayServers` | `[...]` | Saved relay server list |
| `aiEnabled` | `false` | Enable AI text cleanup |
| `aiProvider` | `openai` | `openai`, `anthropic`, or `google` |
| `aiModel` | `""` | Blank = provider default |
| `aiPrompt` | *(built-in)* | System prompt for AI rewriting |

API keys are stored in `.env` (not config.json). See `.env.example`.

## Environment variables

| Variable | Description |
|----------|-------------|
| `VOICEBRIDGE_AI_KEY` | AI provider API key |

Set these in `.env` or export them in your shell.

## Security

- All connections are TLS-encrypted (HTTPS + WSS)
- Phone access requires a random URL token (shared via QR code)
- New devices must be approved via 6-digit PIN confirmation on the desktop
- Returning devices are remembered via cryptographic device tokens
- Per-socket message rate limiting (30 msg/sec)
- HTTP rate limiting (60 req/min per IP)
- Security headers: HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy
- Control characters stripped before typing
- API keys stored in `.env`, not in config
- Sessions auto-expire after 90 days

## Project structure

```
├── server.js              # Desktop app — TUI, WebSocket server, xdotool integration
├── public/
│   └── index.html         # Phone web UI (single self-contained file)
├── relay/
│   ├── relay.js           # Relay server for internet access
│   ├── deploy.sh          # VPS deployment script
│   ├── wireless-mic-relay.service  # systemd service file
│   └── public/
│       └── index.html     # Phone UI copy served by relay
├── gen-cert.sh            # Self-signed cert generator
├── config.example.json    # Example configuration
├── .env.example           # Example environment variables
└── package.json
```

## Troubleshooting

**Phone can't connect / cert error**
Accept the self-signed certificate warning in your phone's browser. On some phones you need to visit the HTTPS URL directly first, accept the warning, then reload.

**"Speech recognition not supported"**
Use Chrome or Safari. Firefox doesn't support the Web Speech API.

**Text not appearing on desktop**
Make sure `xdotool` is installed and you're running X11 (not Wayland). Check that the target window is focused.

**Android "pyramid" effect (repeated text)**
This is handled automatically — VoiceBridge uses single-shot recognition mode on Android with auto-restart.

**Relay connection fails**
Check that port 4001 is open on the VPS, the relay secret matches, and the service is running (`systemctl status wireless-mic-relay`).

## License

MIT
