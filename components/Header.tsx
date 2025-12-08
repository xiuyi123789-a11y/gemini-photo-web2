
import React, { useState } from 'react';
import { EyeIcon, EyeSlashIcon } from './IconComponents';
import { ChangelogModal } from './ChangelogModal';
import changelogData from '@/src/data/changelog.json';

export const Header: React.FC = () => {
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);
  const currentVersion = changelogData[0]?.version || 'v1.0.0';
  
  // API Key State
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('replicate_api_token') || '');
  const [isVisible, setIsVisible] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const handleSaveApiKey = () => {
    localStorage.setItem('replicate_api_token', apiKey);
    setIsEditing(false);
    // Optional: Show a toast or feedback? For now, the button disappearing is feedback.
  };

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
             <div className="relative flex items-center bg-slate-800/50 rounded-lg border border-white/10 px-3 py-1.5 transition-all focus-within:border-fuchsia-500/50 focus-within:ring-1 focus-within:ring-fuchsia-500/50">
                <span className="text-xs text-slate-400 mr-2 font-mono whitespace-nowrap">API Key</span>
                <input 
                    type={isVisible ? "text" : "password"} 
                    value={apiKey}
                    onChange={(e) => {
                        setApiKey(e.target.value);
                        setIsEditing(true);
                    }}
                    placeholder="r8_..."
                    className="bg-transparent border-none outline-none text-xs text-white placeholder-slate-600 w-24 sm:w-32 font-mono"
                />
                <button 
                    onClick={() => setIsVisible(!isVisible)}
                    className="ml-2 text-slate-400 hover:text-white transition-colors"
                    title={isVisible ? "隐藏" : "显示"}
                >
                    {isVisible ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
                </button>
             </div>
             {isEditing && (
                 <button 
                    onClick={handleSaveApiKey}
                    className="px-3 py-1.5 rounded-lg bg-fuchsia-600 hover:bg-fuchsia-500 text-xs font-bold text-white transition-colors shadow-lg shadow-fuchsia-500/20 whitespace-nowrap"
                 >
                    确认
                 </button>
             )}
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
