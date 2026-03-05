// ─────────────────────────────────────────────────────────────────────────────
// AI Webview spoofing — replaces Electron fingerprints with real Chrome ones
// so Google auth (and other bot detection) works inside AI webviews.
//
// Two layers:
//   1. Session-level header rewriting  (network level — same as ai-spoof proxy)
//   2. Webview preload JS              (JS level — patches navigator, plugins, etc.)
// ─────────────────────────────────────────────────────────────────────────────

import { app, session, BrowserWindow } from 'electron';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

// ── Chrome identity derived from Electron's actual Chromium build ────────────

const CHROME_VERSION = process.versions.chrome;
const CHROME_MAJOR = CHROME_VERSION.split('.')[0];

const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;

const SPOOF_HEADERS: Record<string, string> = {
  'sec-ch-ua': `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not-A.Brand";v="99"`,
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'accept-language': 'en-US,en;q=0.9',
};

// Headers that expose Electron — remove entirely
const HEADERS_TO_DROP = ['x-client-data', 'sec-gpc'];

// Persistent partitions so cookies survive across restarts
export const AI_PARTITIONS = ['persist:chatgpt', 'persist:claude', 'persist:gemini'];

// ── 1. Session-level header spoofing ─────────────────────────────────────────

export function setupAISessions(): void {
  for (const partition of AI_PARTITIONS) {
    const ses = session.fromPartition(partition);

    // Set user-agent (affects both HTTP header AND navigator.userAgent)
    ses.setUserAgent(CHROME_UA);

    // Rewrite outgoing request headers
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };

      for (const h of HEADERS_TO_DROP) {
        delete headers[h];
      }
      for (const [key, val] of Object.entries(SPOOF_HEADERS)) {
        headers[key] = val;
      }
      headers['user-agent'] = CHROME_UA;

      // NOTE: Do NOT override Sec-Fetch-* headers here.
      // Electron's Chromium already sets these correctly natively.
      // Custom overrides can produce wrong values and trigger detection.

      callback({ requestHeaders: headers });
    });

    // Strip X-Frame-Options from responses (some sites set it)
    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['x-frame-options'];
      delete headers['X-Frame-Options'];
      callback({ responseHeaders: headers });
    });
  }

  // ── Handle ALL web-contents: webviews + popups opened from them ──────────
  app.on('web-contents-created', (_, contents) => {
    // Apply spoofed UA to webviews
    if (contents.getType() === 'webview') {
      contents.setUserAgent(CHROME_UA);

      // ── Intercept in-page Google auth navigation ─────────────────────────
      // Gemini navigates to accounts.google.com in-page. Google's server-side
      // detection still blocks it.  We intercept and open auth in a popup
      // BrowserWindow (like Claude does) which works reliably.
      contents.on('will-navigate', (event, url) => {
        if (url.includes('accounts.google.com')) {
          event.preventDefault();

          const partition = getPartitionForContents(contents) || 'persist:gemini';

          const authWin = new BrowserWindow({
            width: 500,
            height: 700,
            webPreferences: {
              partition,
              nodeIntegration: false,
              contextIsolation: false,
              preload: getPreloadFilePath(),
            },
          });

          authWin.webContents.setUserAgent(CHROME_UA);
          authWin.loadURL(url);

          // Auto-close the popup when auth redirects back to an AI site
          authWin.webContents.on('will-navigate', (_ev, navUrl) => {
            const isBack =
              navUrl.includes('gemini.google.com') ||
              navUrl.includes('chatgpt.com') ||
              navUrl.includes('claude.ai');
            if (isBack) {
              // Auth done — reload the webview so it picks up the new cookies
              authWin.close();
              contents.reload();
            }
          });
        }
      });
    }

    // Intercept popups from webviews / windows (Google auth opens via window.open)
    contents.setWindowOpenHandler(({ url }) => {
      // Determine which partition this contents belongs to
      const partition = getPartitionForContents(contents);

      if (partition) {
        // This is from an AI webview — allow popup with same spoofed session
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 500,
            height: 700,
            webPreferences: {
              partition,
              nodeIntegration: false,
              contextIsolation: false, // Must be OFF so preload patches work in page context
              preload: getPreloadFilePath(),
            },
          },
        };
      }

      // Non-AI contents — use default behavior
      return { action: 'allow' };
    });

    // When the popup window is actually created, apply UA to it too
    contents.on('did-create-window', (window) => {
      window.webContents.setUserAgent(CHROME_UA);
    });
  });
}

/** Try to determine which AI partition a web-contents belongs to. */
function getPartitionForContents(contents: Electron.WebContents): string | null {
  // Walk up: if this contents IS a webview, check its session
  // If it's a window opened FROM a webview, check the opener
  for (const partition of AI_PARTITIONS) {
    const ses = session.fromPartition(partition);
    if (contents.session === ses) {
      return partition;
    }
  }

  // Check if the opener is in an AI session
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opener = (contents as unknown as { opener?: Electron.WebContents }).opener;
    if (opener) {
      for (const partition of AI_PARTITIONS) {
        if (opener.session === session.fromPartition(partition)) {
          return partition;
        }
      }
    }
  } catch { /* no opener */ }

  // Fallback: check by URL
  try {
    const url = contents.getURL();
    if (url.includes('chatgpt.com') || url.includes('openai.com')) return 'persist:chatgpt';
    if (url.includes('gemini.google.com') || url.includes('accounts.google.com')) return 'persist:gemini';
    if (url.includes('claude.ai') || url.includes('anthropic.com')) return 'persist:claude';
  } catch { /* no URL yet */ }

  return null;
}


// ── 2. Webview preload (JS-level fingerprint patches) ────────────────────────

function getPreloadContent(): string {
  // The template uses the real Chrome version from the running Electron binary.
  // Runs before ANY page JS because webview contextIsolation is off by default.
  return `// Auto-generated AI webview preload — do not edit manually
(function () {
  const CHROME_VERSION = '${CHROME_VERSION}';
  const CHROME_MAJOR = CHROME_VERSION.split('.')[0];
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/' + CHROME_VERSION + ' Safari/537.36';

  // ── Navigator patches ───────────────────────────────────────────────────
  const def = (prop, val) =>
    Object.defineProperty(navigator, prop, { get: () => val, configurable: false });

  def('userAgent', UA);
  def('appVersion', UA.replace('Mozilla/', ''));
  def('vendor', 'Google Inc.');
  def('platform', 'Win32');
  def('language', 'en-US');
  def('languages', ['en-US', 'en']);
  def('maxTouchPoints', 0);
  def('hardwareConcurrency', 8);
  def('deviceMemory', 8);

  // ── navigator.webdriver — TOP-TIER bot detection flag ───────────────────
  // Electron / Chromium sets this to true. Google checks it immediately.
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: false,
  });

  // ── navigator.connection — real Chrome has NetworkInformation ───────────
  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
        onchange: null,
      }),
      configurable: false,
    });
  }

  // Electron has 0 plugins — fake the standard 3 Chrome plugins
  const fakePlugins = [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1 },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2 },
  ];
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const list = Object.create(PluginArray.prototype);
      fakePlugins.forEach((p, i) => { list[i] = p; });
      list.length = fakePlugins.length;
      list.item = (i) => fakePlugins[i] || null;
      list.namedItem = (name) => fakePlugins.find(p => p.name === name) || null;
      list.refresh = () => {};
      return list;
    },
    configurable: false,
  });

  // ── window.chrome ───────────────────────────────────────────────────────
  window.chrome = {
    app: {
      isInstalled: false,
      getDetails: () => null,
      getIsInstalled: () => false,
      runningState: () => 'cannot_run',
      InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
      RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
    },
    runtime: {
      id: undefined,
      connect: () => {},
      sendMessage: () => {},
    },
    loadTimes: () => ({
      requestTime: performance.timeOrigin / 1000,
      startLoadTime: performance.timeOrigin / 1000,
      commitLoadTime: performance.timeOrigin / 1000,
      finishDocumentLoadTime: performance.timeOrigin / 1000,
      finishLoadTime: performance.timeOrigin / 1000,
      firstPaintTime: performance.timeOrigin / 1000,
      firstPaintAfterLoadTime: 0,
      navigationType: 'Other',
      wasFetchedViaSpdy: true,
      wasNpnNegotiated: true,
      npnNegotiatedProtocol: 'h2',
      wasAlternateProtocolAvailable: false,
      connectionInfo: 'h2',
    }),
    csi: () => ({
      startE: performance.timeOrigin,
      onloadT: performance.timeOrigin + performance.now(),
      pageT: performance.now(),
      tran: 15,
    }),
  };

  // ── WebGL renderer string ───────────────────────────────────────────────
  const patchWebGL = (Ctx) => {
    const orig = Ctx.prototype.getParameter;
    Ctx.prototype.getParameter = function (p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return orig.call(this, p);
    };
  };
  patchWebGL(WebGLRenderingContext);
  if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext);

  // ── Permissions API ─────────────────────────────────────────────────────
  const origQuery =
    navigator.permissions &&
    navigator.permissions.query &&
    navigator.permissions.query.bind(navigator.permissions);
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

  // ── Patch iframes (Google auth uses them) ───────────────────────────────
  new MutationObserver((mutations) => {
    mutations.forEach(({ addedNodes }) => {
      addedNodes.forEach((node) => {
        if (node.tagName === 'IFRAME') {
          try {
            const w = node.contentWindow;
            if (w && !w.__patched) {
              w.__patched = true;
              if (w.WebGLRenderingContext) patchWebGL(w.WebGLRenderingContext);
              if (w.WebGL2RenderingContext) patchWebGL(w.WebGL2RenderingContext);
            }
          } catch (_) {
            // Cross-origin iframes throw — expected
          }
        }
      });
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
`;
}

let preloadFileURL: string | null = null;
let preloadFilePath: string | null = null;

/** Get the raw file path (not URL) of the preload script. */
function getPreloadFilePath(): string {
  if (preloadFilePath) return preloadFilePath;
  preloadFilePath = join(app.getPath('userData'), 'ai-webview-preload.js');
  return preloadFilePath;
}

/** Write the webview preload to disk and return its file:// URL. */
export function writeWebviewPreload(): string {
  if (preloadFileURL) return preloadFileURL;

  const filePath = getPreloadFilePath();
  writeFileSync(filePath, getPreloadContent(), 'utf-8');
  preloadFileURL = pathToFileURL(filePath).href;
  return preloadFileURL;
}
