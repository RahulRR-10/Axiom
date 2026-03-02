import React from 'react';

import { TopBar } from '../layout/TopBar';

export const Workspace: React.FC = () => {
  return (
    <section className="h-full w-full flex flex-col overflow-hidden">
      <TopBar />
      <div className="flex-1 p-4 text-[#d4d4d4]">
        <h2 className="text-sm font-semibold">Workspace</h2>
        <p className="mt-2 text-xs text-[#9a9a9a]">Phase 1 placeholder content</p>
      </div>
    </section>
  );
};