# Wireless Mic Input

Turn your phone into a wireless microphone that types speech directly into your desktop via `xdotool`.

## Requirements

- Linux desktop with `xdotool` and `xclip` installed
- Node.js 18+
- Self-signed or Let's Encrypt TLS cert (phone browsers require HTTPS for mic access)

```bash
sudo apt install xdotool xclip
```

---

## Quick start (local network)

```bash
# 1. Generate a self-signed cert (first time only)
bash gen-cert.sh

# 2. Install dependencies
npm install

# 3. Start the server
node server.js
```

Open the URL shown in the TUI on your phone, or scan the QR code.

---

## Remote access via relay

The relay runs on a VPS and brokers the WebSocket connection so your phone can reach your desktop over the internet.

### 1. Provision a VPS

AWS Lightsail $3.50/month (512MB) is the cheapest option that works well.
Open **port 4001** in the Lightsail firewall (Networking tab).

### 2. Deploy the relay

```bash
# On your VPS (as root)
git clone <this-repo> /tmp/wmic
cd /tmp/wmic/relay
bash deploy.sh
```

`deploy.sh` installs Node, copies files to `/opt/wireless-mic-relay`, generates a self-signed cert (or uses certbot if available), and starts the systemd service.

### 3. Set a relay secret (recommended)

Edit `/etc/systemd/system/wireless-mic-relay.service` on the VPS:

```ini
Environment=RELAY_SECRET=your-strong-secret-here
```

Then reload:

```bash
systemctl daemon-reload && systemctl restart wireless-mic-relay
```

### 4. Use a real TLS cert (recommended)

```bash
apt install certbot
certbot certonly --standalone -d yourdomain.com
```

Then in the service file:

```ini
Environment=CERT_DIR=/etc/letsencrypt/live/yourdomain.com
```

### 5. Connect the desktop to the relay

In the desktop TUI press **Ctrl+E**:

| Field | Value |
|-------|-------|
| Relay WSS URL | `wss://yourdomain.com:4001` |
| Relay secret | same value as `RELAY_SECRET` on the VPS |
| TLS verify | on (Let's Encrypt) / off (self-signed) |

Press **Enter** to save. The QR code updates automatically — scan it on your phone.

---

## AI summarize

Spoken text is typed immediately, then silently replaced with an AI-improved version in the background.

Press **Ctrl+A** in the TUI:

| Field | Notes |
|-------|-------|
| Provider | `Ctrl+N` to cycle: `openai`, `anthropic`, `google` |
| API Key | your key for the selected provider |
| Model | leave blank for the default (`gpt-4o-mini` / `claude-3-5-haiku-latest` / `gemini-1.5-flash`) |
| Prompt | customise the rewrite instruction |
| Ctrl+T | toggle AI on/off |

The phone's **🤖 AI** button also toggles it on the fly.

---

## TUI keybindings

| Key | Action |
|-----|--------|
| `Ctrl+P` | Pause / resume |
| `Ctrl+R` | Add word replacement |
| `Ctrl+D` | Delete word replacement |
| `Ctrl+E` | Set relay URL + secret |
| `Ctrl+A` | Configure AI provider |
| `Ctrl+L` | Clear log |
| `Ctrl+Q` | Quit |

---

## Config reference (`config.json`)

| Key | Default | Notes |
|-----|---------|-------|
| `port` | `4000` | local HTTPS port |
| `language` | `en-US` | BCP 47 speech recognition language |
| `clipboardMode` | `false` | paste via clipboard instead of direct typing |
| `relayUrl` | `""` | `wss://` URL of relay server |
| `relaySecret` | `""` | must match `RELAY_SECRET` on relay |
| `relayRejectUnauthorized` | `true` | set `false` for self-signed relay cert |
| `aiEnabled` | `false` | enable AI rewriting |
| `aiProvider` | `openai` | `openai` \| `anthropic` \| `google` |
| `aiModel` | `""` | blank = provider default |
| `aiApiKey` | `""` | API key for the selected provider |
| `aiPrompt` | *(built-in)* | system prompt sent to the AI |
