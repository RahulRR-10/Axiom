import React from 'react';

export type WorkspaceMode = 'pdf' | 'notes' | 'search';

const TABS: Array<{ mode: WorkspaceMode; label: string }> = [
  { mode: 'pdf',    label: 'PDF Viewer' },
  { mode: 'notes',  label: 'Notes' },
  { mode: 'search', label: 'Search Results' },
];

type Props = {
  activeMode:   WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
};

export const WorkspaceTabBar: React.FC<Props> = ({ activeMode, onModeChange }) => {
  return (
    <div
      style={{
        height:       '40px',
        background:   '#1a1a1a',
        borderBottom: '1px solid #2a2a2a',
        flexShrink:   0,
      }}
      className="flex items-end px-2 gap-1"
    >
      {TABS.map(({ mode, label }) => {
        const isActive = mode === activeMode;
        return (
          <button
            key={mode}
            type="button"
            onClick={() => onModeChange(mode)}
            style={{
              // underline accent for active
              borderBottom: isActive ? '2px solid #6366f1' : '2px solid transparent',
              color:        isActive ? '#e4e4e4' : '#6e6e6e',
              background:   'transparent',
              paddingBottom: '6px',
            }}
            className="px-3 text-sm font-medium transition-colors hover:text-[#c4c4c4] focus:outline-none"
          >
            {label}
          </button>
        );
      })}
    </div>
  );
};
