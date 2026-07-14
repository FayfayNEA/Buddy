import { useState, useRef, useEffect, useCallback } from 'react';
import { TOKENS } from './tokens.js';

const ff = TOKENS.fontFamily;
const NODE_W = 168;
const NODE_H = 58;
const RANK_GAP = 220;
const ROW_GAP = 96;

// Walk a screen's components (including nested Card children and List rows) and
// collect every navigation edge: NavBar back-target, TabBar tabs, Button/ListRow targets.
function collectEdges(screens) {
  const edges = [];
  for (const screen of screens) {
    const comps = screen.components || [];
    const navBar = comps.find(c => c.type === 'NavBar');
    if (navBar?.props?.leading?.target) {
      edges.push({ from: screen.id, to: navBar.props.leading.target, kind: 'back' });
    }
    const tabBar = comps.find(c => c.type === 'TabBar');
    for (const tab of tabBar?.props?.tabs || []) {
      if (tab.target) edges.push({ from: screen.id, to: tab.target, kind: 'tab' });
    }
    const walk = (list) => {
      for (const c of list || []) {
        if ((c.type === 'Button' || c.type === 'ListRow') && c.props?.target) {
          edges.push({ from: screen.id, to: c.props.target, kind: 'action', ref: c });
        }
        if (c.type === 'List') {
          for (const row of c.props?.rows || []) {
            if (row.target) edges.push({ from: screen.id, to: row.target, kind: 'action', ref: row });
          }
        }
        if (c.type === 'Card' && Array.isArray(c.props?.components)) walk(c.props.components);
      }
    };
    walk(comps);
  }
  return edges;
}

// Rank screens by BFS distance from the first screen so the flow reads left-to-right.
function rankScreens(screens, edges) {
  const adjacency = {};
  screens.forEach(s => { adjacency[s.id] = []; });
  edges.forEach(e => { if (adjacency[e.from] && e.kind !== 'back') adjacency[e.from].push(e.to); });

  const rank = {};
  const queue = screens[0] ? [[screens[0].id, 0]] : [];
  const seen = new Set();
  while (queue.length) {
    const [id, r] = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    rank[id] = r;
    for (const next of adjacency[id] || []) if (!seen.has(next)) queue.push([next, r + 1]);
  }
  let maxRank = Math.max(0, ...Object.values(rank));
  screens.forEach(s => { if (rank[s.id] === undefined) rank[s.id] = ++maxRank; });
  return rank;
}

export default function FlowChart({ spec, activeScreenId, onSelectScreen, onRewire }) {
  const [positions, setPositions] = useState({});
  const [tempLine, setTempLine] = useState(null); // {fromId, x, y} — connector being dragged
  const [hoverTarget, setHoverTarget] = useState(null);
  const hoverTargetRef = useRef(null); // live value for the pointerup handler (state would be stale there)
  const containerRef = useRef(null);
  const dragRef = useRef(null); // {type:'move'|'rewire', screenId, dx, dy}

  const screens = spec?.screens || [];
  const edges = collectEdges(screens);

  // Auto-place any screen that doesn't have a position yet (new from voice, or first render).
  // Never overwrites a position the user already dragged.
  useEffect(() => {
    const rank = rankScreens(screens, edges);
    const rankCounts = {};
    setPositions(prev => {
      let changed = false;
      const next = { ...prev };
      for (const s of screens) {
        if (next[s.id]) continue;
        const r = rank[s.id] || 0;
        const yi = rankCounts[r] || 0;
        rankCounts[r] = yi + 1;
        next[s.id] = { x: 24 + r * RANK_GAP, y: 24 + yi * ROW_GAP };
        changed = true;
      }
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screens.map(s => s.id).join(',')]);

  const getPos = (id) => positions[id] || { x: 24, y: 24 };

  const onNodePointerDown = useCallback((e, screenId, mode) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = containerRef.current.getBoundingClientRect();
    if (mode === 'move') {
      const p = getPos(screenId);
      dragRef.current = {
        type: 'move', screenId,
        offX: e.clientX - rect.left - p.x,
        offY: e.clientY - rect.top - p.y,
      };
    } else {
      dragRef.current = { type: 'rewire', screenId };
      const p = getPos(screenId);
      setTempLine({ fromId: screenId, x: p.x + NODE_W, y: p.y + NODE_H / 2 });
    }

    const onMove = (ev) => {
      const r = containerRef.current.getBoundingClientRect();
      if (dragRef.current?.type === 'move') {
        const { screenId: sid, offX, offY } = dragRef.current;
        setPositions(prev => ({
          ...prev,
          [sid]: { x: Math.max(0, ev.clientX - r.left - offX), y: Math.max(0, ev.clientY - r.top - offY) },
        }));
      } else if (dragRef.current?.type === 'rewire') {
        const x = ev.clientX - r.left;
        const y = ev.clientY - r.top;
        setTempLine(prev => prev ? { ...prev, x, y } : prev);
        // Find which node (if any) is under the cursor
        const under = screens.find(s => {
          const p = getPos(s.id);
          return x >= p.x && x <= p.x + NODE_W && y >= p.y && y <= p.y + NODE_H;
        });
        const nextHover = under && under.id !== screenId ? under.id : null;
        hoverTargetRef.current = nextHover;
        setHoverTarget(nextHover);
      }
    };

    const onUp = () => {
      if (dragRef.current?.type === 'rewire') {
        const fromId = dragRef.current.screenId;
        const target = hoverTargetRef.current;
        if (target && target !== fromId) {
          onRewire?.(fromId, target);
        }
      }
      setTempLine(null);
      setHoverTarget(null);
      hoverTargetRef.current = null;
      dragRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [positions, hoverTarget, screens, onRewire]);

  if (!screens.length) {
    return (
      <div style={{
        padding: 20, color: '#8E8E93', fontSize: 13, fontFamily: ff, textAlign: 'center',
      }}>
        speak your app's screens and the flow builds itself here
      </div>
    );
  }

  const maxX = Math.max(400, ...screens.map(s => getPos(s.id).x + NODE_W + 40));
  const maxY = Math.max(200, ...screens.map(s => getPos(s.id).y + NODE_H + 40));

  return (
    <div
      ref={containerRef}
      className="flowchart-canvas"
      style={{ position: 'relative', width: '100%', height: maxY, minWidth: maxX, fontFamily: ff }}
    >
      <svg width={maxX} height={maxY} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <defs>
          <marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="var(--purple-border, #9b8afb)" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const from = getPos(e.from);
          const to = getPos(e.to);
          if (!positions[e.from] || !positions[e.to]) return null;
          const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
          const x2 = to.x, y2 = to.y + NODE_H / 2;
          const midX = (x1 + x2) / 2;
          return (
            <path
              key={i}
              d={`M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`}
              fill="none"
              stroke={e.kind === 'back' ? '#C7C7CC' : 'var(--purple-border, #9b8afb)'}
              strokeWidth={2}
              strokeDasharray={e.kind === 'back' ? '4 4' : 'none'}
              markerEnd="url(#flow-arrow)"
            />
          );
        })}
        {tempLine && (() => {
          const from = getPos(tempLine.fromId);
          const x1 = from.x + NODE_W, y1 = from.y + NODE_H / 2;
          return (
            <line x1={x1} y1={y1} x2={tempLine.x} y2={tempLine.y}
              stroke="#7c5cfc" strokeWidth={2} strokeDasharray="3 3" />
          );
        })()}
      </svg>

      {screens.map(screen => {
        const p = getPos(screen.id);
        const isActive = screen.id === activeScreenId;
        const isHoverTarget = screen.id === hoverTarget;
        return (
          <div
            key={screen.id}
            onPointerDown={(e) => onNodePointerDown(e, screen.id, 'move')}
            onClick={() => onSelectScreen?.(screen.id)}
            style={{
              position: 'absolute', left: p.x, top: p.y, width: NODE_W, height: NODE_H,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 14px', textAlign: 'center', boxSizing: 'border-box',
              borderRadius: 12, cursor: 'grab', userSelect: 'none',
              background: isActive ? 'var(--purple-light, #ece7fd)' : 'var(--bg-elevated, #fff)',
              border: `1.5px solid ${isHoverTarget ? '#7c5cfc' : isActive ? 'var(--purple-border, #9b8afb)' : 'var(--border, #e5e5ea)'}`,
              boxShadow: isHoverTarget ? '0 0 0 3px rgba(124,92,252,0.25)' : '0 1px 4px rgba(0,0,0,0.06)',
              fontSize: 13, fontWeight: 600, color: 'var(--text, #1c1c1e)',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            title="Drag to move · click to view · drag from the dot to rewire"
          >
            {screen.name || screen.id}
            {/* Connector handle — drag from here onto another node to rewire this screen's flow */}
            <div
              onPointerDown={(e) => onNodePointerDown(e, screen.id, 'rewire')}
              style={{
                position: 'absolute', right: -7, top: '50%', transform: 'translateY(-50%)',
                width: 14, height: 14, borderRadius: '50%',
                background: '#7c5cfc', border: '2px solid var(--bg-elevated, #fff)',
                cursor: 'crosshair',
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
