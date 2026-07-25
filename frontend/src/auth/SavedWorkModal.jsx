import { useEffect, useState } from 'react';
import axios from 'axios';
import { useEscapeToClose } from './useEscapeToClose';

export default function SavedWorkModal({ apiBase, authHeaders, onClose, onLoad, canSaveCurrent, onSaveCurrent }) {
  useEscapeToClose(onClose);
  const [sessions, setSessions] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [savingTitle, setSavingTitle] = useState('');
  const [busyId, setBusyId] = useState(null);

  const refresh = () => {
    axios.get(`${apiBase}/sessions`, { headers: authHeaders })
      .then(res => setSessions(res.data))
      .catch(() => setError('Could not load your saved work.'));
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const handleLoad = async (id) => {
    setBusyId(id);
    try {
      const res = await axios.get(`${apiBase}/sessions/${id}`, { headers: authHeaders });
      onLoad(res.data.data);
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
    <div className="access-notice-backdrop" onClick={onClose}>
      <div className="access-notice-card saved-work-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="access-notice-title">My work</h2>

        {canSaveCurrent && (
          <div className="saved-work-save-row">
            <input
              type="text"
              placeholder="Name this session…"
              value={savingTitle}
              onChange={(e) => setSavingTitle(e.target.value)}
              className="auth-input"
            />
            <button type="button" className="access-notice-btn" onClick={handleSave} disabled={busyId === 'saving'}>
              {busyId === 'saving' ? 'Saving…' : 'Save current work'}
            </button>
          </div>
        )}

        {error && <div className="auth-error">{error}</div>}

        {sessions === null && <p className="access-notice-body">Loading…</p>}
        {sessions?.length === 0 && <p className="access-notice-body">No saved sessions yet.</p>}

        <div className="saved-work-list">
          {(sessions || []).map(s => (
            <div key={s.id} className="saved-work-row">
              <div className="saved-work-row-info">
                <div className="saved-work-row-title">{s.title}</div>
                <div className="saved-work-row-date">{new Date(s.updated_at).toLocaleString()}</div>
              </div>
              <div className="saved-work-row-actions">
                <button type="button" onClick={() => handleLoad(s.id)} disabled={busyId === s.id}>Open</button>
                <button type="button" onClick={() => handleDelete(s.id)} disabled={busyId === s.id} className="saved-work-delete">Delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
