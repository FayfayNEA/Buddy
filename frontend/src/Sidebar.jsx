import { useEffect, useState } from 'react';
import axios from 'axios';
import { Mail, LogOut, ChevronDown } from 'lucide-react';
import { useEscapeToClose } from './auth/useEscapeToClose';

function MyWorkAccordion({ open, apiBase, authHeaders, canSaveCurrent, onSaveCurrent, onLoadSession, onClose, sessionsVersion }) {
  const [sessions, setSessions] = useState(null); // null = not loaded yet
  const [error, setError] = useState('');
  const [savingTitle, setSavingTitle] = useState('');
  const [busyId, setBusyId] = useState(null);

  const refresh = () => {
    axios.get(`${apiBase}/sessions`, { headers: authHeaders })
      .then(res => setSessions(res.data))
      .catch(() => setError('Could not load your saved work.'));
  };

  // Fetch lazily when first opened, and refetch whenever an autosave bumps the
  // version so the list reflects newly added generations without reopening.
  useEffect(() => {
    if (!open) return;
    if (sessions === null || sessionsVersion) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sessionsVersion]);

  if (!open) return null;

  const handleLoad = async (id) => {
    setBusyId(id);
    try {
      const res = await axios.get(`${apiBase}/sessions/${id}`, { headers: authHeaders });
      onLoadSession(res.data.data, { id: res.data.id, title: res.data.title });
      onClose();
    } catch {
      setError('Could not open that session.');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id) => {
    setBusyId(id);
    try {
      await axios.delete(`${apiBase}/sessions/${id}`, { headers: authHeaders });
      setSessions(prev => prev.filter(s => s.id !== id));
    } catch {
      setError('Could not delete that session.');
    } finally {
      setBusyId(null);
    }
  };

  const handleSave = async () => {
    setBusyId('saving');
    try {
      await onSaveCurrent(savingTitle.trim() || 'Untitled session');
      setSavingTitle('');
      refresh();
    } catch {
      setError('Could not save your current work.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="app-sidebar-accordion">
      {canSaveCurrent && (
        <div className="app-sidebar-save-row">
          <input
            type="text"
            placeholder="Name this session…"
            value={savingTitle}
            onChange={(e) => setSavingTitle(e.target.value)}
            className="auth-input"
          />
          <button type="button" className="app-sidebar-save-btn" onClick={handleSave} disabled={busyId === 'saving'}>
            {busyId === 'saving' ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {error && <div className="auth-error">{error}</div>}
      {sessions === null && <p className="app-sidebar-empty">Loading…</p>}
      {sessions?.length === 0 && <p className="app-sidebar-empty">No saved sessions yet.</p>}

      {(sessions || []).map(s => (
        <div key={s.id} className="app-sidebar-session-row">
          <button
            type="button"
            className="app-sidebar-session-title"
            onClick={() => handleLoad(s.id)}
            disabled={busyId === s.id}
          >
            {s.title}
          </button>
          <button
            type="button"
            className="app-sidebar-session-delete"
            onClick={() => handleDelete(s.id)}
            disabled={busyId === s.id}
            aria-label={`Delete ${s.title}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export default function Sidebar({
  open,
  onClose,
  auth,
  apiBase,
  contactEmail,
  onLoadSession,
  canSaveCurrent,
  onSaveCurrent,
  sessionsVersion,
  onOpenUpgrade,
  onOpenPortal,
  onSignOut,
  onSignUp,
}) {
  useEscapeToClose(open ? onClose : () => {});
  const [myWorkOpen, setMyWorkOpen] = useState(false);

  return (
    <>
      <div
        className={`app-sidebar-backdrop${open ? ' app-sidebar-backdrop--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div className={`app-sidebar${open ? ' app-sidebar--open' : ''}`}>
        <div className="app-sidebar-top">
          {auth.user?.is_paid && <span className="app-sidebar-tag">✦ Unlimited</span>}
          <button
            type="button"
            className="app-sidebar-close"
            onClick={onClose}
            title="Close"
            aria-label="Close menu"
          />
        </div>
        <nav className="app-sidebar-nav">
          {auth.user ? (
            <>
              <button
                type="button"
                className="app-sidebar-link app-sidebar-link--accordion"
                onClick={() => setMyWorkOpen(o => !o)}
              >
                My Work
                <ChevronDown size={15} strokeWidth={2} className={`app-sidebar-chevron${myWorkOpen ? ' app-sidebar-chevron--open' : ''}`} />
              </button>
              <MyWorkAccordion
                open={myWorkOpen}
                apiBase={apiBase}
                authHeaders={auth.authHeaders}
                canSaveCurrent={canSaveCurrent}
                onSaveCurrent={onSaveCurrent}
                onLoadSession={onLoadSession}
                onClose={onClose}
                sessionsVersion={sessionsVersion}
              />
              {auth.user.is_paid ? (
                <button type="button" className="app-sidebar-link" onClick={() => { onOpenPortal(); onClose(); }}>
                  Manage Subscription
                </button>
              ) : auth.user.billing_enabled ? (
                <button type="button" className="app-sidebar-link" onClick={() => { onOpenUpgrade(); onClose(); }}>
                  Upgrade
                </button>
              ) : null}
              <button
                type="button"
                className="app-sidebar-link app-sidebar-link--muted app-sidebar-signout"
                onClick={() => { onSignOut(); onClose(); }}
              >
                <LogOut size={15} strokeWidth={2} />
                Sign out
              </button>
            </>
          ) : (
            <button type="button" className="app-sidebar-link" onClick={() => { onSignUp(); onClose(); }}>
              Sign up
            </button>
          )}
        </nav>

        <a href={`mailto:${contactEmail}`} className="app-sidebar-contact">
          <Mail size={16} strokeWidth={2} />
          {contactEmail}
        </a>
      </div>
    </>
  );
}
