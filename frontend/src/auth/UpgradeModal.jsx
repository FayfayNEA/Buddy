import { useState } from 'react';
import { useEscapeToClose } from './useEscapeToClose';

/**
 * Shown when a signed-in user runs out of free generations, or when they click Upgrade.
 * `reason` is the message from the backend's 402 (or null when opened voluntarily).
 */
export default function UpgradeModal({ auth, reason, onClose }) {
  useEscapeToClose(onClose);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const go = async () => {
    setBusy(true);
    setError('');
    const err = await auth.startCheckout();
    if (err) { setError(err); setBusy(false); }
    // On success the browser redirects to Stripe, so nothing to do here.
  };

  return (
    <div className="access-notice-backdrop" onClick={onClose}>
      <div className="access-notice-card" onClick={(e) => e.stopPropagation()}>
        <h2 className="access-notice-title">Go unlimited</h2>
        {reason && <p className="upgrade-reason">{reason}</p>}
        <p className="access-notice-body">
          Unlimited generations and unlimited video, for $10/month. Cancel any time.
        </p>
        <ul className="upgrade-perks">
          <li>Unlimited image, mockup and flow generations</li>
          <li>Unlimited video generations</li>
          <li>Keep saving your work to your account</li>
        </ul>
        {error && <div className="auth-error">{error}</div>}
        <button type="button" className="access-notice-btn" onClick={go} disabled={busy}>
          {busy ? 'Opening checkout…' : 'Upgrade, $10/month'}
        </button>
        <button type="button" className="auth-switch-link" onClick={onClose}>
          Not now
        </button>
      </div>
    </div>
  );
}
