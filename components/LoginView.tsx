import React, { useState } from 'react';

export const LoginView: React.FC<{ onLogin: () => void }> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <main className="min-h-screen flex items-center justify-center p-6" style={{ background: 'var(--ql-bg)', color: 'var(--ql-text)' }}>
    <form className="w-full max-w-sm rounded-2xl p-8 shadow-xl space-y-5" style={{ background: 'var(--ql-surface)' }} onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '登录失败');
        setPassword(''); onLogin();
      } catch (e) { setError(e instanceof Error ? e.message : '无法连接服务，请稍后重试'); }
      finally { setBusy(false); }
    }}>
      <h1 className="text-2xl font-bold">量子跃迁 AI 修图工作室</h1>
      <p className="text-sm opacity-70">登录你的创作空间</p>
      <label className="block">用户名<input className="block border rounded-lg p-3 w-full mt-2 text-slate-900 bg-white" autoComplete="username" required maxLength={40} value={username} onChange={e => setUsername(e.target.value)} /></label>
      <label className="block">密码<input className="block border rounded-lg p-3 w-full mt-2 text-slate-900 bg-white" type="password" autoComplete="current-password" required maxLength={256} value={password} onChange={e => setPassword(e.target.value)} /></label>
      {error && <p role="alert" className="text-red-500 text-sm">{error}</p>}
      <button disabled={busy} className="w-full rounded-lg bg-violet-600 text-white p-3 disabled:opacity-50">{busy ? '正在登录…' : '登录'}</button>
      <p className="text-xs opacity-60">账号由工作室管理员开通。</p>
    </form>
  </main>;
};
