import { useState, useCallback, createContext, useContext } from 'react';
import { TOKENS } from './tokens.js';
import { SvgIcon, hasSvgIcon } from './icons.jsx';

const LIGHT = TOKENS.colors;
const ff = TOKENS.fontFamily;

// iOS dark-mode palette — used when the requested theme background is a dark color.
const DARK = {
  accent: '#0A84FF',
  accentLight: 'rgba(10,132,255,0.24)',
  label: '#FFFFFF',
  secondaryLabel: 'rgba(235,235,245,0.60)',
  tertiaryLabel: 'rgba(235,235,245,0.30)',
  background: '#1C1C1E',          // elevated surfaces (cards, lists, bars)
  secondaryBackground: '#000000', // frame base
  tertiaryBackground: '#2C2C2E',
  separator: 'rgba(84,84,88,0.65)',
  systemGray6: '#1C1C1E',
  systemGray5: '#2C2C2E',
  systemGray4: '#3A3A3C',
  systemGray3: '#48484A',
  systemGray2: '#636366',
  systemGray: '#8E8E93',
  destructive: '#FF453A',
  success: '#30D158',
};

// Palette context — every component reads its surface/text colors from here so a
// dark theme recolors the whole prototype, not just the outer frame.
const PaletteCtx = createContext(LIGHT);
const usePalette = () => useContext(PaletteCtx);

// ─── Theming ───────────────────────────────────────────────────────────────────
// Named colors the model (or user, via speech) can ask for by word.
const NAMED_COLORS = {
  blue: '#007AFF', red: '#FF3B30', orange: '#FF9500', yellow: '#FFCC00',
  green: '#34C759', mint: '#00C7BE', teal: '#30B0C7', cyan: '#32ADE6',
  indigo: '#5856D6', purple: '#AF52DE', violet: '#AF52DE', pink: '#FF2D55',
  brown: '#A2845E', gray: '#8E8E93', grey: '#8E8E93', black: '#000000',
  white: '#FFFFFF', magenta: '#FF2D55', lime: '#34C759', gold: '#FFCC00',
  charcoal: '#1C1C1E', slate: '#2C2C2E', navy: '#1B1F3B',
};

// Resolve a color word or hex/rgb string to a usable CSS color; null if unknown.
function resolveColor(v) {
  if (!v || typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
  if (/^(rgb|hsl)a?\(/.test(s)) return s;
  return NAMED_COLORS[s] || null;
}

// Perceived luminance (0=black, 1=white) of a #rrggbb / #rgb color; ~0.5 if unknown.
function luminance(hex) {
  if (typeof hex !== 'string') return 0.5;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return 0.5;
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// Slightly darker shade for pressed states / gradients
function darken(hex, amt = 0.12) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, ((n >> 16) & 255) * (1 - amt));
  const g = Math.max(0, ((n >> 8) & 255) * (1 - amt));
  const b = Math.max(0, (n & 255) * (1 - amt));
  return `#${((1 << 24) + (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b)).toString(16).slice(1)}`;
}

// Accent color for the whole prototype; components read it unless they override per-component.
const AccentCtx = createContext(LIGHT.accent);
const useAccent = () => useContext(AccentCtx);

// Corner-radius scale — lets a theme go sharper/blockier (e.g. Vercel/Linear) or softer/rounder
// (e.g. Airbnb) than the neutral 8px default. Named presets resolve to a concrete {sm,card,sheet}.
const RADIUS_PRESETS = {
  sharp: { sm: 4, card: 6, sheet: 16 },
  soft: { sm: 8, card: 8, sheet: 20 },
  rounded: { sm: 12, card: 16, sheet: 24 },
  pill: { sm: 100, card: 20, sheet: 28 },
};
function resolveRadius(theme) {
  const named = RADIUS_PRESETS[String(theme?.radius || '').toLowerCase()];
  if (named) return named;
  if (theme?.radius && typeof theme.radius === 'object') {
    return { ...TOKENS.radius, ...theme.radius };
  }
  return TOKENS.radius;
}
const RadiusCtx = createContext(TOKENS.radius);
const useRadius = () => useContext(RadiusCtx);

// ─── Primitive components ──────────────────────────────────────────────────────

function NavBarComp({ props, onBack }) {
  const C = usePalette();
  const accent = useAccent();
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
          background: 'none', border: 'none', color: accent, fontSize: 17,
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
        <span style={{ marginLeft: 'auto', color: accent, fontSize: 17, cursor: 'pointer' }}>
          {props.trailing}
        </span>
      )}
    </div>
  );
}

function TabBarComp({ props, activeTab, onTabChange }) {
  const C = usePalette();
  const accent = useAccent();
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
            color: isActive ? accent : C.systemGray,
          }}>
            {hasSvgIcon(tab.icon)
              ? <SvgIcon name={tab.icon} size={24} color={isActive ? accent : C.systemGray} />
              : <span style={{ fontSize: 22 }}>{tab.icon || '○'}</span>}
            <span style={{ fontSize: 10, fontWeight: 500 }}>{tab.label || `Tab ${i + 1}`}</span>
          </button>
        );
      })}
      {tabs.length === 0 && [0, 1, 2].map(i => (
        <button key={i} style={{
          flex: 1, border: 'none', background: 'none', cursor: 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 2, padding: '6px 0',
          color: i === 0 ? accent : C.systemGray,
        }}>
          <span style={{ fontSize: 22 }}>○</span>
          <span style={{ fontSize: 10, fontWeight: 500 }}>Tab {i + 1}</span>
        </button>
      ))}
    </div>
  );
}

function ButtonComp({ props, onNavigate }) {
  const C = usePalette();
  const R = useRadius();
  const [pressed, setPressed] = useState(false);
  const themeAccent = useAccent();
  const variant = props.variant || 'primary';
  // Per-button color override wins over the global accent
  const tint = resolveColor(props.color) || resolveColor(props.tint) || themeAccent;
  const styles = {
    primary: {
      background: pressed ? darken(tint) : tint, color: '#fff',
      border: 'none', borderRadius: R.sm,
    },
    secondary: {
      background: pressed ? C.systemGray6 : C.background, color: tint,
      border: `1.5px solid ${tint}`, borderRadius: R.sm,
    },
    text: {
      background: 'none', color: pressed ? darken(tint) : tint,
      border: 'none', borderRadius: R.sm,
    },
    destructive: {
      background: pressed ? '#CC2F26' : C.destructive, color: '#fff',
      border: 'none', borderRadius: R.sm,
    },
  };
  const s = styles[variant] || styles.primary;
  return (
    <button
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onClick={() => { if (props.target && onNavigate) onNavigate(props.target); }}
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
  const C = usePalette();
  const R = useRadius();
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
          border: 'none', background: C.systemGray6, borderRadius: R.sm,
          outline: 'none', color: C.label, boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function SearchBarComp({ props }) {
  const C = usePalette();
  const R = useRadius();
  const [val, setVal] = useState('');
  return (
    <div style={{ position: 'relative', fontFamily: ff }}>
      <span style={{
        position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
        display: 'flex', color: C.systemGray,
      }}><SvgIcon name="search" size={15} color={C.systemGray} /></span>
      <input
        value={val}
        onChange={e => setVal(e.target.value)}
        placeholder={props.placeholder || 'Search'}
        style={{
          width: '100%', padding: '10px 16px 10px 36px', fontSize: 17, fontFamily: ff,
          border: 'none', background: C.systemGray6, borderRadius: R.sm,
          outline: 'none', color: C.label, boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function ToggleComp({ id, props }) {
  const C = usePalette();
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
  const C = usePalette();
  const accent = useAccent();
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
        style={{ width: '100%', accentColor: accent }}
      />
    </div>
  );
}

function SegmentedControlComp({ id, props }) {
  const C = usePalette();
  const accent = useAccent();
  // Pill-shaped filter tabs — a fully-rounded track with a solid pill for the active segment,
  // the "pill labels at the top" pattern rather than a flat iOS-style segmented control.
  const segments = Array.isArray(props.segments) ? props.segments : ['Segment 1', 'Segment 2'];
  const [active, setActive] = useState(props.selectedIndex ?? 0);
  return (
    <div style={{
      display: 'flex', background: C.systemGray6, borderRadius: 100,
      padding: 3, gap: 4, fontFamily: ff, width: 'fit-content', maxWidth: '100%', overflowX: 'auto',
    }}>
      {segments.map((seg, i) => (
        <button key={i} onClick={() => setActive(i)} style={{
          padding: '7px 16px', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap',
          border: 'none', cursor: 'pointer', fontFamily: ff,
          borderRadius: 100,
          background: active === i ? accent : 'transparent',
          color: active === i ? '#fff' : C.secondaryLabel,
          transition: `background ${TOKENS.motion.duration}, color ${TOKENS.motion.duration}`,
        }}>
          {seg}
        </button>
      ))}
    </div>
  );
}

function StepperComp({ id, props }) {
  const C = usePalette();
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
  const C = usePalette();
  const accent = useAccent();
  const color = resolveColor(props.color) || accent;
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
  const C = usePalette();
  const accent = useAccent();
  const [prog] = useState(props.value ?? 0.6);
  if (props.style === 'spinner') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: ff }}>
        <div style={{
          width: 20, height: 20, border: `2px solid ${C.systemGray4}`,
          borderTop: `2px solid ${accent}`, borderRadius: '50%',
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
          background: accent, borderRadius: 2,
          transition: `width ${TOKENS.motion.duration}`,
        }} />
      </div>
    </div>
  );
}

function CardComp({ props, children }) {
  const C = usePalette();
  const R = useRadius();
  return (
    <div style={{
      background: C.background, borderRadius: R.card,
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
  const C = usePalette();
  const R = useRadius();
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
      <div style={{ background: C.background, borderRadius: R.card, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}

function ListComp({ children }) {
  const C = usePalette();
  const R = useRadius();
  return (
    <div style={{ background: C.background, borderRadius: R.card, overflow: 'hidden', fontFamily: ff }}>
      {children}
    </div>
  );
}

function ListRowComp({ props, isLast, onNavigate }) {
  const C = usePalette();
  const [pressed, setPressed] = useState(false);
  const accent = useAccent();
  const iconColor = resolveColor(props.iconColor) || accent;
  return (
    <div
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      onClick={() => { if (props.target && onNavigate) onNavigate(props.target); }}
      style={{
        display: 'flex', alignItems: 'center', padding: '12px 16px',
        background: pressed ? C.systemGray6 : C.background, cursor: 'pointer',
        borderBottom: isLast ? 'none' : `0.5px solid ${C.separator}`,
        transition: `background 0.1s`, fontFamily: ff,
      }}>
      {props.image && (
        <img src={props.image} alt="" style={{
          width: 40, height: 40, borderRadius: 8, objectFit: 'cover',
          marginRight: 12, flexShrink: 0,
        }} />
      )}
      {!props.image && props.icon && (
        <span style={{ marginRight: 12, display: 'flex', alignItems: 'center' }}>
          {hasSvgIcon(props.icon)
            ? <SvgIcon name={props.icon} size={22} color={iconColor} />
            : <span style={{ fontSize: 20 }}>{props.icon}</span>}
        </span>
      )}
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
  const C = usePalette();
  const R = useRadius();
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
        borderRadius: R.sheet, width: 270, overflow: 'hidden',
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
  const C = usePalette();
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
  const C = usePalette();
  const R = useRadius();
  const accent = useAccent();
  const [open, setOpen] = useState(true);
  return (
    <>
      {!open && (
        <button onClick={() => setOpen(true)} style={{
          background: accent, color: '#fff', border: 'none', padding: '10px 20px',
          borderRadius: R.sm, fontSize: 15, cursor: 'pointer', fontFamily: ff,
        }}>
          {props.triggerLabel || 'Show Sheet'}
        </button>
      )}
      {open && (
        <div style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          background: C.background, borderRadius: `${R.sheet}px ${R.sheet}px 0 0`,
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
  const C = usePalette();
  const size = props.size || 40;
  const src = props.src || props.image;
  if (typeof src === 'string' && /^(https?:|data:|blob:)/.test(src)) {
    return (
      <img src={src} alt={props.name || ''} style={{
        width: size, height: size, borderRadius: '50%', objectFit: 'cover',
        flexShrink: 0,
      }} />
    );
  }
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

// Deterministic gradient so "album art" style images look designed, not random
function gradientFor(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h},70%,58%), hsl(${(h + 55) % 360},68%,48%))`;
}

function ImageComp({ props }) {
  const R = useRadius();
  const height = props.height || 160;
  const radius = props.radius ?? R.card;
  const base = {
    width: '100%', height, borderRadius: radius, display: 'block',
    objectFit: 'cover', flexShrink: 0,
  };

  // 1. Explicit URL (http/https or inline SVG/data URI) — render it directly
  if (typeof props.src === 'string' && /^(https?:|data:|blob:)/.test(props.src)) {
    return <img src={props.src} alt={props.alt || ''} style={base} />;
  }

  // 2. Raw inline SVG markup provided by the model
  if (typeof props.svg === 'string' && props.svg.trim().startsWith('<svg')) {
    return (
      <div
        style={{ ...base, overflow: 'hidden' }}
        dangerouslySetInnerHTML={{ __html: props.svg }}
      />
    );
  }

  const query = (props.query || props.alt || props.label || '').trim();

  // 3. Gradient tile (album art / cover style)
  if (props.style === 'gradient' || props.kind === 'album') {
    return (
      <div style={{
        ...base, background: gradientFor(query || 'buddy'),
        display: 'flex', alignItems: 'flex-end', padding: 14, boxSizing: 'border-box',
        color: '#fff', fontFamily: ff, fontWeight: 600, fontSize: 17,
        textShadow: '0 1px 3px rgba(0,0,0,0.35)',
      }}>
        {props.label || ''}
      </div>
    );
  }

  // 4. Real photo — deterministic by keyword so it stays stable across re-renders
  if (query) {
    const seed = encodeURIComponent(query.toLowerCase().replace(/\s+/g, '-'));
    return (
      <img
        src={`https://picsum.photos/seed/${seed}/600/${Math.round(height * 1.6)}`}
        alt={query}
        style={base}
        onError={(e) => { e.currentTarget.style.display = 'none'; }}
      />
    );
  }

  // 5. Fallback gradient
  return <div style={{ ...base, background: gradientFor('buddy') }} />;
}

function IconComp({ props }) {
  const accent = useAccent();
  const size = props.size || 24;
  const color = resolveColor(props.color) || accent;
  if (hasSvgIcon(props.name)) {
    return <SvgIcon name={props.name} size={size} color={color} />;
  }
  // Fall back to any emoji/glyph the model supplied, else a neutral box
  return (
    <span style={{ fontSize: size, color, lineHeight: 1 }}>
      {props.name || '◻'}
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
    case 'Button': return <ButtonComp key={id} props={p} onNavigate={onNavigate} />;
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
        <ListRowComp key={row.id || i} props={row} isLast={i === p.rows.length - 1} onNavigate={onNavigate} />
      ));
      return <ListComp key={id}>{rows}</ListComp>;
    }

    case 'ListRow': return <ListRowComp key={id} props={p} isLast={false} onNavigate={onNavigate} />;

    case 'Sheet': {
      return <SheetComp key={id} props={p} />;
    }

    default: return null;
  }
}

// Desktop/web top navigation bar — logo on the left, horizontal links on the right.
function WebTopBar({ title, links, activeIdx, onNav }) {
  const C = usePalette();
  const accent = useAccent();
  return (
    <div style={{
      height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 32px', background: C.background,
      borderBottom: `1px solid ${C.separator}`, flexShrink: 0, fontFamily: ff,
    }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.label, letterSpacing: '-0.02em' }}>
        {title || 'Home'}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 28 }}>
        {(links || []).map((link, i) => (
          <button key={i} onClick={() => onNav(i, link.target)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontFamily: ff,
            fontSize: 15, fontWeight: activeIdx === i ? 600 : 500,
            color: activeIdx === i ? accent : C.secondaryLabel, padding: 0,
          }}>
            {link.label || `Link ${i + 1}`}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── MockupRenderer ───────────────────────────────────────────────────────────
// Renders a spec into an interactive frame — a 375×667 iOS phone, or a wider
// desktop browser when spec.platform is "web"/"desktop" — with a themeable accent.

export default function MockupRenderer({ spec, activeScreenId, onScreenChange }) {
  // Uncontrolled by default (used standalone, e.g. in export); controlled when a
  // parent (the flowchart view) wants to drive which screen is showing.
  const [internalScreenId, setInternalScreenId] = useState(null);
  const isControlled = activeScreenId !== undefined;
  const currentScreenId = isControlled ? activeScreenId : internalScreenId;
  const setCurrentScreenId = isControlled ? (onScreenChange || (() => {})) : setInternalScreenId;
  const [activeTab, setActiveTab] = useState(0);

  if (!spec || !Array.isArray(spec.screens) || spec.screens.length === 0) {
    return (
      <div style={{
        width: 375, height: 667, background: LIGHT.secondaryBackground,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: ff, color: LIGHT.systemGray, fontSize: 15,
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

  // Safety net: a drill-down screen (reached by tapping into something, not by a tab)
  // always gets a way back, even if the model forgot to add a NavBar or a back target.
  // Screens reachable via the TabBar don't need this — switching tabs IS the navigation,
  // so forcing a back button there is redundant top-bar clutter.
  const isEntryScreen = currentScreen.id === spec.screens[0]?.id;
  const isTabDestination = spec.screens.some(s =>
    (s.components || []).some(c => c.type === 'TabBar' && (c.props?.tabs || []).some(t => t.target === currentScreen.id))
  );
  const needsBackSafetyNet = !isEntryScreen && !isTabDestination;
  const effectiveNavBar = navBar || (needsBackSafetyNet ? {
    props: { title: currentScreen.name || '', leading: { type: 'back', label: 'Back' } },
  } : null);

  const context = {
    onNavigate: (screenId) => setCurrentScreenId(screenId),
    allComponents: comps,
    componentStates: {},
  };

  // Resolve theme. A dark background (or explicit mode:"dark") swaps the whole palette so
  // cards, rows, bars, and text recolor too — not just the outer frame.
  const theme = spec.theme || {};
  const requestedBg = resolveColor(theme.background);
  const explicitMode = String(theme.mode || theme.scheme || '').toLowerCase();
  const isDark = explicitMode === 'dark'
    || (explicitMode !== 'light' && requestedBg != null && luminance(requestedBg) < 0.5);
  const C = isDark ? DARK : LIGHT;

  const accent = resolveColor(theme.accent) || resolveColor(theme.tint)
    || resolveColor(theme.primary) || resolveColor(spec.accent) || C.accent;
  const bg = requestedBg || C.secondaryBackground;
  const radius = resolveRadius(theme);

  // Form factor: phone (default) vs. desktop browser
  const isWeb = ['web', 'website', 'desktop', 'browser'].includes(
    String(spec.platform || spec.formFactor || '').toLowerCase()
  );
  const W = isWeb ? 880 : 375;
  const H = isWeb ? 560 : 667;

  const body = (
    <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', flexDirection: 'column',
        gap: isWeb ? 20 : 12,
        padding: isWeb ? '32px 0' : 16,
        width: '100%', maxWidth: isWeb ? 760 : 'none',
        margin: isWeb ? '0 auto' : 0, boxSizing: 'border-box',
        paddingLeft: isWeb ? 32 : 16, paddingRight: isWeb ? 32 : 16,
      }}>
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
    </div>
  );

  // On web, the tab bar's tabs become top-nav links (or navBar.props.links).
  // Same safety net as mobile: a drill-down page (not reachable via the nav links
  // themselves) always gets a way back.
  const webLinksBase = (navBar?.props?.links) || (tabBar?.props?.tabs) || [];
  const webNeedsBackLink = needsBackSafetyNet && !webLinksBase.some(l => l.target === spec.screens[0]?.id);
  const webLinks = webNeedsBackLink
    ? [{ label: '← Back', target: navBar?.props?.leading?.target || spec.screens[0]?.id }, ...webLinksBase]
    : webLinksBase;

  return (
   <PaletteCtx.Provider value={C}>
    <AccentCtx.Provider value={accent}>
    <RadiusCtx.Provider value={radius}>
    <div style={{
      width: W, height: H, background: bg,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
      position: 'relative', fontFamily: ff,
    }}>
      {isWeb ? (
        <>
          <WebTopBar
            title={navBar?.props?.title || currentScreen.name}
            links={webLinks}
            activeIdx={activeTab}
            onNav={(i, target) => { setActiveTab(i); if (target) setCurrentScreenId(target); }}
          />
          {body}
        </>
      ) : (
        <>
          {effectiveNavBar && <NavBarComp props={effectiveNavBar.props || {}} onBack={handleBack} />}
          {body}
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
        </>
      )}

      {/* Alerts / Toasts — float above everything */}
      {alerts.map((comp, i) => renderComponent(comp, context))}

      {/* Spinner keyframe */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
    </RadiusCtx.Provider>
    </AccentCtx.Provider>
   </PaletteCtx.Provider>
  );
}
