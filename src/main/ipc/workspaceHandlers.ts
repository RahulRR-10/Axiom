import * as fs from 'fs';
import * as path from 'path';

import { app, ipcMain } from 'electron';

import { WORKSPACE_CHANNELS } from '../../shared/ipc/channels';
import type { WorkspaceState } from '../../shared/types';

const SETTINGS_PATH = path.join(app.getPath('userData'), 'axiom-settings.json');

function readSettingsRaw(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(WORKSPACE_CHANNELS.SAVE, (_event, state: WorkspaceState): void => {
    try {
      const settings = readSettingsRaw();
      settings.workspace = state;
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings), 'utf8');
    } catch (err) {
      console.error('[workspaceHandlers] Save failed:', err);
    }
  });

  ipcMain.handle(WORKSPACE_CHANNELS.LOAD, (): WorkspaceState | null => {
    try {
      const settings = readSettingsRaw();
      return (settings.workspace as WorkspaceState) ?? null;
    } catch {
      return null;
    }
  });
}
