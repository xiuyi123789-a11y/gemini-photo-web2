import { setStorageUser } from './services/browserStorage';
import { userStorage } from './services/browserStorage';

import './index.css';

import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Header } from './components/Header';
import { AnalysisView } from './components/AnalysisView';
import { GenerationView } from './components/GenerationView';
import { KnowledgeBaseView } from './components/KnowledgeBaseView';
import { SmartRetouchView } from './components/SmartRetouchView';
import { ImageReplicationView } from './components/ImageReplicationView';
import { Copy } from 'lucide-react';
import { BookOpenIcon, HomeIcon, MagicWandIcon, PlayIcon, RefreshIcon } from './components/IconComponents';
import { HomeView } from './components/HomeView';
import { AnalysisResult } from './types';
import { LoginView } from './components/LoginView';


type View = 'home' | 'analyze' | 'generate' | 'retouch' | 'replicate' | 'knowledge';

const App: React.FC = () => {
  const [identity, setIdentity] = useState<{ mode: string; user: { id: string; username: string } | null } | null>(null);
  const [authError, setAuthError] = useState(false);
  useEffect(() => {
    fetch('/api/auth/me').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(identity => { setStorageUser(identity.user?.id || null); setIdentity(identity); }).catch(() => setAuthError(true));
  }, []);
  const [currentView, setCurrentViewState] = useState<View>(() => {
      return (userStorage.getItem('currentView') as View) || 'analyze';
  });
  const [homeStage, setHomeStage] = useState<'init' | 'workbench'>(() => {
    const raw = userStorage.getItem('ql_home_stage');
    return raw === 'workbench' ? 'workbench' : 'init';
  });
  const isWorkbench = currentView === 'home' && homeStage === 'workbench';
  
  const setCurrentView = (view: View) => {
      setCurrentViewState(view);
      userStorage.setItem('currentView', view);
  };

  const [analysisResult, setAnalysisResult] = useState<AnalysisResult[] | null>(null);
  const contentOuterRef = useRef<HTMLDivElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const lastScaleRef = useRef<number>(1);

  const handleAnalysisComplete = useCallback((result: AnalysisResult[]) => {
    setAnalysisResult(result);
    setCurrentView('generate');
  }, []);

  const navItems = useMemo(() => {
    return [
      { label: '首页', viewName: 'home' as const, Icon: HomeIcon },
      { label: '智能解析', viewName: 'analyze' as const, Icon: MagicWandIcon },
      { label: '创意生成', viewName: 'generate' as const, Icon: PlayIcon },
      { label: '图像处理', viewName: 'retouch' as const, Icon: RefreshIcon },
      { label: '图像复刻', viewName: 'replicate' as const, Icon: Copy },
      { label: '灵感知识库', viewName: 'knowledge' as const, Icon: BookOpenIcon }
    ];
  }, []);

  const NavButton: React.FC<{
    label: string;
    viewName: View;
    currentView: View;
    onClick: (view: View) => void;
    Icon: React.FC<{ className?: string }>;
  }> = ({ label, viewName, currentView, onClick, Icon }) => (
     <button
        onClick={() => onClick(viewName)}
        className="ql-nav-btn"
        aria-current={currentView === viewName ? 'page' : undefined}
      >
        <Icon className="w-5 h-5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
  );

  useEffect(() => {
    const el = contentOuterRef.current;
    if (!el) return;

    const rootStyles = getComputedStyle(document.documentElement);
    const baseWidthPx = Number.parseFloat(rootStyles.getPropertyValue('--ql-min-content-width')) || 980;
    const maxScale = Number.parseFloat(rootStyles.getPropertyValue('--ql-max-scale')) || 1.1;
    const minWindowWidthPx = Number.parseFloat(rootStyles.getPropertyValue('--ql-min-window-width')) || 1220;

    const applyScale = (containerWidth: number) => {
      const raw = containerWidth / baseWidthPx;
      const next = Math.max(1, Math.min(raw, maxScale));
      if (Math.abs(next - lastScaleRef.current) < 0.001) return;
      lastScaleRef.current = next;
      const active = document.activeElement as HTMLElement | null;
      const isTextInput =
        active &&
        el.contains(active) &&
        (active instanceof HTMLTextAreaElement ||
          (active instanceof HTMLInputElement &&
            (active.type === 'text' || active.type === 'search' || active.type === 'password')));
      const selection =
        isTextInput
          ? {
              el: active as HTMLTextAreaElement | HTMLInputElement,
              start: (active as HTMLTextAreaElement | HTMLInputElement).selectionStart,
              end: (active as HTMLTextAreaElement | HTMLInputElement).selectionEnd,
              dir: (active as HTMLTextAreaElement | HTMLInputElement).selectionDirection,
              scrollTop: (active as HTMLTextAreaElement | HTMLInputElement).scrollTop,
              scrollLeft: (active as HTMLTextAreaElement | HTMLInputElement).scrollLeft
            }
          : null;
      el.style.setProperty('--ql-content-scale', String(next));
      el.style.setProperty('--ql-content-scale-inv', String(1 / next));
      if (selection) {
        requestAnimationFrame(() => {
          try {
            selection.el.focus({ preventScroll: true });
            if (typeof selection.start === 'number' && typeof selection.end === 'number') {
              selection.el.setSelectionRange(selection.start, selection.end, selection.dir || undefined);
            }
            selection.el.scrollTop = selection.scrollTop;
            selection.el.scrollLeft = selection.scrollLeft;
          } catch {
          }
        });
      }
    };

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        applyScale(entry.contentRect.width);
      });
    });

    ro.observe(el);
    applyScale(el.getBoundingClientRect().width);

    const syncNarrowFlag = () => {
      const isNarrow = window.innerWidth < minWindowWidthPx;
      document.documentElement.dataset.qlNarrow = isNarrow ? '1' : '0';
    };

    syncNarrowFlag();
    window.addEventListener('resize', syncNarrowFlag, { passive: true });

    return () => {
      if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current);
      ro.disconnect();
      window.removeEventListener('resize', syncNarrowFlag);
    };
  }, []);

  if (authError) return <main className="p-8">无法连接服务。<button onClick={() => window.location.reload()}>重试</button></main>;
  if (!identity) return <main className="p-8">正在连接工作室…</main>;
  if (identity.mode === 'accounts' && !identity.user) return <LoginView onLogin={() => window.location.reload()} />;

  return (
    <div className="ql-shell" data-ql-layout={isWorkbench ? 'home' : 'app'}>
      {identity.user && <div className="fixed bottom-2 right-3 z-50 rounded-lg bg-white px-3 py-2 text-xs text-slate-700 shadow">
        {identity.user.username} · <button onClick={async () => {
          const response = await fetch('/api/auth/logout', { method: 'POST' });
          if (response.ok) { sessionStorage.clear(); window.location.reload(); }
        }}>退出登录</button>
      </div>}
      {!isWorkbench && (
        <aside className="ql-sidebar">
          <div className="ql-sidebar-inner">
            <div className="ql-nav">
              {navItems.map(({ label, viewName, Icon }) => (
                <NavButton
                  key={viewName}
                  label={label}
                  viewName={viewName}
                  currentView={currentView}
                  onClick={setCurrentView}
                  Icon={Icon}
                />
              ))}
            </div>
          </div>
        </aside>
      )}
      {!isWorkbench && <Header />}
      <div className="ql-body">
        <div className="ql-scroll-area">
          <main className="flex-1 min-h-0">
            {currentView === 'home' ? (
              <HomeView onStageChange={setHomeStage} />
            ) : (
              <div className="ql-content-outer" ref={contentOuterRef}>
                <div className="ql-content-sizer ql-edit">
                  <div className="ql-content-scale">
                    <div className="transition-opacity duration-500 ease-in-out">
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
                      <div style={{ display: currentView === 'replicate' ? 'block' : 'none' }}>
                        <ImageReplicationView />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </main>
          <footer
            className="text-center p-8 text-sm font-medium mt-auto"
            style={{ borderTop: '1px solid var(--ql-border)', color: 'var(--ql-text-muted)' }}
          >
            <p className="mb-1 text-base" style={{ color: 'var(--ql-text)' }}>量子跃迁AI修图工作室</p>
            <p className="text-xs" style={{ color: 'var(--ql-text-muted)' }}>作者：休一 | 联系方式：Veloce-RC</p>
          </footer>
        </div>
      </div>
    </div>
  );
};

export default App;
