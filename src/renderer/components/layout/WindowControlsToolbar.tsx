import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

import type { AppUpdateState } from '../../../shared/types';

export const WindowControlsToolbar: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [updateState, setUpdateState] = useState<AppUpdateState | null>(null);

  useEffect(() => {
    let unsubscribeWindow = (): void => undefined;
    let unsubscribeUpdater = (): void => undefined;

    window.electronAPI.isWindowMaximized().then(setIsMaximized).catch((): void => undefined);
    window.electronAPI.getAppUpdateState().then(setUpdateState).catch((): void => undefined);

    unsubscribeWindow = window.electronAPI.onWindowMaximizedChange((nextState) => {
      setIsMaximized(nextState);
    });
    unsubscribeUpdater = window.electronAPI.onAppUpdateStateChange((nextState) => {
      setUpdateState(nextState);
    });

    return () => {
      unsubscribeWindow();
      unsubscribeUpdater();
    };
  }, []);

  return (
    <div className="h-8 px-1 flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      {updateState?.available && (
        <button
          type="button"
          onClick={() => void window.electronAPI.downloadLatestRelease()}
          aria-label="Download update"
          title={updateState.latestVersion ? `Download Axiom ${updateState.latestVersion}` : 'Download the latest Axiom release'}
          className="h-8 px-3 rounded-md bg-[#1f4f39] text-[#b8f1d3] hover:bg-[#276449] flex items-center gap-1.5 text-xs font-medium"
        >
          <Download size={14} />
          <span>Update</span>
        </button>
      )}

      <button
        type="button"
        onClick={() => void window.electronAPI.minimizeWindow()}
        aria-label="Minimize"
        className="h-8 w-8 rounded-md text-[#cfcfcf] hover:bg-[#2a2a2a] flex items-center justify-center"
      >
        —
      </button>

      <button
        type="button"
        onClick={() => void window.electronAPI.toggleMaximizeWindow()}
        aria-label={isMaximized ? 'Restore Down' : 'Maximize'}
        className="h-8 w-8 rounded-md text-[#cfcfcf] hover:bg-[#2a2a2a] flex items-center justify-center text-sm"
      >
        {isMaximized ? '❐' : '□'}
      </button>

      <button
        type="button"
        onClick={() => void window.electronAPI.closeWindow()}
        aria-label="Close"
        className="h-8 w-8 rounded-md text-[#cfcfcf] hover:bg-[#e81123] hover:text-white flex items-center justify-center"
      >
        ×
      </button>
    </div>
  );
};
