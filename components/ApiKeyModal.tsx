import React, { useState } from 'react';
import { useApiKey } from '../src/contexts/ApiKeyContext';

export const ApiKeyModal: React.FC = () => {
  const { setApiKey, isModalOpen } = useApiKey();
  const [inputValue, setInputValue] = useState('');

  const handleConfirm = () => {
    if (inputValue.trim()) {
      setApiKey(inputValue.trim());
    }
  };

  if (!isModalOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-80 flex items-center justify-center z-50 backdrop-blur-lg">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-xl p-8 max-w-md w-full text-center transform transition-all duration-300 scale-100">
        <h2 className="text-2xl font-bold text-white mb-4">请输入您的 API Key</h2>
        <p className="text-slate-400 mb-6">为了使用本应用，您需要提供一个 Google Gemini API Key。我们不会存储您的密钥。</p>
        <input
          type="password"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          className="w-full px-4 py-3 bg-slate-900 border border-slate-700 rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-pink-500 transition-all"
          placeholder="在此输入您的 Google Gemini API Key"
        />
        <button
          onClick={handleConfirm}
          className="mt-6 w-full bg-gradient-to-r from-pink-500 to-violet-600 text-white font-bold py-3 rounded-lg hover:opacity-90 transition-opacity shadow-lg shadow-pink-500/30"
        >
          确认并继续
        </button>
      </div>
    </div>
  );
};
