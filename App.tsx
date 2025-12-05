
import './index.css';

import React, { useState, useCallback } from 'react';
import { Header } from './components/Header';
import { AnalysisView } from './components/AnalysisView';
import { GenerationView } from './components/GenerationView';
import { KnowledgeBaseView } from './components/KnowledgeBaseView';
import { SmartRetouchView } from './components/SmartRetouchView';
import { AnalysisResult } from './types';
import { initializeAi } from './services/geminiService';


type View = 'analyze' | 'generate' | 'retouch' | 'knowledge';

import { ApiKeyProvider } from './src/contexts/ApiKeyContext';

import { ApiKeyModal } from './components/ApiKeyModal';
import { useApiKey } from './src/contexts/ApiKeyContext';

const App: React.FC = () => {
  const [currentView, setCurrentViewState] = useState<View>(() => {
      return (localStorage.getItem('currentView') as View) || 'analyze';
  });
  
  const setCurrentView = (view: View) => {
      setCurrentViewState(view);
      localStorage.setItem('currentView', view);
  };

  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const { apiKey } = useApiKey();

  const handleAnalysisComplete = useCallback((result: AnalysisResult) => {
    setAnalysisResult(result);
    setCurrentView('generate');
  }, []);

  const NavButton: React.FC<{
    label: string;
    viewName: View;
    currentView: View;
    onClick: (view: View) => void;
  }> = ({ label, viewName, currentView, onClick }) => (
     <button
        onClick={() => onClick(viewName)}
        className={`px-4 sm:px-6 py-2.5 sm:py-3 rounded-full text-sm sm:text-md font-bold transition-all duration-300 flex items-center gap-2 shadow-sm transform hover:scale-105 whitespace-nowrap ${
          currentView === viewName
            ? 'bg-gradient-to-r from-pink-500 to-violet-600 text-white shadow-lg shadow-pink-500/30 ring-2 ring-white/20'
            : 'bg-slate-800/80 text-gray-400 hover:text-white hover:bg-slate-700'
        }`}
      >
        {label}
      </button>
  );

  return (
    <div className="min-h-screen flex flex-col">
      <ApiKeyModal />
      <Header />
      <main className="flex-grow container mx-auto p-4 md:p-8 max-w-7xl">
        <div className="bg-slate-900/60 backdrop-blur-md border border-white/10 rounded-3xl shadow-2xl p-6 md:p-8 mb-8">
          <div className="flex flex-wrap justify-center gap-3 sm:gap-4 mb-8 overflow-x-auto pb-2">
             <NavButton label="1. 智能解析" viewName="analyze" currentView={currentView} onClick={setCurrentView} />
             <NavButton label="2. 创意生成" viewName="generate" currentView={currentView} onClick={setCurrentView} />
             <NavButton label="3. 智能修图" viewName="retouch" currentView={currentView} onClick={setCurrentView} />
             <NavButton label="4. 灵感知识库" viewName="knowledge" currentView={currentView} onClick={setCurrentView} />
          </div>

          <div className="transition-opacity duration-500 ease-in-out">
            {apiKey ? (
              <>
                <div style={{ display: currentView === 'analyze' ? 'block' : 'none' }}>
                    <AnalysisView onAnalysisComplete={handleAnalysisComplete} />
                </div>
                <div style={{ display: currentView === 'generate' ? 'block' : 'none' }}>
                    <GenerationView initialAnalysisResult={analysisResult} />
                </div>
                 <div style={{ display: currentView === 'retouch' ? 'block' : 'none' }}>
                    <SmartRetouchView />
                </div>
                <div style={{ display: currentView === 'knowledge' ? 'block' : 'none' }}>
                    <KnowledgeBaseView />
                </div>
              </>
            ) : (
              <div className="text-center">
                <h2 className="text-4xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-purple-500 mb-6">欢迎来到量子跃迁 AI 修图工作室</h2>
                <p className="text-lg text-slate-400">请输入您的 replicate APIkey 以继续。</p>
              </div>
            )}
          </div>
        </div>
      </main>
      <footer className="text-center p-8 text-slate-500 text-sm font-medium border-t border-white/5 bg-slate-900/40">
        <p className="text-slate-400 mb-1 text-base">量子跃迁AI修图工作室</p>
        <p className="text-xs opacity-70">作者：休一 | 联系方式：Veloce-RC</p>
        <p className="mt-2 text-xs opacity-50">✨ 由 Gemini 驱动提供算力支持</p>
      </footer>
    </div>
  );
};

export default App;
