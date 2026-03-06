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
        '.ql-editor',
        '[contenteditable="true"]',
        'textarea',
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

    const escaped = JSON.stringify(prompt);

    const script = `
    (function () {
      const selectors = ${JSON.stringify(selectors)};
      let el = null;
      for (const s of selectors) {
        el = document.querySelector(s);
        if (el) break;
      }
      if (!el) return { ok: false, reason: 'No input found' };

      if (el.isContentEditable) {
        el.focus();
        el.innerText = ${escaped};
      } else {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(el, ${escaped});
        el.focus();
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));

      setTimeout(() => {
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13,
          bubbles: true, cancelable: true
        }));
      }, 100);

      return { ok: true };
    })()
  `;

    try {
        const result = await webContents.executeJavaScript(script);
        if (!result?.ok) {
            return { success: false, error: result?.reason ?? 'Injection failed' };
        }
        return { success: true };
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'executeJavaScript threw';
        return { success: false, error: message };
    }
}
