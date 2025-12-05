
import React, { useState } from 'react';
import { EyeIcon, EyeSlashIcon } from './IconComponents';
import { ChangelogModal } from './ChangelogModal';
import changelogData from '@/src/data/changelog.json';

import { useApiKey } from '../src/contexts/ApiKeyContext';

export const Header: React.FC = () => {
  const { openModal } = useApiKey();
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const currentVersion = changelogData[0]?.version || 'v1.0.0';

  return (
    <header className="bg-slate-900/40 backdrop-blur-md border-b border-white/5 sticky top-0 z-20 transition-all">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-3 items-center py-4 gap-4">
          
          {/* Left: Spacer or Nav (Currently empty for balance, or could hold social links) */}
          <div className="hidden md:block"></div>

          {/* Center: Title */}
          <div className="text-center flex justify-center items-center gap-3">
            <div className="text-2xl font-extrabold tracking-tight text-white inline-block text-center">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-fuchsia-400">量子跃迁</span>
              <span className="text-white ml-2">AI修图工作室</span>
            </div>
            <button 
                onClick={() => setIsChangelogOpen(true)}
                className="px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] font-mono text-slate-400 hover:text-fuchsia-400 transition-colors cursor-pointer select-none"
                title="点击查看更新日志"
            >
                {currentVersion}
            </button>
          </div>

          {/* Right: API Key Input */}
          <div className="flex items-center gap-2 justify-center md:justify-end w-full">
             <button
                onClick={openModal}
                className="bg-gradient-to-r from-fuchsia-600 to-pink-600 text-white font-bold py-1.5 px-4 rounded-full text-xs hover:shadow-lg hover:shadow-fuchsia-500/30 transform hover:scale-105 transition-all whitespace-nowrap"
              >
                更新 replicate APIkey
              </button>
          </div>
        </div>
      </div>

      <ChangelogModal 
        isOpen={isChangelogOpen} 
        onClose={() => setIsChangelogOpen(false)} 
        changelogData={changelogData} 
      />
    </header>
  );
};
