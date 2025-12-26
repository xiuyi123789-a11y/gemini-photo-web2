
import React, { useState } from 'react';
import { EyeIcon, EyeSlashIcon } from './IconComponents';
import { ChangelogModal } from './ChangelogModal';
import changelogData from '@/src/data/changelog.json';

export const Header: React.FC<{ hideTitle?: boolean }> = ({ hideTitle }) => {
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
    <header className="ql-titlebar">
      <div className="ql-titlebar-inner">
        <div className="ql-titlebar-title">
          {!hideTitle && <span className="truncate">量子跃迁 AI修图工作室</span>}
          <button
            onClick={() => setIsChangelogOpen(true)}
            className="px-2 py-0.5 rounded-full text-[10px] font-mono transition-colors cursor-pointer select-none"
            style={{
              background: 'var(--ql-accent-weak)',
              color: 'var(--ql-text-muted)',
              border: '1px solid var(--ql-border)'
            }}
            title="点击查看更新日志"
          >
            {currentVersion}
          </button>
        </div>

        <div className="flex items-center gap-2 whitespace-nowrap">
          <div
            className="relative flex items-center rounded-lg px-3 py-1.5 transition-all"
            style={{
              background: 'rgba(255,255,255,0.7)',
              border: '1px solid var(--ql-border)'
            }}
          >
            <span className="text-[11px] mr-2 font-mono" style={{ color: 'var(--ql-text-muted)' }}>
              API Key
            </span>
            <input
              type={isVisible ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setIsEditing(true);
              }}
              placeholder="r8_..."
              className="bg-transparent outline-none text-[11px] w-28 font-mono"
              style={{ color: 'var(--ql-text)' }}
            />
            <button
              onClick={() => setIsVisible(!isVisible)}
              className="ml-2 transition-colors"
              style={{ color: 'var(--ql-text-muted)' }}
              title={isVisible ? '隐藏' : '显示'}
            >
              {isVisible ? <EyeSlashIcon className="w-3.5 h-3.5" /> : <EyeIcon className="w-3.5 h-3.5" />}
            </button>
          </div>
          {isEditing && (
            <button
              onClick={handleSaveApiKey}
              className="px-3 py-1.5 rounded-lg text-[11px] font-bold transition-colors"
              style={{
                background: 'var(--ql-accent)',
                color: '#fff'
              }}
            >
              确认
            </button>
          )}
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
