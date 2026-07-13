import { useState, useCallback } from 'react';
import { TOKENS } from './tokens.js';

const C = TOKENS.colors;
const ff = TOKENS.fontFamily;

// ─── Primitive components ──────────────────────────────────────────────────────

function NavBarComp({ props, onBack }) {
  const hasBack = props.leading && typeof props.leading === 'object' && props.leading.type === 'back';
  const backLabel = hasBack ? (props.leading.label || '← Back') : null;
  return (
    <div style={{
      height: 44, display: 'flex', alignItems: 'center',
      padding: '0 16px', background: C.background,
      borderBottom: `0.5px solid ${C.separator}`, flexShrink: 0, position: 'relative',
      fontFamily: ff,
    }}>
      {backLabel && (
        <button onClick={onBack} style={{
          background: 'none', border: 'none', color: C.accent, fontSize: 17,
          cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: 2,
          zIndex: 1,
        }}>
          <span style={{ fontSize: 20, lineHeight: 1 }}>‹</span>
          <span>{backLabel.replace(/^←\s*/, '')}</span>
        </button>
      )}
      <span style={{
        position: 'absolute', left: 0, right: 0, textAlign: 'center',
        fontWeight: 600, fontSize: 17, color: C.label, pointerEvents: 'none',
      }}>
        {props.title || ''}
      </span>
      {props.trailing && props.trailing !== 'none' && (
        <span style={{ marginLeft: 'auto', color: C.accent, fontSize: 17, cursor: 'pointer' }}>
          {props.trailing}
        </span>
      )}
    </div>
  );
}

function TabBarComp({ props, activeTab, onTabChange }) {
  const tabs = Array.isArray(props.tabs) ? props.tabs : [];
  return (
    <div style={{
      height: 49, display: 'flex', background: C.background,
      borderTop: `0.5px solid ${C.separator}`, flexShrink: 0, fontFamily: ff,
    }}>
      {tabs.map((tab, i) => {
        const isActive = activeTab === i;
        return (
          <button key={i} onClick={() => onTabChange(i)} style={{
            flex: 1, border: 'none', background: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', gap: 2, padding: '6px 0',
            color: isActive ? C.accent : C.systemGray,
          }}>
            <span style={{ fontSize: 22 }}>{tab.icon || '○'}</span>
            <span style={{ fontSize: 10, fontWeight: 500 }}>{tab.label || `Tab ${i + 1}`}</span>
          </button>
        );
      })}
      {tabs.length === 0 && [0, 1, 2].map(i => (
        <button key={i} style={{
          flex: 1, border: 'none', background: 'none', cursor: 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 2, padding: '6px 0',
          color: i === 0 ? C.accent : C.systemGray,
        }}>
          <span style={{ fontSize: 22 }}>○</span>
          <span style={{ fontSize: 10, fontWeight: 500 }}>Tab {i + 1}</span>
        </button>
      ))}
    </div>
  );
}

function ButtonComp({ props }) {
  const [pressed, setPressed] = useState(false);
  const variant = props.variant || 'primary';
  const styles = {
    primary: {
      background: pressed ? '#005EC8' : C.accent, color: '#fff',
      border: 'none', borderRadius: TOKENS.radius.sm,
    },
    secondary: {
      background: pressed ? C.systemGray6 : C.background, color: C.accent,
      border: `1.5px solid ${C.accent}`, borderRadius: TOKENS.radius.sm,
    },
    text: {
      background: 'none', color: pressed ? '#005EC8' : C.accent,
      border: 'none', borderRadius: TOKENS.radius.sm,
    },
    destructive: {
      background: pressed ? '#CC2F26' : C.destructive, color: '#fff',
      border: 'none', borderRadius: TOKENS.radius.sm,
    },
  };
  const s = styles[variant] || styles.primary;
  return (
    <button
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      style={{
        ...s, padding: '12px 24px', fontSize: 17, fontWeight: 600,
        cursor: 'pointer', fontFamily: ff, width: '100%', textAlign: 'center',
        transition: `background ${TOKENS.motion.duration}`,
        opacity: pressed ? 0.85 : 1,
      }}>
      {props.label || 'Button'}
    </button>
  );
}

function TextFieldComp({ props }) {
  const [val, setVal] = useState(props.value || '');
  return (
    <div style={{ fontFamily: ff }}>
      {props.label && (
        <div style={{ fontSize: 13, color: C.systemGray, marginBottom: 4, paddingLeft: 4 }}>
          {props.label}
        </div>
      )}
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder={props.placeholder || ''}
        style={{
          width: '100%', padding: '12px 16px', fontSize: 17, fontFamily: ff,
          border: 'none', background: C.systemGray6, borderRadius: TOKENS.radius.sm,
          outline: 'none', color: C.label, boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function SearchBarComp({ props }) {
  const [val, setVal] = useState('');
  return (
    <div style={{ position: 'relative', fontFamily: ff }}>
      <span style={{
        position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
        color: C.systemGray, fontSize: 14,
      }}>🔍</span>
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder={props.placeholder || 'Search'}
        style={{
          width: '100%', padding: '10px 16px 10px 36px', fontSize: 17, fontFamily: ff,
          border: 'none', background: C.systemGray6, borderRadius: TOKENS.radius.sm,
          outline: 'none', color: C.label, boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function ToggleComp({ id, props }) {
  const [on, setOn] = useState(props.value === true);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '12px 0', fontFamily: ff,
    }}>
      <span style={{ fontSize: 17, color: C.label }}>{props.label || 'Toggle'}</span>
      <div
        onClick={() => setOn(v => !v)}
        style={{
          width: 51, height: 31, borderRadius: 16, cursor: 'pointer', flexShrink: 0,
          background: on ? C.success : C.systemGray3,
          transition: `background ${TOKENS.motion.duration}`,
          position: 'relative',
        }}>
        <div style={{
          position: 'absolute', top: 2, left: on ? 22 : 2, width: 27, height: 27,
          borderRadius: '50%', background: '#fff',
          boxShadow: '0 2px 6px rgba(0,0,0,0.3)',
          transition: `left ${TOKENS.motion.duration} ${TOKENS.motion.easing}`,
        }} />
      </div>
    </div>
  );
}

function SliderComp({ id, props }) {
  const [val, setVal] = useState(props.value ?? 50);
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  return (
    <div style={{ padding: '8px 0', fontFamily: ff }}>
      {props.label && (
        <div style={{ fontSize: 13, color: C.systemGray, marginBottom: 6 }}>{props.label}</div>
      )}
      <input
        type="range" min={min} max={max} value={val}
        onChange={e => setVal(Number(e.target.value))}
        style={{ width: '100%', accentColor: C.accent }}
      />
    </div>
  );
}

function SegmentedControlComp({ id, props }) {
  const segments = Array.isArray(props.segments) ? props.segments : ['Segment 1', 'Segment 2'];
  const [active, setActive] = useState(props.selectedIndex ?? 0);
  return (
    <div style={{
      display: 'flex', background: C.systemGray5, borderRadius: TOKENS.radius.sm,
      padding: 2, gap: 2, fontFamily: ff,
    }}>
      {segments.map((seg, i) => (
        <button key={i} onClick={() => setActive(i)} style={{
          flex: 1, padding: '7px 0', fontSize: 13, fontWeight: 500,
          border: 'none', cursor: 'pointer', fontFamily: ff,
          borderRadius: TOKENS.radius.sm - 2,
          background: active === i ? C.background : 'transparent',
          color: C.label,
          boxShadow: active === i ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
          transition: `background ${TOKENS.motion.duration}`,
        }}>
          {seg}
        </button>
      ))}
    </div>
  );
}

function StepperComp({ id, props }) {
  const [val, setVal] = useState(props.value ?? 0);
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const step = props.step ?? 1;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '8px 0', fontFamily: ff,
    }}>
      {props.label && (
        <span style={{ fontSize: 17, color: C.label }}>{props.label}</span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
        <button onClick={() => setVal(v => Math.max(min, v - step))} style={{
          width: 32, height: 32, border: `1px solid ${C.systemGray4}`,
          borderRight: 'none', borderRadius: '8px 0 0 8px', background: C.background,
          color: C.label, fontSize: 20, cursor: 'pointer', fontFamily: ff,
        }}>−</button>
        <div style={{
          width: 44, height: 32, border: `1px solid ${C.systemGray4}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 17, color: C.label, fontFamily: ff,
        }}>
          {val}
        </div>
        <button onClick={() => setVal(v => Math.min(max, v + step))} style={{
          width: 32, height: 32, border: `1px solid ${C.systemGray4}`,
          borderLeft: 'none', borderRadius: '0 8px 8px 0', background: C.background,
          color: C.label, fontSize: 20, cursor: 'pointer', fontFamily: ff,
        }}>+</button>
      </div>
    </div>
  );
}

function BadgeComp({ props }) {
  const color = props.color || C.accent;
  return (
    <span style={{
      background: color, color: '#fff', fontSize: 12, fontWeight: 600,
      padding: '2px 8px', borderRadius: 100, display: 'inline-block', fontFamily: ff,
    }}>
      {props.label || props.value || '1'}
    </span>
  );
}

function ProgressIndicatorComp({ props }) {
  const [prog] = useState(props.value ?? 0.6);
  if (props.style === 'spinner') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: ff }}>
        <div style={{
          width: 20, height: 20, border: `2px solid ${C.systemGray4}`,
          borderTop: `2px solid ${C.accent}`, borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        {props.label && <span style={{ fontSize: 15, color: C.secondaryLabel }}>{props.label}</span>}
      </div>
    );
  }
  return (
    <div style={{ fontFamily: ff }}>
      {props.label && (
        <div style={{ fontSize: 13, color: C.systemGray, marginBottom: 6 }}>{props.label}</div>
      )}
      <div style={{
        height: 4, background: C.systemGray5, borderRadius: 2, overflow: 'hidden',
      }}>
        <div style={{
          height: '100%', width: `${Math.min(1, Math.max(0, prog)) * 100}%`,
          background: C.accent, borderRadius: 2,
          transition: `width ${TOKENS.motion.duration}`,
        }} />
      </div>
    </div>
  );
}

function CardComp({ props, children }) {
  return (
    <div style={{
      background: C.background, borderRadius: TOKENS.radius.card,
      boxShadow: TOKENS.shadow, padding: 16, fontFamily: ff,
    }}>
      {props.title && (
        <div style={{ fontSize: 17, fontWeight: 600, color: C.label, marginBottom: props.body ? 6 : 0 }}>
          {props.title}
        </div>
      )}
      {props.body && (
        <div style={{ fontSize: 15, color: C.secondaryLabel, lineHeight: 1.5 }}>{props.body}</div>
      )}
      {children}
    </div>
  );
}

function SectionComp({ props, children }) {
  return (
    <div style={{ fontFamily: ff }}>
      {props.title && (
        <div style={{
          fontSize: 13, fontWeight: 500, color: C.systemGray, textTransform: 'uppercase',
          letterSpacing: 0.5, padding: '0 16px', marginBottom: 4, marginTop: 20,
        }}>
          {props.title}
        </div>
      )}
      <div style={{ background: C.background, borderRadius: TOKENS.radius.card, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

function ListComp({ children }) {
  return (
    <div style={{ background: C.background, borderRadius: TOKENS.radius.card, overflow: 'hidden', fontFamily: ff }}>
      {children}
    </div>
  );
}

function ListRowComp({ props, isLast }) {
  const [pressed, setPressed] = useState(false);
  return (
    <div
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      style={{
        display: 'flex', alignItems: 'center', padding: '12px 16px',
        background: pressed ? C.systemGray6 : C.background, cursor: 'pointer',
        borderBottom: isLast ? 'none' : `0.5px solid ${C.separator}`,
        transition: `background 0.1s`, fontFamily: ff,
      }}>
      {props.icon && <span style={{ marginRight: 12, fontSize: 20 }}>{props.icon}</span>}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 17, color: C.label }}>{props.label || 'Item'}</div>
        {props.detail && <div style={{ fontSize: 13, color: C.systemGray }}>{props.detail}</div>}
      </div>
      {props.trailing === 'chevron' && (
        <span style={{ color: C.systemGray3, fontSize: 18, marginLeft: 4 }}>›</span>
      )}
      {props.trailing === 'badge' && <BadgeComp props={{ value: props.badgeValue || '1' }} />}
      {props.trailing === 'toggle' && <ToggleComp id={props.id} props={{ value: false }} />}
    </div>
  );
}

function AlertComp({ props }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <div style={{
      position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 100, fontFamily: ff,
    }}>
      <div style={{
        background: 'rgba(242,242,247,0.97)', backdropFilter: 'blur(20px)',
        borderRadius: TOKENS.radius.sheet, width: 270, overflow: 'hidden',
      }}>
        <div style={{ padding: '20px 16px 16px', textAlign: 'center' }}>
          {props.title && (
            <div style={{ fontSize: 17, fontWeight: 600, color: C.label, marginBottom: 6 }}>
              {props.title}
            </div>
          )}
          {props.message && (
            <div style={{ fontSize: 13, color: C.label }}>{props.message}</div>
          )}
        </div>
        <div style={{ borderTop: `0.5px solid ${C.separator}`, display: 'flex' }}>
          {(Array.isArray(props.actions) ? props.actions : [{ label: 'OK' }]).map((action, i, arr) => (
            <button key={i} onClick={() => setVisible(false)} style={{
              flex: 1, padding: '11px 0', background: 'none', border: 'none',
              color: action.destructive ? C.destructive : C.accent,
              fontSize: 17, fontWeight: i === arr.length - 1 ? 600 : 400,
              cursor: 'pointer', fontFamily: ff,
              borderLeft: i > 0 ? `0.5px solid ${C.separator}` : 'none',
            }}>
              {action.label || 'OK'}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ToastComp({ props }) {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <div style={{
      position: 'absolute', bottom: 60, left: '50%', transform: 'translateX(-50%)',
      background: 'rgba(0,0,0,0.75)', color: '#fff', padding: '10px 20px',
      borderRadius: 100, fontSize: 14, fontFamily: ff, whiteSpace: 'nowrap',
      zIndex: 99, cursor: 'pointer',
    }} onClick={() => setVisible(false)}>
      {props.message || 'Done'}
    </div>
  );
}

function SheetComp({ props, children }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} style={{
          background: C.accent, color: '#fff', border: 'none', padding: '10px 20px',
          borderRadius: TOKENS.radius.sm, fontSize: 15, cursor: 'pointer', fontFamily: ff,
        }}>
          {props.triggerLabel || 'Show Sheet'}
        </button>
      )}
      {open && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: C.background, borderRadius: `${TOKENS.radius.sheet}px ${TOKENS.radius.sheet}px 0 0`,
          boxShadow: '0 -4px 32px rgba(0,0,0,0.16)', zIndex: 90, maxHeight: '60%',
          backdropFilter: 'blur(20px)',
        }}>
          <div onClick={() => setOpen(false)} style={{
            width: 36, height: 5, background: C.systemGray4, borderRadius: 3,
            margin: '10px auto 16px', cursor: 'pointer',
          }} />
          {props.title && (
            <div style={{
              fontSize: 17, fontWeight: 600, color: C.label, padding: '0 20px 12px',
              textAlign: 'center', fontFamily: ff,
            }}>
              {props.title}
            </div>
          )}
          <div style={{ padding: '0 20px 20px', overflowY: 'auto' }}>{children}</div>
        </div>
      )}
    </>
  );
}

function AvatarComp({ props }) {
  const size = props.size || 40;
  const initials = props.initials || (props.name ? props.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase() : 'A');
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', background: C.accentLight,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.38, fontWeight: 600, color: C.accent, flexShrink: 0,
      fontFamily: ff,
    }}>
      {initials}
    </div>
  );
}

function ImageComp({ props }) {
  return (
    <div style={{
      width: '100%', height: props.height || 160, background: C.systemGray5,
      borderRadius: TOKENS.radius.card, display: 'flex', alignItems: 'center',
      justifyContent: 'center', color: C.systemGray3, fontSize: 40,
    }}>
      🖼
    </div>
  );
}

function IconComp({ props }) {
  const icons = {
    search: '🔍', home: '🏠', settings: '⚙️', user: '👤', heart: '♥',
    star: '★', plus: '＋', close: '✕', check: '✓', back: '‹',
    share: '⤴', edit: '✎', delete: '🗑', camera: '📷', location: '📍',
    notification: '🔔', message: '💬', phone: '📞', email: '✉',
  };
  const icon = icons[props.name] || props.name || '◻';
  const size = props.size || 24;
  return (
    <span style={{ fontSize: size, color: props.color || C.label, lineHeight: 1 }}>
      {icon}
    </span>
  );
}

// ─── Component dispatcher ─────────────────────────────────────────────────────

function renderComponent(comp, context) {
  const { onNavigate, componentStates, allComponents } = context;
  const p = comp.props || {};
  const id = comp.id;

  switch (comp.type) {
    case 'NavBar': return null; // rendered separately
    case 'TabBar': return null; // rendered separately
    case 'Button': return <ButtonComp key={id} props={p} />;
    case 'TextField': return <TextFieldComp key={id} props={p} />;
    case 'SearchBar': return <SearchBarComp key={id} props={p} />;
    case 'Toggle': return <ToggleComp key={id} id={id} props={p} />;
    case 'Slider': return <SliderComp key={id} id={id} props={p} />;
    case 'SegmentedControl': return <SegmentedControlComp key={id} id={id} props={p} />;
    case 'Stepper': return <StepperComp key={id} id={id} props={p} />;
    case 'Badge': return <BadgeComp key={id} props={p} />;
    case 'ProgressIndicator': return <ProgressIndicatorComp key={id} props={p} />;
    case 'Alert': return <AlertComp key={id} props={p} />;
    case 'Toast': return <ToastComp key={id} props={p} />;
    case 'Avatar': return <AvatarComp key={id} props={p} />;
    case 'Image': return <ImageComp key={id} props={p} />;
    case 'Icon': return <IconComp key={id} props={p} />;

    case 'Card': {
      // Collect nested components if any
      const nested = (p.components || []).map(c => renderComponent(c, context));
      return (
        <CardComp key={id} props={p}>
          {nested.length > 0 ? nested : null}
        </CardComp>
      );
    }

    case 'Section': {
      // Find sibling ListRows / other components that belong in this section
      return <SectionComp key={id} props={p} />;
    }

    case 'List': {
      const rows = (p.rows || []).map((row, i) => (
        <ListRowComp key={row.id || i} props={row} isLast={i === p.rows.length - 1} />
      ));
      return <ListComp key={id}>{rows}</ListComp>;
    }

    case 'ListRow': return <ListRowComp key={id} props={p} isLast={false} />;

    case 'Sheet': {
      return <SheetComp key={id} props={p} />;
    }

    default: return null;
  }
}

// ─── MockupRenderer ───────────────────────────────────────────────────────────

export default function MockupRenderer({ spec }) {
  const [currentScreenId, setCurrentScreenId] = useState(null);
  const [activeTab, setActiveTab] = useState(0);

  if (!spec || !Array.isArray(spec.screens) || spec.screens.length === 0) {
    return (
      <div style={{
        width: 375, height: 667, background: C.secondaryBackground,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: ff, color: C.systemGray, fontSize: 15,
      }}>
        no screen yet
      </div>
    );
  }

  const currentScreen = spec.screens.find(s => s.id === currentScreenId) || spec.screens[0];
  const comps = currentScreen.components || [];

  const navBar = comps.find(c => c.type === 'NavBar');
  const tabBar = comps.find(c => c.type === 'TabBar');
  const bodyComps = comps.filter(c => c.type !== 'NavBar' && c.type !== 'TabBar');
  const alerts = bodyComps.filter(c => c.type === 'Alert' || c.type === 'Toast');
  const mainComps = bodyComps.filter(c => c.type !== 'Alert' && c.type !== 'Toast');

  const handleBack = () => {
    if (navBar?.props?.leading?.target) {
      setCurrentScreenId(navBar.props.leading.target);
    } else {
      setCurrentScreenId(spec.screens[0]?.id || null);
    }
  };

  const context = {
    onNavigate: (screenId) => setCurrentScreenId(screenId),
    allComponents: comps,
    componentStates: {},
  };

  return (
    <div style={{
      width: 375, height: 667, background: C.secondaryBackground,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      position: 'relative', fontFamily: ff,
    }}>
      {/* NavBar */}
      {navBar && <NavBarComp props={navBar.props || {}} onBack={handleBack} />}

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        {mainComps.map((comp, i) => {
          const el = renderComponent(comp, context);
          return el ? <div key={comp.id || i}>{el}</div> : null;
        })}
        {mainComps.length === 0 && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: C.tertiaryLabel, fontSize: 15,
          }}>
            {currentScreen.name || 'Screen'}
          </div>
        )}
      </div>

      {/* TabBar */}
      {tabBar && (
        <TabBarComp
          props={tabBar.props || {}}
          activeTab={activeTab}
          onTabChange={(i) => {
            setActiveTab(i);
            const tabs = tabBar.props?.tabs || [];
            if (tabs[i]?.target) setCurrentScreenId(tabs[i].target);
          }}
        />
      )}

      {/* Alerts / Toasts — float above everything */}
      {alerts.map((comp, i) => renderComponent(comp, context))}

      {/* Spinner keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
