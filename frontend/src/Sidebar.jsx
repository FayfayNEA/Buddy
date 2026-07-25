import { Mail, X } from 'lucide-react';

export default function Sidebar({
  open,
  onClose,
  auth,
  contactEmail,
  onOpenSavedWork,
  onOpenUpgrade,
  onOpenPortal,
  onSignOut,
  onSignUp,
}) {
  return (
    <>
      <div
        className={`app-sidebar-backdrop${open ? ' app-sidebar-backdrop--open' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div className={`app-sidebar${open ? ' app-sidebar--open' : ''}`}>
        <div className="app-sidebar-header">
          <img src="/images/buddyname.svg" alt="Buddy" className="app-sidebar-logo" />
          <button type="button" className="app-sidebar-close" onClick={onClose} aria-label="Close menu">
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        <nav className="app-sidebar-nav">
          {auth.user ? (
            <>
              <button type="button" className="app-sidebar-link" onClick={() => { onOpenSavedWork(); onClose(); }}>
                My work
              </button>
              {auth.user.is_paid ? (
                <button type="button" className="app-sidebar-link" onClick={() => { onOpenPortal(); onClose(); }}>
                  ✦ Pro — manage subscription
                </button>
              ) : auth.user.billing_enabled ? (
                <button type="button" className="app-sidebar-link" onClick={() => { onOpenUpgrade(); onClose(); }}>
                  Upgrade
                </button>
              ) : null}
              <button type="button" className="app-sidebar-link app-sidebar-link--muted" onClick={() => { onSignOut(); onClose(); }}>
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
