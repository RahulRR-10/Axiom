import { Settings } from 'lucide-react';
import React, { useEffect, useRef } from 'react';

type TopBarProps = {
  onSpotlightTrigger?: () => void;
};

export const TopBar: React.FC<TopBarProps> = ({ onSpotlightTrigger }) => {
  const searchInputRef = useRef<HTMLInputElement>(null);
  const noDragRegionStyle = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchInputRef.current?.focus();
        onSpotlightTrigger?.();
        window.dispatchEvent(new CustomEvent('spotlight:open'));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [onSpotlightTrigger]);

  return (
    <header
      style={{
        height: '40px',
        background: '#1a1a1a',
        borderBottom: '1px solid #2a2a2a',
        WebkitAppRegion: 'drag',
      } as React.CSSProperties}
      className="flex items-center justify-between px-4"
    >
      <div className="text-xs text-[#8a8a8a]">Axiom</div>

      <div className="flex-1 px-4 flex justify-center" style={noDragRegionStyle}>
        <input
          ref={searchInputRef}
          placeholder="Search your vault... (Ctrl+K)"
          className="w-full max-w-[400px] rounded-md bg-[#141414] border border-[#2a2a2a] px-3 py-1.5 text-sm text-[#d4d4d4] outline-none focus:border-[#3a3a3a]"
        />
      </div>

      <div className="flex items-center" style={noDragRegionStyle}>
        <button
          type="button"
          aria-label="Settings"
          className="h-8 w-8 rounded-md text-[#9a9a9a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] flex items-center justify-center"
        >
          <Settings size={16} />
        </button>
      </div>
    </header>
  );
};