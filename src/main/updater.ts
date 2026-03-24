import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { UPDATER_CHANNELS } from '../shared/ipc/channels';
import type { AppUpdateState } from '../shared/types';

type GitHubReleaseAsset = {
  name: string;
  browser_download_url: string;
};

type GitHubReleaseResponse = {
  tag_name: string;
  html_url: string;
  assets: GitHubReleaseAsset[];
};

const GITHUB_OWNER = 'RahulRR-10';
const GITHUB_REPO = 'Axiom';
const LATEST_RELEASE_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

let updateState: AppUpdateState = {
  checked: false,
  available: false,
  currentVersion: app.getVersion(),
  latestVersion: null,
  downloadUrl: null,
  releaseUrl: null,
  error: null,
};

const broadcastUpdateState = (): void => {
  for (const windowInstance of BrowserWindow.getAllWindows()) {
    if (!windowInstance.isDestroyed()) {
      windowInstance.webContents.send(UPDATER_CHANNELS.STATE_CHANGED, updateState);
    }
  }
};

const normalizeVersion = (value: string): number[] =>
  value
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);

const compareVersions = (left: string, right: string): number => {
  const leftParts = normalizeVersion(left);
  const rightParts = normalizeVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const delta = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }

  return 0;
};

const getArchTokens = (): string[] => {
  switch (process.arch) {
    case 'arm64':
      return ['arm64', 'aarch64'];
    case 'ia32':
      return ['ia32', 'x86', '32'];
    default:
      return ['x64', 'amd64', '64'];
  }
};

const hasOtherArchToken = (name: string, currentTokens: string[]): boolean =>
  ['arm64', 'aarch64', 'ia32', 'x86', 'x64', 'amd64']
    .filter((token) => !currentTokens.includes(token))
    .some((token) => name.includes(token));

const scoreAsset = (asset: GitHubReleaseAsset): number => {
  const name = asset.name.toLowerCase();
  const archTokens = getArchTokens();
  let score = 0;

  if (process.platform === 'win32') {
    if (name === 'releases' || name.endsWith('.nupkg') || name.endsWith('.msi')) {
      return Number.NEGATIVE_INFINITY;
    }
    if (!name.endsWith('.exe')) {
      return Number.NEGATIVE_INFINITY;
    }
    score += 120;
    if (name.includes('setup')) {
      score += 25;
    }
  } else if (process.platform === 'darwin') {
    if (!(name.endsWith('.zip') || name.endsWith('.dmg'))) {
      return Number.NEGATIVE_INFINITY;
    }
    score += name.endsWith('.dmg') ? 120 : 110;
  } else {
    if (!(name.endsWith('.deb') || name.endsWith('.rpm') || name.endsWith('.appimage') || name.endsWith('.tar.gz'))) {
      return Number.NEGATIVE_INFINITY;
    }
    score += name.endsWith('.deb') ? 120 : 110;
  }

  if (archTokens.some((token) => name.includes(token))) {
    score += 30;
  } else if (hasOtherArchToken(name, archTokens)) {
    score -= 20;
  }

  return score;
};

const selectDownloadUrl = (release: GitHubReleaseResponse): string => {
  const bestAsset = release.assets
    .map((asset) => ({ asset, score: scoreAsset(asset) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => right.score - left.score)[0]?.asset;

  return bestAsset?.browser_download_url ?? release.html_url;
};

const fetchLatestRelease = async (): Promise<void> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `${app.getName()}/${app.getVersion()}`,
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub responded with ${response.status}`);
    }

    const release = await response.json() as GitHubReleaseResponse;
    const latestVersion = release.tag_name.replace(/^v/i, '');
    const available = compareVersions(latestVersion, app.getVersion()) > 0;

    updateState = {
      checked: true,
      available,
      currentVersion: app.getVersion(),
      latestVersion,
      downloadUrl: available ? selectDownloadUrl(release) : null,
      releaseUrl: release.html_url,
      error: null,
    };
  } catch (error) {
    updateState = {
      ...updateState,
      checked: true,
      available: false,
      latestVersion: null,
      downloadUrl: null,
      releaseUrl: null,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error('[app-updater] latest release check failed:', updateState.error);
  } finally {
    clearTimeout(timeoutId);
    broadcastUpdateState();
  }
};

export function initAppUpdater(): void {
  ipcMain.handle(UPDATER_CHANNELS.GET_STATE, () => updateState);

  ipcMain.handle(UPDATER_CHANNELS.DOWNLOAD_LATEST, async () => {
    const targetUrl = updateState.downloadUrl ?? updateState.releaseUrl;
    if (!targetUrl) {
      throw new Error('No update download is available right now.');
    }

    await shell.openExternal(targetUrl);
  });

  if (!app.isPackaged) {
    updateState = {
      ...updateState,
      checked: true,
    };
    broadcastUpdateState();
    return;
  }

  setTimeout(() => {
    void fetchLatestRelease();
  }, 3000);
}
