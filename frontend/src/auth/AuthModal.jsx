import { useState } from 'react';
import { useEscapeToClose } from './useEscapeToClose';

export default function AuthModal({ auth, onClose }) {
  useEscapeToClose(onClose);
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signup') await auth.signup(email.trim(), password);
      else await auth.login(email.trim(), password);
      onClose();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="access-notice-backdrop" onClick={onClose}>
      <div className="access-notice-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="access-notice-title">{mode === 'signup' ? 'Create an account' : 'Sign in'}</h2>
        <p className="access-notice-body">
          {mode === 'signup'
            ? 'Save your work and pick up where you left off, on any device.'
            : 'Sign in to see your saved work.'}
        </p>
        <form onSubmit={submit}>
          <input
            type="email"
            required
            autoFocus
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="auth-input"
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="auth-input"
          />
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="access-notice-btn" disabled={busy}>
            {busy ? 'Please wait…' : (mode === 'signup' ? 'Create account' : 'Sign in')}
          </button>
        </form>
        <button
          type="button"
          className="auth-switch-link"
          onClick={() => { setMode(m => m === 'signup' ? 'login' : 'signup'); setError(''); }}
        >
          {mode === 'signup' ? 'Already have an account? Sign in' : "Don't have an account? Sign up"}
        </button>
      </div>
    </div>
  );
}
