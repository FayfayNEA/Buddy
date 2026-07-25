import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

const TOKEN_KEY = 'buddy_auth_token';

export function useAuth(apiBase) {
  const [token, setToken] = useState(() => {
    try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
  });
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false); // becomes true once the initial /auth/me check resolves

  const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

  useEffect(() => {
    let cancelled = false;
    if (!token) { setUser(null); setReady(true); return; }
    axios.get(`${apiBase}/auth/me`, { headers: authHeaders })
      .then(res => { if (!cancelled) setUser(res.data); })
      .catch(() => {
        if (cancelled) return;
        // Token expired/invalid — drop it silently
        setToken('');
        try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        setUser(null);
      })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, apiBase]);

  const _applyAuth = (data) => {
    setToken(data.token);
    setUser(data.user);
    try { localStorage.setItem(TOKEN_KEY, data.token); } catch { /* ignore */ }
  };

  const signup = useCallback(async (email, password) => {
    const res = await axios.post(`${apiBase}/auth/signup`, { email, password });
    _applyAuth(res.data);
  }, [apiBase]);

  const login = useCallback(async (email, password) => {
    const res = await axios.post(`${apiBase}/auth/login`, { email, password });
    _applyAuth(res.data);
  }, [apiBase]);

  const logout = useCallback(() => {
    setToken('');
    setUser(null);
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  }, []);

  // Re-read the account (usage counters, paid status) — call after a generation or
  // after returning from Stripe checkout.
  const refreshUser = useCallback(async () => {
    if (!token) return;
    try {
      const res = await axios.get(`${apiBase}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
      setUser(res.data);
    } catch { /* leave existing user in place */ }
  }, [token, apiBase]);

  // Send the user to Stripe Checkout. Returns an error string, or null on success
  // (the browser navigates away).
  const startCheckout = useCallback(async () => {
    try {
      const res = await axios.post(`${apiBase}/billing/checkout`, {}, { headers: { Authorization: `Bearer ${token}` } });
      window.location.href = res.data.url;
      return null;
    } catch (err) {
      return err?.response?.data?.detail || 'Could not start checkout.';
    }
  }, [token, apiBase]);

  const openBillingPortal = useCallback(async () => {
    try {
      const res = await axios.post(`${apiBase}/billing/portal`, {}, { headers: { Authorization: `Bearer ${token}` } });
      window.location.href = res.data.url;
      return null;
    } catch (err) {
      return err?.response?.data?.detail || 'Could not open billing.';
    }
  }, [token, apiBase]);

  return { user, token, ready, authHeaders, signup, login, logout, refreshUser, startCheckout, openBillingPortal };
}
