import React, { useEffect, useState } from 'react';

export const WindowControlsToolbar: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState<boolean>(false);

  useEffect(() => {
    let unsubscribe = (): void => undefined;

    window.electronAPI.isWindowMaximized().then(setIsMaximized).catch((): void => undefined);
    unsubscribe = window.electronAPI.onWindowMaximizedChange((nextState) => {
      setIsMaximized(nextState);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div className="h-8 px-1 flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
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