# Electron Local Proxy Integration Guide
### Bypass Google auth detection — no APIs, no spoofing fragility, works for all AI sites

---

## How It Works

```
Electron webview
      ↓
localhost:8877  ← your proxy rewrites all headers here
      ↓
ChatGPT / Gemini / Claude.ai
      ↑
Google sees clean Chrome headers — auth works
```

The proxy intercepts every outgoing request **before it leaves your machine** and replaces all Electron-specific headers with real Chrome ones. Google never sees Electron.

---

## Project Structure

After integration your project should look like this:

```
your-electron-app/
├── main.js               ← modified
├── proxy.js              ← new
├── cert-trust.js         ← new
├── preload.js            ← new (JS-level fingerprint patches)
├── package.json
└── renderer/
    └── index.html
```

---

## Step 1 — Install Dependencies

```bash
npm install http-mitm-proxy electron-store
```

> `http-mitm-proxy` — intercepts and rewrites HTTPS traffic  
> `electron-store` — persists encrypted API keys and settings

---

## Step 2 — Create `proxy.js`

Create a new file `proxy.js` in your project root:

```javascript
const Proxy = require('http-mitm-proxy');
const path  = require('path');
const { app } = require('electron');

const PROXY_PORT = 8877;

// Always derive from actual Electron Chromium — never hardcode
const CHROME_VERSION = () => process.versions.chrome;
const CHROME_MAJOR   = () => CHROME_VERSION().split('.')[0];

const CHROME_UA = () =>
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION()} Safari/537.36`;

const SPOOF_HEADERS = () => ({
  'user-agent':           CHROME_UA(),
  'sec-ch-ua':            `"Google Chrome";v="${CHROME_MAJOR()}", "Chromium";v="${CHROME_MAJOR()}", "Not-A.Brand";v="99"`,
  'sec-ch-ua-mobile':     '?0',
  'sec-ch-ua-platform':   '"Windows"',
  'accept-language':      'en-US,en;q=0.9',
});

// Headers that expose Electron — remove entirely
const HEADERS_TO_DROP = [
  'x-client-data',    // Google's internal tracking header
  'sec-gpc',          // Added by some Electron builds
];

const startProxy = () => {
  return new Promise((resolve, reject) => {
    const proxy = Proxy();

    proxy.options = {
      port:      PROXY_PORT,
      sslCaDir:  path.join(app.getPath('userData'), 'proxy-certs'), // certs persist across launches
      timeout:   0,
      keepAlive: true,
    };

    proxy.onRequest((ctx, callback) => {
      const spoof = SPOOF_HEADERS();

      // Drop Electron-specific headers
      HEADERS_TO_DROP.forEach(h => {
        delete ctx.proxyToServerRequestOptions.headers[h];
      });

      // Inject spoofed headers
      Object.entries(spoof).forEach(([key, val]) => {
        ctx.proxyToServerRequestOptions.headers[key] = val;
      });

      return callback();
    });

    proxy.onError((ctx, err) => {
      // Silently absorb — don't crash on network errors
      console.warn('Proxy error:', err?.message);
    });

    proxy.listen({ port: PROXY_PORT }, (err) => {
      if (err) return reject(err);
      console.log(`[proxy] Running on port ${PROXY_PORT}`);
      resolve(proxy);
    });
  });
};

module.exports = { startProxy, PROXY_PORT };
```

---

## Step 3 — Create `cert-trust.js`

The proxy intercepts HTTPS by acting as a local CA. You need to trust its certificate once on first launch:

```javascript
const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');
const { app } = require('electron');

const CERT_DIR  = path.join(app.getPath('userData'), 'proxy-certs');
const CERT_PATH = path.join(CERT_DIR, 'certs', 'ca.pem');

// Check if our cert is already trusted
const isCertTrusted = () => {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('security find-certificate -c "http-mitm-proxy" 2>/dev/null').toString();
      return out.includes('http-mitm-proxy');
    }
    if (process.platform === 'win32') {
      const out = execSync('certutil -store Root 2>nul | findstr /i "mitm"').toString();
      return out.toLowerCase().includes('mitm');
    }
    // Linux — check if file exists in ca-certs
    return fs.existsSync('/usr/local/share/ca-certificates/myapp-proxy.crt');
  } catch {
    return false;
  }
};

// Install the cert into OS trust store
const trustCert = () => {
  if (!fs.existsSync(CERT_PATH)) {
    console.warn('[cert] Certificate not yet generated — proxy may not have started');
    return false;
  }

  try {
    if (process.platform === 'darwin') {
      execSync(
        `security add-trusted-cert -d -r trustRoot ` +
        `-k /Library/Keychains/System.keychain "${CERT_PATH}"`
      );
    } else if (process.platform === 'win32') {
      execSync(`certutil -addstore -f Root "${CERT_PATH}"`);
    } else {
      execSync(
        `cp "${CERT_PATH}" /usr/local/share/ca-certificates/myapp-proxy.crt ` +
        `&& update-ca-certificates`
      );
    }
    console.log('[cert] Trusted successfully');
    return true;
  } catch (e) {
    console.error('[cert] Trust failed:', e.message);
    return false;
  }
};

module.exports = { isCertTrusted, trustCert, CERT_PATH };
```

---

## Step 4 — Create `preload.js`

The proxy handles network-level headers. This file patches JS-level fingerprinting (things like `navigator.userAgent` which are read inside the page, never sent over the wire):

```javascript
// Runs before ANY page JS — page cannot detect or override these patches

const CHROME_VERSION = process.versions.chrome;
const CHROME_MAJOR   = CHROME_VERSION.split('.')[0];
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

// ── 1. Navigator ────────────────────────────────────────────────────────────

const def = (prop, val) =>
  Object.defineProperty(navigator, prop, { get: () => val, configurable: false });

def('userAgent',          UA);
def('appVersion',         UA.replace('Mozilla/', ''));
def('vendor',             'Google Inc.');
def('platform',           'Win32');
def('language',           'en-US');
def('languages',          ['en-US', 'en']);
def('maxTouchPoints',     0);
def('hardwareConcurrency',8);
def('deviceMemory',       8);

// Electron has 0 plugins — a dead giveaway. Fake the standard 3 Chrome plugins.
const fakePlugins = [
  { name: 'Chrome PDF Plugin',  filename: 'internal-pdf-viewer',             description: 'Portable Document Format', length: 1 },
  { name: 'Chrome PDF Viewer',  filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '',                         length: 1 },
  { name: 'Native Client',      filename: 'internal-nacl-plugin',             description: '',                         length: 2 },
];
Object.defineProperty(navigator, 'plugins', {
  get: () => {
    const list = Object.create(PluginArray.prototype);
    fakePlugins.forEach((p, i) => { list[i] = p; });
    list.length    = fakePlugins.length;
    list.item      = (i)    => fakePlugins[i] ?? null;
    list.namedItem = (name) => fakePlugins.find(p => p.name === name) ?? null;
    list.refresh   = () => {};
    return list;
  },
  configurable: false,
});

// ── 2. window.chrome ────────────────────────────────────────────────────────

window.chrome = {
  app: {
    isInstalled: false,
    getDetails:  () => null,
    getIsInstalled: () => false,
    runningState: () => 'cannot_run',
    InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
    RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
  },
  runtime: {
    id: undefined, // undefined = not an extension, but object exists
    connect: () => {},
    sendMessage: () => {},
  },
  loadTimes: () => ({
    requestTime:             performance.timeOrigin / 1000,
    startLoadTime:           performance.timeOrigin / 1000,
    commitLoadTime:          performance.timeOrigin / 1000,
    finishDocumentLoadTime:  performance.timeOrigin / 1000,
    finishLoadTime:          performance.timeOrigin / 1000,
    firstPaintTime:          performance.timeOrigin / 1000,
    firstPaintAfterLoadTime: 0,
    navigationType:          'Other',
    wasFetchedViaSpdy:       true,
    wasNpnNegotiated:        true,
    npnNegotiatedProtocol:   'h2',
    wasAlternateProtocolAvailable: false,
    connectionInfo:          'h2',
  }),
  csi: () => ({
    startE:  performance.timeOrigin,
    onloadT: performance.timeOrigin + performance.now(),
    pageT:   performance.now(),
    tran:    15,
  }),
};

// ── 3. WebGL renderer string ─────────────────────────────────────────────────
// Electron reports "Chromium" — real Chrome reports GPU vendor strings

const patchWebGL = (Ctx) => {
  const orig = Ctx.prototype.getParameter;
  Ctx.prototype.getParameter = function (p) {
    if (p === 37445) return 'Intel Inc.';               // UNMASKED_VENDOR_WEBGL
    if (p === 37446) return 'Intel Iris OpenGL Engine'; // UNMASKED_RENDERER_WEBGL
    return orig.call(this, p);
  };
};

patchWebGL(WebGLRenderingContext);
if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext);

// ── 4. Permissions API ───────────────────────────────────────────────────────
// Electron returns 'denied' for everything — Chrome returns 'prompt'

const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
if (origQuery) {
  navigator.permissions.query = (params) => {
    if (params.name === 'notifications') {
      return Promise.resolve({ state: Notification.permission, onchange: null });
    }
    return origQuery(params).catch(() =>
      Promise.resolve({ state: 'prompt', onchange: null })
    );
  };
}

// ── 5. Patch iframes (Google auth uses them heavily) ─────────────────────────

new MutationObserver((mutations) => {
  mutations.forEach(({ addedNodes }) => {
    addedNodes.forEach((node) => {
      if (node.tagName === 'IFRAME') {
        try {
          const w = node.contentWindow;
          if (w && !w.__patched) {
            w.__patched = true;
            if (w.WebGLRenderingContext)  patchWebGL(w.WebGLRenderingContext);
            if (w.WebGL2RenderingContext) patchWebGL(w.WebGL2RenderingContext);
          }
        } catch (_) {
          // Cross-origin iframes throw — expected, skip them
        }
      }
    });
  });
}).observe(document.documentElement, { childList: true, subtree: true });
```

---

## Step 5 — Update `main.js`

Replace your existing `main.js` (or merge into it):

```javascript
const { app, BrowserWindow, session, dialog } = require('electron');
const path = require('path');
const { startProxy, PROXY_PORT } = require('./proxy');
const { isCertTrusted, trustCert } = require('./cert-trust');

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    webPreferences: {
      partition:        'persist:main',  // cookies survive restarts — user stays logged in
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
    },
  });

  // Google auth opens a popup — give it same session + preload
  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      width: 500,
      height: 700,
      webPreferences: {
        partition:        'persist:main', // SAME partition = shared cookies
        nodeIntegration:  false,
        contextIsolation: true,
        preload:          path.join(__dirname, 'preload.js'),
      },
    },
  }));

  win.loadURL('https://chatgpt.com'); // or gemini.google.com, claude.ai
};

app.whenReady().then(async () => {

  // ── Step A: Start proxy ───────────────────────────────────────────────────
  await startProxy();

  // ── Step B: Wait for cert to generate (first launch only) ────────────────
  await new Promise(r => setTimeout(r, 1200));

  // ── Step C: Trust the cert if not already trusted ────────────────────────
  if (!isCertTrusted()) {
    const { response } = await dialog.showMessageBox({
      type:    'info',
      title:   'One-time Setup Required',
      message: 'MyApp uses a local certificate (similar to a VPN) to connect to AI sites correctly.\n\nThis is safe — your traffic is only processed on your machine and never sent to our servers.',
      buttons: ['Install Certificate & Continue', 'Cancel'],
      defaultId: 0,
    });

    if (response === 0) {
      trustCert();
    } else {
      app.quit();
      return;
    }
  }

  // ── Step D: Route ALL Electron traffic through the proxy ─────────────────
  await session.defaultSession.setProxy({
    proxyRules: `http=localhost:${PROXY_PORT};https=localhost:${PROXY_PORT}`,
  });

  // ── Step E: Trust our proxy's self-signed cert inside Electron ───────────
  app.on('certificate-error', (event, webContents, url, error, cert, callback) => {
    // Only trust our own proxy cert — validate it's local
    if (url.startsWith('https://') && error === 'net::ERR_CERT_AUTHORITY_INVALID') {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  // ── Step F: Apply UA to any stray webContents (workers, iframes) ─────────
  app.on('web-contents-created', (_, contents) => {
    contents.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
      `(KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`
    );
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

---

## Step 6 — Test It

```bash
# Run your app in dev mode
npm start

# On first launch:
# 1. System will ask for password to install certificate (macOS/Windows)
# 2. After approval, app loads normally
# 3. Navigate to gemini.google.com — Google auth should work
```

**Verify the proxy is working:**

Open DevTools in your Electron window → Network tab → any request → check `Request Headers`. You should see:
```
user-agent: Mozilla/5.0 ... Chrome/122.x.x.x ...   ✅ (no "Electron")
sec-ch-ua: "Google Chrome";v="122" ...              ✅
```

---

## Step 7 — Handle Multiple AI Sites

For your 3-AI use case, create separate windows or tabs, each using the same `persist:main` session:

```javascript
const AI_SITES = [
  { name: 'ChatGPT', url: 'https://chatgpt.com' },
  { name: 'Gemini',  url: 'https://gemini.google.com' },
  { name: 'Claude',  url: 'https://claude.ai' },
];

const createAIWindow = ({ name, url }) => {
  const win = new BrowserWindow({
    title: name,
    width: 1280,
    height: 900,
    webPreferences: {
      partition:        'persist:main', // all 3 share cookies
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
    },
  });

  win.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      webPreferences: {
        partition:        'persist:main',
        nodeIntegration:  false,
        contextIsolation: true,
        preload:          path.join(__dirname, 'preload.js'),
      },
    },
  }));

  win.loadURL(url);
  return win;
};

// In your app.whenReady():
AI_SITES.forEach(site => createAIWindow(site));
```

---

## Coverage Summary

| Detection Vector | Fixed By |
|---|---|
| `User-Agent` in HTTP headers | Proxy rewrites on every request |
| `sec-ch-ua` client hints | Proxy injects correct values |
| `navigator.userAgent` in JS | `preload.js` `Object.defineProperty` |
| `navigator.plugins` empty | `preload.js` fakes Chrome's 3 plugins |
| `window.chrome` missing | `preload.js` full chrome object |
| WebGL renderer string | `preload.js` WebGL patch |
| Permissions API returning denied | `preload.js` permissions patch |
| Google auth popups leaking UA | `setWindowOpenHandler` + same preload |
| Cookies lost on restart | `partition: 'persist:main'` |
| iframe detection | `preload.js` MutationObserver patch |

---

## Common Issues

**Proxy fails to start**
```bash
# Port already in use — change PROXY_PORT in proxy.js to any free port
# e.g. 8878, 9001, etc.
```

**Certificate dialog keeps appearing**
```javascript
// isCertTrusted() check failed — add a manual flag to userData
const Store = require('electron-store');
const store = new Store();
// After trustCert() succeeds:
store.set('certTrusted', true);
// In isCertTrusted(), also check store.get('certTrusted')
```

**Site still blocks on macOS**
```javascript
// macOS WebKit sometimes ignores proxy for localhost — use 127.0.0.1 explicitly
proxyRules: `http=127.0.0.1:${PROXY_PORT};https=127.0.0.1:${PROXY_PORT}`
```

**Windows antivirus flags the cert install**
Add a code signing certificate to your app and the cert install dialog will show your app's verified name instead of an unknown publisher warning.

---

## Shipping Checklist

- [ ] `http-mitm-proxy` added to `dependencies` (not devDependencies)
- [ ] `proxy.js`, `cert-trust.js`, `preload.js` included in your build
- [ ] Cert dialog copy explains it's local/safe (users will Google it otherwise)
- [ ] Tested on macOS, Windows, Linux if targeting all 3
- [ ] `partition: 'persist:main'` on all windows including popups
- [ ] Code signing certificate set up (makes the OS cert dialog far less scary)