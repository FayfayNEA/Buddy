import { useEffect, useRef, useState } from 'react';

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

function GoogleButton({ auth, onSuccess, onError }) {
  const containerRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    let cancelled = false;

    const init = () => {
      if (cancelled || !window.google?.accounts?.id || !containerRef.current) return;
      window.google.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (response) => {
          try {
            await auth.loginWithGoogle(response.credential);
            onSuccess();
          } catch (err) {
            onError(err?.response?.data?.detail || 'Google sign-in failed. Try again.');
          }
        },
      });
      window.google.accounts.id.renderButton(containerRef.current, {
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        logo_alignment: 'left',
        width: containerRef.current.offsetWidth || 320,
      });
      setReady(true);
    };

    const existing = document.getElementById('google-identity-script');
    if (existing) {
      init();
    } else {
      const script = document.createElement('script');
      script.id = 'google-identity-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.onload = init;
      document.body.appendChild(script);
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!GOOGLE_CLIENT_ID) return null;

  return (
    <div className="google-btn-wrap">
      <div ref={containerRef} className="google-btn-slot" />
      {!ready && <div className="google-btn-fallback">Loading Google sign-in…</div>}
    </div>
  );
}

export default function LoginGate({ auth, onEnter, onDemo, onCancel }) {
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A failed login is ambiguous on purpose (the backend never says whether the
  // account exists, to avoid leaking which emails have signed up), so offer the
  // "no account yet" path regardless of which one it actually was.
  const [loginFailed, setLoginFailed] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setLoginFailed(false);
    setBusy(true);
    try {
      if (mode === 'signup') await auth.signup(email.trim(), password);
      else await auth.login(email.trim(), password);
      onEnter();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Something went wrong. Try again.');
      if (mode === 'login' && err?.response?.status === 401) setLoginFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-gate">
      <div className="login-gate-inner">
        <a href="/" className="login-gate-logo-link" aria-label="Back to Buddy home">
          <img src="/images/buddyname.svg" alt="Buddy" className="login-gate-logo" />
        </a>

        <div className="login-tabs">
          <button
            type="button"
            className={`login-tab${mode === 'login' ? ' login-tab--active' : ''}`}
            onClick={() => { setMode('login'); setError(''); setLoginFailed(false); }}
          >
            Login
          </button>
          <button
            type="button"
            className={`login-tab${mode === 'signup' ? ' login-tab--active' : ''}`}
            onClick={() => { setMode('signup'); setError(''); setLoginFailed(false); }}
          >
            Sign Up
          </button>
        </div>

        <div className="login-card">
          <h2 className="login-card-title">{mode === 'signup' ? 'Sign Up' : 'Login'}</h2>
          <p className="login-card-sub">
            {mode === 'signup'
              ? 'Create an account to save your work and pick up where you left off.'
              : 'Enter your email and password to access your account.'}
          </p>

          <GoogleButton
            auth={auth}
            onSuccess={onEnter}
            onError={setError}
          />

          {GOOGLE_CLIENT_ID && (
            <div className="login-divider"><span>or</span></div>
          )}

          <form onSubmit={submit}>
            <label className="login-field-label" htmlFor="login-email">Email</label>
            <input
              id="login-email"
              type="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="auth-input"
            />
            <label className="login-field-label" htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              required
              minLength={8}
              placeholder=""
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="auth-input"
            />
            {mode === 'signup' && (
              <div className="login-field-hint">At least 8 characters, with a number and an uppercase letter.</div>
            )}
            {error && (
              <div className="auth-error">
                {error}
                {loginFailed && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="auth-error-link"
                      onClick={() => { setMode('signup'); setError(''); setLoginFailed(false); }}
                    >
                      New here? Create an account
                    </button>
                  </>
                )}
              </div>
            )}
            <button type="submit" className="login-submit-btn" disabled={busy}>
              {busy ? 'Please wait…' : (mode === 'signup' ? 'Sign Up' : 'Login')}
            </button>
          </form>
        </div>

        {onDemo && (
          <button type="button" className="login-demo-link" onClick={onDemo}>
            Try the demo instead, no account needed
          </button>
        )}
        {onCancel && (
          <button type="button" className="login-demo-link" onClick={onCancel}>
            Continue with the demo
          </button>
        )}

        <a href="/" className="login-back-link">Back to Home</a>
      </div>
    </div>
  );
}
