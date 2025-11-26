
import React, { useState } from 'react';
import { EyeIcon, EyeSlashIcon } from './IconComponents';

import { useApiKey } from '../src/contexts/ApiKeyContext';

export const Header: React.FC = () => {
  const { openModal } = useApiKey();

  return (
    <header className="bg-slate-900/40 backdrop-blur-md border-b border-white/5 sticky top-0 z-20 transition-all">
      <div className="container mx-auto px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 md:grid-cols-3 items-center py-4 gap-4">
          
          {/* Left: Spacer or Nav (Currently empty for balance, or could hold social links) */}
          <div className="hidden md:block"></div>

          {/* Center: Title */}
          <div className="text-center flex justify-center">
            <div className="text-2xl font-extrabold tracking-tight text-white inline-block text-center">
              <span className="bg-clip-text text-transparent bg-gradient-to-r from-blue-400 to-fuchsia-400">量子跃迁</span>
              <span className="text-white ml-2">AI修图工作室</span>
            </div>
          </div>

          {/* Right: API Key Input */}
          <div className="flex items-center gap-2 justify-center md:justify-end w-full">
             <button
                onClick={openModal}
                className="bg-gradient-to-r from-fuchsia-600 to-pink-600 text-white font-bold py-1.5 px-4 rounded-full text-xs hover:shadow-lg hover:shadow-fuchsia-500/30 transform hover:scale-105 transition-all whitespace-nowrap"
              >
                更新 API Key
              </button>
          </div>
        </div>
      </div>
    </header>
  );
};
