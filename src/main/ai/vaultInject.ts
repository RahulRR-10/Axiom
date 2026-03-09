import type { WebContents } from 'electron';

const SELECTORS: Record<string, string[]> = {
    chatgpt: [
        '#prompt-textarea',
        'textarea',
        '[contenteditable="true"]',
    ],
    claude: [
        '.ProseMirror',
        '[contenteditable="true"]',
        'textarea',
    ],
    gemini: [
        'rich-textarea .ql-editor',
        'rich-textarea [contenteditable="true"]',
        '.ql-editor[contenteditable="true"]',
        '.text-input-field_textarea-wrapper [contenteditable="true"]',
        '.ql-editor',
        '[contenteditable="true"]',
        'textarea',
    ],
};

// Providers where we use native webContents.insertText() instead of
// execCommand (Quill ignores execCommand and paste is blocked without a gesture)
const NATIVE_INSERT_PROVIDERS = new Set(['gemini']);

// For providers whose input doesn't respond to synthetic Enter keys,
// we find and click the send button directly.
const SUBMIT_SELECTORS: Record<string, string[]> = {
    gemini: [
        'button.send-button',
        'button[aria-label="Send message"]',
        'button[mattooltip="Send message"]',
        'button[data-tooltip="Send message"]',
        '.send-button-container button',
    ],
};

export async function injectPrompt(
    webContents: WebContents,
    provider: string,
    prompt: string,
): Promise<{ success: boolean; error?: string }> {
    const selectors = SELECTORS[provider];
    if (!selectors) {
        return { success: false, error: `Unknown provider: ${provider}` };
    }

    const useNativeInsert = NATIVE_INSERT_PROVIDERS.has(provider);
    const escaped = JSON.stringify(prompt);
    const submitSelectors = JSON.stringify(SUBMIT_SELECTORS[provider] ?? []);
    const submitDelay = provider === 'gemini' ? 600 : 300;

    // Step 1: Focus the input element and clear any existing content
    const focusScript = `
    (function () {
      const selectors = ${JSON.stringify(selectors)};
      let el = null;
      let matchedSelector = '';
      for (const s of selectors) {
        el = document.querySelector(s);
        if (el) { matchedSelector = s; break; }
      }
      if (!el) {
        return { ok: false, reason: 'No input found. Tried: ' + selectors.join(', ') };
      }

      el.focus();

      if (el.isContentEditable) {
        // Select all and delete to clear
        document.execCommand('selectAll');
        document.execCommand('delete');
      } else {
        el.value = '';
      }

      return { ok: true, selector: matchedSelector };
    })()
  `;

    try {
        const focusResult = await webContents.executeJavaScript(focusScript);
        console.log(`[vaultInject] provider=${provider} focus=`, JSON.stringify(focusResult));
        if (!focusResult?.ok) {
            return { success: false, error: focusResult?.reason ?? 'Focus failed' };
        }

        // Step 2: Insert text
        if (useNativeInsert) {
            // Use Electron's native insertText — operates at the Chromium IME level,
            // so Quill and other frameworks see real input they can't ignore
            await webContents.insertText(prompt);
        } else {
            // Use execCommand for ChatGPT / Claude (works fine there)
            const insertScript = `
            (function () {
              const el = document.activeElement;
              if (el && el.isContentEditable) {
                document.execCommand('insertText', false, ${escaped});
              } else if (el && el.tagName === 'TEXTAREA') {
                const nativeSetter = Object.getOwnPropertyDescriptor(
                  window.HTMLTextAreaElement.prototype, 'value'
                ).set;
                nativeSetter.call(el, ${escaped});
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
              return { ok: true };
            })()
          `;
            await webContents.executeJavaScript(insertScript);
        }

        // Step 3: Wait, then submit
        await new Promise(r => setTimeout(r, submitDelay));

        const submitScript = `
        (async function () {
          const submitSelectors = ${submitSelectors};
          let submitted = false;

          for (const ss of submitSelectors) {
            const btn = document.querySelector(ss);
            if (btn) {
              btn.removeAttribute('disabled');
              btn.click();
              submitted = true;
              break;
            }
          }

          if (!submitted) {
            const el = document.activeElement;
            if (el) {
              el.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', code: 'Enter', keyCode: 13,
                bubbles: true, cancelable: true
              }));
              el.dispatchEvent(new KeyboardEvent('keypress', {
                key: 'Enter', code: 'Enter', keyCode: 13,
                bubbles: true, cancelable: true
              }));
              el.dispatchEvent(new KeyboardEvent('keyup', {
                key: 'Enter', code: 'Enter', keyCode: 13,
                bubbles: true, cancelable: true
              }));
            }
          }

          return { submitted };
        })()
      `;

        const submitResult = await webContents.executeJavaScript(submitScript);
        console.log(`[vaultInject] provider=${provider} submit=`, JSON.stringify(submitResult));

        return { success: true };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'executeJavaScript threw';
        console.error(`[vaultInject] provider=${provider} error:`, message);
        return { success: false, error: message };
    }
}
