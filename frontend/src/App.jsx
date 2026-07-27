import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import axios from 'axios';
import RecordRTC from 'recordrtc';
import { ChevronLeft, ChevronRight, RotateCcw, Menu } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import mermaid from 'mermaid';
import MockupRenderer from './mockup/MockupRenderer';
import FlipCard from './mockup/FlipCard';
import FlowChart from './mockup/FlowChart';
import MockupErrorBoundary from './mockup/ErrorBoundary';
import { useAuth } from './auth/useAuth';
import UpgradeModal from './auth/UpgradeModal';
import LoginGate from './auth/LoginGate';
import Sidebar from './Sidebar';

mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  securityLevel: 'loose',
  flowchart: { useMaxWidth: true },
  pie: { useMaxWidth: true },
  xychart: { width: 800, height: 500 },
  themeVariables: { fontSize: '18px' },
});

// Map high-level status text to badge image assets — the buddy state indicator, bottom-left
const STATUS_IMAGES = {
  'Idle': '/images/Off.svg',
  'Hearing': '/images/listening.svg',
  'Listening': '/images/listening.svg',
  'Waiting': '/images/waiting.svg',
  'Processing': '/images/generating.svg',
  'Generating': '/images/generating.svg',
  'Failed': '/images/generating.svg',
  'Zipping': '/images/generating.svg',
  'Done': '/images/generated.svg',
  'Saved!': '/images/generated.svg',
  default: '/images/Off.svg',
};

const STATUS_COLORS = {
  Idle: '#374151',
  Hearing: '#dc2626',
  Listening: '#dc2626',
  Waiting: '#2563eb',
  Processing: '#ea580c',
  Generating: '#ea580c',
  Failed: '#ea580c',
  Zipping: '#ea580c',
  Done: '#16a34a',
  'Saved!': '#16a34a',
  default: '#374151',
};

const API_BASE = (
  import.meta.env.VITE_API_URL
  || (import.meta.env.DEV ? window.location.origin : 'http://localhost:8000')
).replace(/\/$/, '');
const CONTACT_EMAIL = (import.meta.env.VITE_CONTACT_EMAIL || 'failennaselta@gmail.com').trim();
const DEMO_TOKEN_KEY = 'buddy_demo_token';
const DEMO_REMAINING_KEY = 'buddy_demo_remaining';
const DEMO_RESET_VERSION_KEY = 'buddy_demo_reset_version';
// Bump this whenever demo state should start fresh for everyone (new demo period,
// limit changed, etc.) — avoids ever needing someone to manually clear localStorage again.
const DEMO_RESET_VERSION = '2026-07-16-v4';
const DEMO_LIMIT = 5;
const WALKTHROUGH_KEY = 'buddy_walkthrough_done';

const WALKTHROUGH_STEPS = [
  {
    num: '01',
    title: 'Meet Buddy',
    body: "Your AI design partner. Speak an idea and Buddy turns it into a diagram, a sketch, or a UI mockup in real time.",
    cardStyle: { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' },
  },
  {
    num: '02',
    title: 'Status indicator',
    body: 'This tells you what Buddy is doing. It cycles through Idle, Hearing, Listening, Generating, and Done as you work.',
    cardStyle: { bottom: '18%', left: '4%' },
  },
  {
    num: '03',
    title: 'Export & reset',
    body: 'Export your session as a ZIP with a PDF summary, or hit reset to clear the canvas and start fresh.',
    cardStyle: { top: '100px', right: '4%' },
  },
  {
    num: '04',
    title: 'Start Vibing',
    body: `Hit this button and describe anything out loud. You get ${DEMO_LIMIT} free generations to try it out.`,
    cardStyle: { bottom: '18%', left: '50%', transform: 'translateX(-50%)' },
  },
  {
    num: '05',
    title: 'Your canvas',
    body: 'Whatever you speak appears here as a diagram, sketch, or mockup, ready to refine with your next sentence.',
    cardStyle: { top: '112px', left: '50%', transform: 'translateX(-50%)' },
  },
];

const SPEAKER_COLORS = ['#7c5cfc', '#0891b2', '#d97706', '#16a34a', '#dc2626', '#9333ea'];

// Find the dominant vocal frequency (85–400 Hz) in FFT data.
function detectDominantPitch(analyser, sampleRate) {
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Float32Array(bufferLength);
  analyser.getFloatFrequencyData(dataArray);
  const binSize = sampleRate / (2 * bufferLength);
  const minBin = Math.max(1, Math.floor(85 / binSize));
  const maxBin = Math.min(bufferLength - 1, Math.floor(400 / binSize));
  let maxVal = -Infinity;
  let maxBinIdx = minBin;
  for (let i = minBin; i <= maxBin; i++) {
    if (dataArray[i] > maxVal) { maxVal = dataArray[i]; maxBinIdx = i; }
  }
  if (maxVal < -65) return null;
  return maxBinIdx * binSize;
}

// Map median pitch for a 5-second window to one of N speaker lanes.
function assignSpeaker(pitchSamples, count) {
  if (count <= 1 || pitchSamples.length === 0) return 0;
  const sorted = [...pitchSamples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const MIN = 85, MAX = 400;
  const clamped = Math.max(MIN, Math.min(MAX - 1, median));
  const bucket = Math.floor((clamped - MIN) / (MAX - MIN) * count);
  return Math.min(bucket, count - 1);
}

// Mobile Safari / Android often reject exact sampleRate/channelCount constraints with
// OverconstrainedError — fall back until something works.
async function getMicStream() {
  const attempts = [
    { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } },
    { audio: true },
  ];
  let lastErr;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Microphone unavailable');
}

// StereoAudioRecorder captures through an AudioContext RecordRTC owns itself
// (RecordRTC.Storage.AudioContextConstructor) and never resumes. We build the recorder
// after awaiting getUserMedia — i.e. off the click gesture — so on iOS that context is
// born suspended, onaudioprocess never fires, and every chunk comes back as a header-only
// WAV that the size gate drops. destroy() also closes it, so a fresh suspended context
// appears on every cut. Resuming after each construction is what makes mobile record.
function newAudioRecorder(stream) {
  const recorder = new RecordRTC(stream, {
    type: 'audio', mimeType: 'audio/wav',
    recorderType: RecordRTC.StereoAudioRecorder, numberOfAudioChannels: 1,
  });
  const ctx = RecordRTC.Storage?.AudioContextConstructor;
  if (ctx?.state === 'suspended') ctx.resume().catch(() => { /* best effort */ });
  return recorder;
}

// Fal CDN serves media with CSP: sandbox which breaks <img>/<video> hotlinking on some
// mobile browsers. Prefer a backend proxy (strips CSP), then a blob URL, then the raw CDN URL.
function proxiedMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (/^https:\/\/([a-z0-9-]+\.)*(fal\.media|fal\.ai)\//i.test(url)) {
    return `${API_BASE}/media-proxy?url=${encodeURIComponent(url)}`;
  }
  return url;
}

async function materializeMediaUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('blob:') || url.startsWith('data:')) return url;
  const candidates = [];
  const proxied = proxiedMediaUrl(url);
  if (proxied !== url) candidates.push(proxied);
  candidates.push(url);
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob || blob.size < 32) continue;
      return URL.createObjectURL(blob);
    } catch {
      /* try next */
    }
  }
  // Prefer proxy for display when available; SpeakerPanel falls back to raw on error.
  return proxied !== url ? proxied : url;
}

function micErrorMessage(err) {
  const name = err?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission blocked, allow mic access and try again';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone found';
  }
  if (name === 'SecurityError') {
    return 'Microphone needs HTTPS (or localhost)';
  }
  return 'Could not start the microphone';
}

// ─── Liquid vibe button ───────────────────────────────────────────────────────
function LiquidButton({ active, onClick, demoComplete }) {
  return (
    <button
      type="button"
      onClick={demoComplete ? undefined : onClick}
      disabled={demoComplete}
      className={
        `liquid-btn inline-flex items-center justify-center rounded-full px-6 py-2.5 w-[640px] h-[60px]` +
        (active ? ' liquid-btn--active' : '') +
        (demoComplete ? ' opacity-40 cursor-not-allowed' : '')
      }
    >
      <span className="select-none">
        {demoComplete ? 'Demo Complete' : active ? 'Stop Vibing' : 'Start Vibing'}
      </span>
    </button>
  );
}

// ─── Participant selector ─────────────────────────────────────────────────────
function ParticipantSelector({ onSelect }) {
  const [selected, setSelected] = useState(2);
  return (
    <motion.div
      className="participant-selector"
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: 'easeOut' }}
    >
      <img src="/images/buddyname.svg" alt="Buddy" className="participant-logo" />
      <h2 className="participant-heading">How many minds are in the room?</h2>
      <div className="participant-nums">
        {[1, 2, 3, 4, 5, 6].map(n => (
          <button
            key={n}
            className={`participant-num-btn${selected === n ? ' participant-num-btn--active' : ''}`}
            onClick={() => setSelected(n)}
          >
            {n}
          </button>
        ))}
      </div>
      <button className="participant-enter-btn" onClick={() => onSelect(selected)}>
        Enter
      </button>
    </motion.div>
  );
}

function EmptyBlobs({ blobPos }) {
  if (!blobPos) return null;
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, transform: `translate(${blobPos[0].x * 200}px,${blobPos[0].y * 150}px)` }}><div className="blob blob-1" /></div>
      <div style={{ position: 'absolute', inset: 0, transform: `translate(${blobPos[1].x * 150}px,${blobPos[1].y * 110}px)` }}><div className="blob blob-2" /></div>
      <div style={{ position: 'absolute', inset: 0, transform: `translate(${blobPos[2].x * 260}px,${blobPos[2].y * 190}px)` }}><div className="blob blob-3" /></div>
    </>
  );
}

// ─── Single speaker panel ─────────────────────────────────────────────────────
function SpeakerPanel({ index, count, history, currentIndex, onPrev, onNext, status, isGenerating, blobPos, isMerged, vibeMode, isActiveSpeaker, onClaim, isVideoMode }) {
  const mermaidNodeRef = useRef(null);
  const [imgError, setImgError] = useState(false);
  const [mediaSrc, setMediaSrc] = useState(null);
  const blobUrlRef = useRef(null);
  const currentItem = history[currentIndex];
  const color = isMerged ? null : SPEAKER_COLORS[index % SPEAKER_COLORS.length];
  const isActive = isGenerating || status === 'Hearing';

  useEffect(() => {
    setImgError(false);
    let cancelled = false;
    const raw = currentItem?.video_url || currentItem?.image_url || null;

    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
    // Start with the raw CDN URL so desktop keeps working even before /media-proxy is deployed.
    setMediaSrc(raw);

    if (!raw || currentItem?.mode === 'DIAGRAM') return undefined;

    materializeMediaUrl(raw).then((src) => {
      if (cancelled) {
        if (src && src.startsWith('blob:') && src !== raw) URL.revokeObjectURL(src);
        return;
      }
      if (src && src.startsWith('blob:') && src !== raw) blobUrlRef.current = src;
      setMediaSrc(src || raw);
    });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [currentIndex, currentItem?.image_url, currentItem?.video_url, currentItem?.mode]);

  const handleMediaError = (event) => {
    const raw = currentItem?.video_url || currentItem?.image_url;
    const el = event?.currentTarget;
    if (raw && el && el.dataset.fallback !== '1' && el.src !== raw) {
      el.dataset.fallback = '1';
      el.src = raw;
      return;
    }
    setImgError(true);
  };

  const runMermaid = (el, code) => {
    if (!el || !code) return;
    if (el.getAttribute('data-processed')) return;
    const clean = code.replace(/```mermaid/g, '').replace(/```/g, '').trim();
    if (!clean) return;
    el.innerHTML = clean;
    el.removeAttribute('data-processed');
    mermaid.run({ nodes: [el], suppressErrors: false }).catch(err => {
      el.innerHTML = `<div style="color:red;padding:20px;text-align:center">⚠️ ${err.message}</div>`;
    });
  };

  const setMermaidRef = (el) => {
    mermaidNodeRef.current = el;
    if (el && currentItem?.mode === 'DIAGRAM' && currentItem?.diagram_code) {
      runMermaid(el, currentItem.diagram_code);
    }
  };

  const showLabel = isMerged || count > 1;

  return (
    <div className="speaker-panel">
      {showLabel && (
        <div className={`speaker-label${isMerged ? ' speaker-label--merged' : ''}${isActiveSpeaker ? ' speaker-label--claimed' : ''}`}>
          {!isMerged && <span className="speaker-label-dot" style={{ background: color }} />}
          {isMerged
            ? <span className="speaker-label-text speaker-label-text--merged">Shared Vision</span>
            : <span className="speaker-label-text">Mind {index + 1}</span>
          }
          {isActive && <span className="speaker-active-dot" style={isMerged ? {} : { background: color }} />}
          {vibeMode && !isMerged && (
            <button
              className={`speaker-claim-btn${isActiveSpeaker ? ' speaker-claim-btn--active' : ''}`}
              onClick={onClaim}
              title={isActiveSpeaker ? 'Release panel' : 'Tap to claim this panel'}
            >
              {isActiveSpeaker ? 'talking' : '🎤'}
            </button>
          )}
        </div>
      )}

      <div className="stage speaker-stage">
        <AnimatePresence mode="wait">
          {!currentItem ? (
            <motion.div
              key="empty"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="stage-empty stage-empty--blobs"
            >
              {blobPos && (
                <EmptyBlobs blobPos={blobPos} />
              )}
            </motion.div>
          ) : (
            <motion.div
              key={currentIndex}
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="stage-content"
            >
              {currentItem.mode === 'DIAGRAM' ? (
                <div key={`diagram-${currentItem.id}`} className="stage-diagram">
                  <div ref={setMermaidRef} className="mermaid" />
                </div>
              ) : currentItem.mode === 'VIDEO' ? (
                !(currentItem.video_url || currentItem.image_url) ? (
                  <div className="stage-media-error">
                    <p>Video generation failed</p>
                  </div>
                ) : imgError ? (
                  <div className="stage-media-error">
                    <p>Failed to load video</p>
                  </div>
                ) : (
                  <video
                    src={mediaSrc || currentItem.video_url || currentItem.image_url}
                    className="stage-media"
                    autoPlay loop muted playsInline
                    onError={handleMediaError}
                  />
                )
              ) : !currentItem.image_url ? (
                <div className="stage-media-error">
                  <p>Image generation failed</p>
                </div>
              ) : imgError ? (
                <div className="stage-media-error">
                  <p>Failed to load image</p>
                </div>
              ) : (currentItem.image_url?.endsWith('.mp4')) ? (
                <video
                  src={mediaSrc || currentItem.image_url}
                  className="stage-media"
                  autoPlay loop muted playsInline
                  onError={handleMediaError}
                />
              ) : (
                <img
                  src={mediaSrc || currentItem.image_url}
                  alt="Generated"
                  className="stage-media"
                  onError={handleMediaError}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {history.length > 1 && (
          <>
            <button type="button" onClick={onPrev} className="stage-nav stage-nav-prev"><ChevronLeft /></button>
            <button type="button" onClick={onNext} className="stage-nav stage-nav-next"><ChevronRight /></button>
          </>
        )}

        {isGenerating && (
          <div
            className="panel-generating-ring"
            style={isMerged ? { '--ring-color': '#7c5cfc' } : { '--ring-color': color }}
          />
        )}
      </div>

      {currentItem && (
        <div className={`stage-caption panel-caption${currentItem.transcript?.length > 80 ? ' stage-caption-long' : ''}`}>
          {history.length > 1 && (
            <span className="stage-caption-index">{currentIndex + 1}/{history.length}</span>
          )}
          <span className="stage-caption-text">"{currentItem.transcript}"</span>
        </div>
      )}

      {(status === 'Generating' || status === 'Done' || status === 'Failed') && (
        <div
          className="panel-status"
          style={{
            color: status === 'Done' ? '#16a34a'
              : status === 'Failed' ? '#ea580c'
              : (isMerged ? '#7c5cfc' : color),
          }}
        >
          {status === 'Generating'
            ? (isVideoMode ? 'Generating video...' : 'Generating...')
            : status === 'Failed' ? 'Failed' : 'Done'}
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const auth = useAuth(API_BASE);
  const [showLoginGate, setShowLoginGate] = useState(false);
  const [showUpgradeSuccess, setShowUpgradeSuccess] = useState(false);
  const [upgradeConfirmed, setUpgradeConfirmed] = useState(false);
  const [upgradePollDone, setUpgradePollDone] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Bumped whenever a session is written, so the sidebar list refetches.
  const [sessionsVersion, setSessionsVersion] = useState(0);
  // The saved session currently on screen, if any. Declared here (not beside the
  // save/restore helpers) so resetSession, defined above them, can close over it.
  const activeSessionRef = useRef(null);

  const [entered, setEntered] = useState(false);
  // Returning signed-in visitors skip the login gate entirely.
  useEffect(() => {
    if (auth.ready && auth.user) setEntered(true);
  }, [auth.ready, auth.user]);
  // entered lags one commit behind auth.ready flipping true — effects run after
  // the render that triggered them, not within it. On a cold page load where the
  // user is already authenticated (e.g. landing back on /product after a Stripe
  // checkout redirect, which is a full navigation, not SPA routing), that gap is
  // a real, visible frame: the login gate (or a blank screen, depending which of
  // the three spots below still read the raw flag) before the effect catches up.
  // Deriving showApp instead of reading `entered` directly closes that gap in the
  // same render where auth.ready first becomes true.
  const showApp = entered || (auth.ready && !!auth.user);

  // Guided walkthrough — trial (unauthenticated) users only, shown once per browser.
  const [walkthroughStep, setWalkthroughStep] = useState(null);
  useEffect(() => {
    if (!showApp || auth.user) return;
    const forceOn = new URLSearchParams(window.location.search).has('wt');
    try {
      if (forceOn || !localStorage.getItem(WALKTHROUGH_KEY)) setWalkthroughStep(0);
    } catch {
      setWalkthroughStep(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showApp, auth.user]);
  // Spotlight targets (status badge, header actions) render via createPortal onto
  // document.body, not inside .app — a `.wt-step-N .target` descendant selector
  // scoped to .app would never match them. Toggle the step class on <body> instead,
  // since body is the common ancestor for both portaled and in-tree targets.
  useEffect(() => {
    const cls = walkthroughStep !== null ? `wt-step-${walkthroughStep}` : null;
    if (cls) document.body.classList.add(cls);
    return () => { if (cls) document.body.classList.remove(cls); };
  }, [walkthroughStep]);
  const finishWalkthrough = () => {
    try { localStorage.setItem(WALKTHROUGH_KEY, '1'); } catch { /* ignore */ }
    setWalkthroughStep(null);
  };
  const advanceWalkthrough = () => {
    if (walkthroughStep === null) return;
    if (walkthroughStep >= WALKTHROUGH_STEPS.length - 1) finishWalkthrough();
    else setWalkthroughStep(s => s + 1);
  };

  const [vibeMode, setVibeMode] = useState(false);
  const vibeModeRef = useRef(false);
  useEffect(() => { vibeModeRef.current = vibeMode; }, [vibeMode]);
  const [participantCount, setParticipantCount] = useState(null);

  // Per-speaker state
  const [speakerHistories, setSpeakerHistories] = useState([]);
  const [speakerIndices, setSpeakerIndices] = useState([]);
  const [speakerStatuses, setSpeakerStatuses] = useState([]);
  const [speakerGenerating, setSpeakerGenerating] = useState([]);

  // Merge state
  const [mergeMode, setMergeMode] = useState(false);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const mergeModeRef = useRef(false);
  // Preserved so merged channel can reference original speaker ideas for context
  const originalHistoriesRef = useRef([]);

  // Stale-closure-safe refs
  const speakerHistoryRefs = useRef([]);
  const audioQueuesRef = useRef([]);
  const isProcessingRefs = useRef([]);
  const participantCountRef = useRef(1);

  // Audio pipeline
  const recorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const pitchSamplesRef = useRef([]);
  const sliceTimerRef = useRef(null);
  const pitchSampleIntervalRef = useRef(null);
  const hearingResetRef = useRef(null);
  // Mockup mode: cut a chunk only after a REAL speech pause, not on a blind timer
  const lastSpeechAtRef = useRef(0);       // timestamp of most recent confirmed speech frame
  const speechSinceCutRef = useRef(false); // has the user spoken at all since the last chunk was sent
  const cuttingRef = useRef(false);        // guard against overlapping cuts (image + mockup)
  const cutWatchdogRef = useRef(null);     // force-unlock if stopRecording callback never fires
  const mockupBusyRefs = useRef([]);       // per-mind: /mockup in flight
  const mockupQueuesRef = useRef([]);      // per-mind audio blobs waiting while busy
  const chunkStartedAtRef = useRef(0);     // when the current recording began (safety-cap long monologues)
  const firstSpeechAtRef = useRef(0);      // when speech first appeared in this chunk
  const speechMsInChunkRef = useRef(0);    // accumulated ms of confirmed speech in this chunk
  const loudFramesRef = useRef(0);         // consecutive above-threshold frames (noise debounce)
  const processQueueRef = useRef(null);
  const demoTokenRef = useRef('');
  const flashListenHintRef = useRef(null);
  // Monotonic session id — bump on start/stop so late callbacks from a previous
  // vibe session never mutate state or fire more uploads after Stop.
  const vibeSessionIdRef = useRef(0);
  const abortControllersRef = useRef(new Set());
  // Per-cut generation stamp so a late stopRecording callback after watchdog
  // recovery is ignored instead of double-uploading.
  const cutGenerationRef = useRef(0);

  // Manual speaker claim — null = auto-detect, 0..N-1 = claimed by that panel
  const [activeSpeaker, setActiveSpeaker] = useState(null);
  const activeSpeakerRef = useRef(null);
  useEffect(() => { activeSpeakerRef.current = activeSpeaker; }, [activeSpeaker]);

  // App mode: 'image' = existing image generation, 'mockup' = voice-to-UI-spec
  const [appMode, setAppMode] = useState('image');
  const appModeRef = useRef('image');
  useEffect(() => { appModeRef.current = appMode; }, [appMode]);

  // Mockup mode — per-mind stacks (parallel ideas, same participant count as Image)
  const [mockupStacks, setMockupStacks] = useState([]);           // Iteration[][]
  const [mockupCurrentIdxs, setMockupCurrentIdxs] = useState([]); // number[]
  const [mockupGenerating, setMockupGenerating] = useState([]);   // boolean[]
  const [mockupErrors, setMockupErrors] = useState([]);           // (string|null)[]
  const [mockupActiveScreenIds, setMockupActiveScreenIds] = useState([]); // (string|null)[]
  const [mockupShowFlow, setMockupShowFlow] = useState([]);       // boolean[] — card shows flow instead of UI
  const [mockupShowTranscript, setMockupShowTranscript] = useState([]); // boolean[] — card back side
  const [activeMockupMind, setActiveMockupMind] = useState(0);
  const activeMockupMindRef = useRef(0);
  useEffect(() => { activeMockupMindRef.current = activeMockupMind; }, [activeMockupMind]);
  // 'Done' | 'Failed' | null — brief post-request badge (any mind)
  const [mockupOutcome, setMockupOutcome] = useState(null);
  const mockupOutcomeTimerRef = useRef(null);
  // True only while the user is actively speaking (drives the Listening badge)
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isSpeakingRef = useRef(false);
  const mockupPreviousSpecRefs = useRef([]); // (spec|null)[]
  const mockupPendingRefs = useRef([]);      // string[][]
  const sendMockupAudioRef = useRef(null);
  const mockupStacksRef = useRef([]);
  useEffect(() => { mockupStacksRef.current = mockupStacks; }, [mockupStacks]);

  // Blob water animation
  const blobTargetRef = useRef({ x: 0, y: 0 });
  const blobPosRef = useRef([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
  const blobRafRef = useRef(null);
  const [blobPos, setBlobPos] = useState([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);

  useEffect(() => {
    const speeds = [0.04, 0.07, 0.12];
    const loop = () => {
      const t = blobTargetRef.current;
      const next = blobPosRef.current.map((p, i) => ({
        x: p.x + (t.x - p.x) * speeds[i],
        y: p.y + (t.y - p.y) * speeds[i],
      }));
      blobPosRef.current = next;
      setBlobPos([...next]);
      blobRafRef.current = requestAnimationFrame(loop);
    };
    blobRafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(blobRafRef.current);
  }, []);

  // One-time reset: if this browser's demo state predates DEMO_RESET_VERSION (a prior
  // testing session, an old limit, etc.), wipe it before anything reads it. Bumping the
  // version constant is now the ONLY way demo state should ever need clearing — no more
  // "open devtools and delete localStorage" instructions.
  try {
    if (localStorage.getItem(DEMO_RESET_VERSION_KEY) !== DEMO_RESET_VERSION) {
      localStorage.removeItem(DEMO_TOKEN_KEY);
      localStorage.removeItem(DEMO_REMAINING_KEY);
      localStorage.setItem(DEMO_RESET_VERSION_KEY, DEMO_RESET_VERSION);
    }
  } catch { /* ignore */ }

  // Demo token
  const [demoToken, setDemoToken] = useState(() => {
    try { return localStorage.getItem(DEMO_TOKEN_KEY) || ''; } catch { return ''; }
  });
  const [demoUsesLeft, setDemoUsesLeft] = useState(() => {
    try {
      const s = localStorage.getItem(DEMO_REMAINING_KEY);
      const parsed = s !== null ? parseInt(s, 10) : DEMO_LIMIT;
      // A stored value higher than the current limit means DEMO_LIMIT was lowered since
      // it was last saved (e.g. after a deploy) — clamp instead of trusting the stale cap.
      if (!Number.isFinite(parsed) || parsed < 0) return DEMO_LIMIT;
      return Math.min(parsed, DEMO_LIMIT);
    } catch { return DEMO_LIMIT; }
  });
  // Quota display. The cap depends on who's asking: anonymous visitors get DEMO_LIMIT,
  // signed-in accounts a larger allowance, subscribers none at all (unlimited === true,
  // where demoUsesLeft is meaningless and never shown).
  const [generationLimit, setGenerationLimit] = useState(DEMO_LIMIT);
  const [unlimited, setUnlimited] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradeReason, setUpgradeReason] = useState(null); // why it opened (from a 402), or null

  const [micError, setMicError] = useState(null);
  const [listenHint, setListenHint] = useState(null);
  const listenHintTimerRef = useRef(null);

  const flashListenHint = (msg) => {
    setListenHint(msg);
    if (listenHintTimerRef.current) clearTimeout(listenHintTimerRef.current);
    listenHintTimerRef.current = setTimeout(() => setListenHint(null), 3500);
  };
  flashListenHintRef.current = flashListenHint;

  useEffect(() => { demoTokenRef.current = demoToken; }, [demoToken]);

  // Generation requests fire from long-lived audio callbacks, so read the token off a ref
  // rather than a closure that could be a render behind.
  const authHeadersRef = useRef({});
  useEffect(() => {
    authHeadersRef.current = auth.token ? { Authorization: `Bearer ${auth.token}` } : {};
  }, [auth.token]);

  // ── Quota plumbing ─────────────────────────────────────────────────────────
  // Every generation response carries the caller's current allowance; this applies it.
  const applyQuota = (data) => {
    if (!data?.demo_token) return;
    setDemoToken(data.demo_token);
    demoTokenRef.current = data.demo_token;
    try { localStorage.setItem(DEMO_TOKEN_KEY, data.demo_token); } catch { /* ignore */ }

    if (data.unlimited) {
      setUnlimited(true);
      setGenerationLimit(null);
      return;
    }
    setUnlimited(false);
    const remaining = data.demo_uses_remaining ?? 0;
    const limit = data.generation_limit ?? DEMO_LIMIT;
    setDemoUsesLeft(remaining);
    setGenerationLimit(limit);
    // Only the anonymous allowance is mirrored to localStorage — a signed-in user's
    // count is authoritative in the DB and would go stale here.
    if (data.tier === 'anon') {
      try { localStorage.setItem(DEMO_REMAINING_KEY, String(remaining)); } catch { /* ignore */ }
    }
    if (remaining === 0) stopVibeSession();
  };

  // Reflect the signed-in account's allowance in the UI (and fall back to the anonymous
  // demo counters on sign-out).
  useEffect(() => {
    if (!auth.ready) return;
    const u = auth.user;
    if (!u) {
      setUnlimited(false);
      setGenerationLimit(DEMO_LIMIT);
      try {
        const s = localStorage.getItem(DEMO_REMAINING_KEY);
        const parsed = s !== null ? parseInt(s, 10) : DEMO_LIMIT;
        setDemoUsesLeft(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), DEMO_LIMIT) : DEMO_LIMIT);
      } catch { setDemoUsesLeft(DEMO_LIMIT); }
      return;
    }
    if (u.is_paid) {
      setUnlimited(true);
      setGenerationLimit(null);
      return;
    }
    setUnlimited(false);
    const limit = u.generation_limit ?? DEMO_LIMIT;
    setGenerationLimit(limit);
    setDemoUsesLeft(Math.max(0, limit - (u.generations_used ?? 0)));
  }, [auth.user, auth.ready]);

  // Coming back from Stripe checkout: the webhook may land a moment after the redirect,
  // so re-check the account a couple of times before giving up. A visible confirmation
  // screen covers that gap — the redirect alone gave no sign the payment went through.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.get('upgraded')) return;
    window.history.replaceState({}, '', window.location.pathname);
    setShowUpgradeSuccess(true);
    setUpgradeConfirmed(false);
    setUpgradePollDone(false);
    let tries = 0;
    const poll = setInterval(async () => {
      tries += 1;
      await auth.refreshUser();
      if (tries >= 5) {
        clearInterval(poll);
        setUpgradePollDone(true);
      }
    }, 1500);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.ready]);

  useEffect(() => {
    if (showUpgradeSuccess && auth.user?.is_paid) setUpgradeConfirmed(true);
  }, [showUpgradeSuccess, auth.user?.is_paid]);

  /** Handle a quota rejection. Returns true if it was one (caller should stop). */
  const handleQuotaError = (err) => {
    const status = err?.response?.status;
    if (status === 402) {
      // Signed-in and out of free allowance — offer the subscription.
      setDemoUsesLeft(0);
      setUpgradeReason(err?.response?.data?.detail || "You've used your free allowance.");
      setShowUpgrade(true);
      stopVibeSession();
      return true;
    }
    if (status === 429) {
      setDemoUsesLeft(0);
      try { localStorage.setItem(DEMO_REMAINING_KEY, '0'); } catch { /* ignore */ }
      stopVibeSession();
      return true;
    }
    return false;
  };

  // Keep mockup per-mind arrays sized to participant count (mode switches / HMR)
  useEffect(() => {
    if (participantCount == null || participantCount < 1) return;
    const count = participantCount;
    setMockupStacks(prev => {
      if (prev.length === count) return prev;
      const next = Array.from({ length: count }, (_, i) => prev[i] || []);
      mockupStacksRef.current = next;
      return next;
    });
    setMockupCurrentIdxs(prev => (prev.length === count ? prev : new Array(count).fill(0)));
    setMockupGenerating(prev => (prev.length === count ? prev : new Array(count).fill(false)));
    setMockupErrors(prev => (prev.length === count ? prev : new Array(count).fill(null)));
    setMockupActiveScreenIds(prev => (prev.length === count ? prev : new Array(count).fill(null)));
    setMockupShowFlow(prev => (prev.length === count ? prev : new Array(count).fill(false)));
    setMockupShowTranscript(prev => (prev.length === count ? prev : new Array(count).fill(false)));
    while (mockupPreviousSpecRefs.current.length < count) mockupPreviousSpecRefs.current.push(null);
    mockupPreviousSpecRefs.current = mockupPreviousSpecRefs.current.slice(0, count);
    while (mockupPendingRefs.current.length < count) mockupPendingRefs.current.push([]);
    mockupPendingRefs.current = mockupPendingRefs.current.slice(0, count).map(p => p || []);
    mockupBusyRefs.current = Array.from({ length: count }, (_, i) => mockupBusyRefs.current[i] || false);
    mockupQueuesRef.current = Array.from({ length: count }, (_, i) => mockupQueuesRef.current[i] || []);
    setActiveMockupMind(m => Math.min(m, count - 1));
  }, [participantCount]);

  const setSpeaking = (on) => {
    if (isSpeakingRef.current === on) return;
    isSpeakingRef.current = on;
    setIsSpeaking(on);
  };

  // Global safety net: a stray unhandled rejection (e.g. an aborted fetch) must never
  // take down the whole session. Swallow it and let the per-request recovery handle state.
  useEffect(() => {
    const onRejection = (e) => {
      const reason = e?.reason;
      const aborted = reason?.code === 'ERR_CANCELED' || reason?.name === 'CanceledError'
        || reason?.name === 'AbortError';
      if (aborted) { e.preventDefault(); return; }
      console.error('Unhandled rejection:', reason);
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, []);

  // Keep speakerHistoryRefs in sync (one render behind — intentional for index calc in sendAudio)
  useEffect(() => {
    speakerHistories.forEach((h, i) => { speakerHistoryRefs.current[i] = h; });
  }, [speakerHistories]);

  // ── Initialize N speaker lanes ─────────────────────────────────────────────
  const initializeSpeakers = (count) => {
    participantCountRef.current = count;
    const empty = Array.from({ length: count }, () => []);
    setSpeakerHistories(empty);
    setSpeakerIndices(new Array(count).fill(0));
    setSpeakerStatuses(new Array(count).fill('Idle'));
    setSpeakerGenerating(new Array(count).fill(false));
    speakerHistoryRefs.current = Array.from({ length: count }, () => []);
    audioQueuesRef.current = Array.from({ length: count }, () => []);
    isProcessingRefs.current = new Array(count).fill(false);
    // Per-mind mockup stacks
    setMockupStacks(empty);
    setMockupCurrentIdxs(new Array(count).fill(0));
    setMockupGenerating(new Array(count).fill(false));
    setMockupErrors(new Array(count).fill(null));
    setMockupActiveScreenIds(new Array(count).fill(null));
    setMockupShowFlow(new Array(count).fill(false));
    setMockupShowTranscript(new Array(count).fill(false));
    setActiveMockupMind(0);
    mockupPreviousSpecRefs.current = new Array(count).fill(null);
    mockupPendingRefs.current = Array.from({ length: count }, () => []);
    mockupBusyRefs.current = new Array(count).fill(false);
    mockupQueuesRef.current = Array.from({ length: count }, () => []);
    mockupStacksRef.current = empty;
    setParticipantCount(count);
  };

  // ── Per-speaker generation queue ───────────────────────────────────────────
  const processQueue = async (speakerIdx) => {
    if (isProcessingRefs.current[speakerIdx] || !audioQueuesRef.current[speakerIdx]?.length) return;
    const sessionAtStart = vibeSessionIdRef.current;
    if (!sessionAtStart) return; // vibing is off
    isProcessingRefs.current[speakerIdx] = true;
    const blob = audioQueuesRef.current[speakerIdx].shift();

    setSpeakerStatuses(p => { const n = [...p]; n[speakerIdx] = 'Generating'; return n; });
    setSpeakerGenerating(p => { const n = [...p]; n[speakerIdx] = true; return n; });

    // Hard ceiling matching the backend's own cap. If the request truly hangs past this
    // (network death, proxy stall), abort it so the queue lock is guaranteed to release —
    // a silently-hung request was the worst "it just stopped working" failure mode.
    const controller = new AbortController();
    abortControllersRef.current.add(controller);
    const watchdog = setTimeout(() => {
      console.warn('Speaker', speakerIdx, 'request watchdog fired — aborting');
      controller.abort();
    }, 600000);

    let ok = false;
    try {
      if (vibeSessionIdRef.current !== sessionAtStart) {
        ok = false;
      } else {
        ok = await sendAudio(blob, speakerIdx, controller.signal, sessionAtStart);
      }
    } catch (e) {
      console.error('Speaker', speakerIdx, 'queue error:', e);
      ok = false;
    } finally {
      clearTimeout(watchdog);
      abortControllersRef.current.delete(controller);
      // ALWAYS release the lock, no matter how the request ended.
      isProcessingRefs.current[speakerIdx] = false;
      setSpeakerGenerating(p => { const n = [...p]; n[speakerIdx] = false; return n; });

      // Session ended mid-flight — drop leftover queue and don't touch badge.
      if (vibeSessionIdRef.current !== sessionAtStart) {
        if (audioQueuesRef.current[speakerIdx]) audioQueuesRef.current[speakerIdx] = [];
        return;
      }

      if (audioQueuesRef.current[speakerIdx]?.length > 0) {
        processQueueRef.current?.(speakerIdx);
      } else {
        const endStatus = ok ? 'Done' : 'Failed';
        setSpeakerStatuses(p => {
          const n = [...p];
          // Don't stomp a fresh Hearing the live recorder may have just set
          if (n[speakerIdx] === 'Generating') n[speakerIdx] = endStatus;
          return n;
        });
        setTimeout(() => {
          if (vibeSessionIdRef.current !== sessionAtStart) return;
          setSpeakerStatuses(p => {
            const n = [...p];
            if (n[speakerIdx] === 'Done' || n[speakerIdx] === 'Failed') {
              n[speakerIdx] = vibeModeRef.current ? 'Waiting' : 'Idle';
            }
            return n;
          });
        }, 2000);
      }
    }
  };

  // ── Send a chunk; merged channel uses combined history for context ─
  const sendAudio = async (blob, speakerIdx, signal, sessionId) => {
    const formData = new FormData();
    formData.append('file', blob, 'voice.wav');

    let history;
    if (mergeModeRef.current) {
      // Blend original speaker histories + merged channel history for richer context
      const origContext = originalHistoriesRef.current.flatMap(h => h.slice(-2));
      const mergedContext = speakerHistoryRefs.current[0] || [];
      history = [...origContext, ...mergedContext].slice(-5);
    } else {
      history = speakerHistoryRefs.current[speakerIdx] || [];
    }

    const historySummary = history.slice(-5).map(item => ({
      id: item.id || Date.now(),
      transcript: item.transcript,
      visual_prompt: item.visual_prompt,
      image_url: item.image_url,
      mode: item.mode,
      seed: item.seed,
    }));

    formData.append('history_json', JSON.stringify(historySummary));
    formData.append('demo_token', demoTokenRef.current);
    // Video has no dedicated mode toggle anymore — the backend auto-detects it from speech.
    formData.append('generation_mode', 'image');

    const stillLive = () => vibeSessionIdRef.current === sessionId;

    try {
      // 10-min ceiling is a safety cap (matters if FAL_VIDEO_MODEL is switched back to
      // slow Kling-class video); the queue watchdog can still abort earlier.
      const res = await axios.post(`${API_BASE}/upload-audio`, formData, {
        signal, timeout: 600000, headers: authHeadersRef.current,
      });
      if (!stillLive()) return false;
      if (res.data.error) {
        flashListenHint("Didn't catch that, keep talking");
        return false;
      }

      applyQuota(res.data);

      // Real success = something the user can see (image, video, or diagram). A 200 with
      // no media used to flash "Done" and look like a lie.
      const hasMedia = !!(res.data.image_url || res.data.video_url || res.data.diagram_code);
      if (!hasMedia) {
        flashListenHint("Didn't catch that, keep talking");
        return false;
      }

      if (!stillLive()) return false;

      const newItem = { ...res.data, id: Date.now() };
      // Ref lags one render — its length equals the pre-push length, which is the new item's index
      const newIdx = speakerHistoryRefs.current[speakerIdx]?.length || 0;
      setSpeakerHistories(prev => prev.map((h, i) => i === speakerIdx ? [...h, newItem] : h));
      setSpeakerIndices(prev => { const n = [...prev]; n[speakerIdx] = newIdx; return n; });
      setListenHint(null);
      return true;

    } catch (err) {
      if (!stillLive()) return false;
      if (handleQuotaError(err)) return false;
      const aborted = err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';
      flashListenHint(aborted ? 'That took too long, try again' : 'Generation failed, try again');
      return false;
    }
  };

  const flashMockupOutcome = (outcome) => {
    setMockupOutcome(outcome);
    if (mockupOutcomeTimerRef.current) clearTimeout(mockupOutcomeTimerRef.current);
    mockupOutcomeTimerRef.current = setTimeout(() => setMockupOutcome(null), 2000);
  };

  // ── Mockup audio: route speech chunks to a specific mind's /mockup stack ───
  const sendMockupAudio = async (blob, speakerIdx = 0) => {
    const sessionAtStart = vibeSessionIdRef.current;
    if (!sessionAtStart) return;
    const count = participantCountRef.current || 1;
    const idx = Math.max(0, Math.min(speakerIdx, count - 1));

    // Ensure per-mind arrays are sized
    while (mockupBusyRefs.current.length < count) mockupBusyRefs.current.push(false);
    while (mockupQueuesRef.current.length < count) mockupQueuesRef.current.push([]);
    while (mockupPreviousSpecRefs.current.length < count) mockupPreviousSpecRefs.current.push(null);
    while (mockupPendingRefs.current.length < count) mockupPendingRefs.current.push([]);

    if (mockupBusyRefs.current[idx]) {
      mockupQueuesRef.current[idx].push(blob);
      return;
    }

    mockupBusyRefs.current[idx] = true;
    setSpeaking(false);
    setMockupGenerating(p => {
      const n = p.length === count ? [...p] : new Array(count).fill(false);
      n[idx] = true;
      return n;
    });
    setMockupErrors(p => {
      const n = p.length === count ? [...p] : new Array(count).fill(null);
      n[idx] = null;
      return n;
    });
    setSpeakerStatuses(p => {
      const n = p.length === count ? [...p] : new Array(count).fill('Waiting');
      n[idx] = 'Generating';
      return n;
    });
    setMockupOutcome(null);
    // Focus the mind that just spoke so flowchart/deck follow
    setActiveMockupMind(idx);
    // Keep phones in view — with 4 minds the phone row used to sit below the fold
    requestAnimationFrame(() => {
      document.getElementById(`mockup-phone-${idx}`)?.scrollIntoView({
        behavior: 'smooth', block: 'nearest',
      });
    });

    const formData = new FormData();
    formData.append('file', blob, 'voice.wav');
    // Always send valid JSON — FormData drops undefined, and stringify(undefined) is not a string
    const prevSpec = mockupPreviousSpecRefs.current[idx] ?? null;
    formData.append('previous_spec_json', JSON.stringify(prevSpec));
    formData.append('context_text', (mockupPendingRefs.current[idx] || []).join(' '));
    formData.append('demo_token', demoTokenRef.current);
    const controller = new AbortController();
    abortControllersRef.current.add(controller);
    const watchdog = setTimeout(() => controller.abort(), 90000);
    let outcome = 'Failed';
    const stillLive = () => vibeSessionIdRef.current === sessionAtStart;
    try {
      const res = await axios.post(`${API_BASE}/mockup`, formData, {
        signal: controller.signal, timeout: 90000, headers: authHeadersRef.current,
      });
      if (!stillLive()) return;
      if (res.data.noOp) {
        if (res.data.transcript && !res.data.hallucination) {
          mockupPendingRefs.current[idx] = [...(mockupPendingRefs.current[idx] || []), res.data.transcript].slice(-8);
        }
        flashListenHint("Didn't catch that, keep talking");
        outcome = null;
        return;
      }
      const screens = res.data.spec?.screens;
      const hasContent = Array.isArray(screens) && screens.some(
        s => Array.isArray(s?.components) && s.components.length > 0
      );
      if (res.data.error || !res.data.spec || !Array.isArray(screens) || screens.length === 0 || !hasContent) {
        setMockupErrors(p => {
          const n = p.length === count ? [...p] : new Array(count).fill(null);
          n[idx] = 'oops';
          return n;
        });
        outcome = 'Failed';
        return;
      }
      const spec = res.data.spec;
      mockupPreviousSpecRefs.current[idx] = spec;
      mockupPendingRefs.current[idx] = [];
      const stackLen = (mockupStacksRef.current[idx] || []).length;
      const iterNum = spec.iterationNumber || (stackLen + 1);
      const newIteration = {
        iterationNumber: iterNum, spec,
        transcript: res.data.transcript || '',
        changeLog: spec.changeLog || [],
      };
      if (!stillLive()) return;
      setMockupStacks(prev => {
        const base = prev.length === count ? prev : Array.from({ length: count }, (_, i) => prev[i] || []);
        const next = base.map((stack, i) => (i === idx ? [...stack, newIteration] : stack));
        mockupStacksRef.current = next;
        return next;
      });
      setMockupCurrentIdxs(idxs => {
        const n = idxs.length === count ? [...idxs] : new Array(count).fill(0);
        const stackLenNow = (mockupStacksRef.current[idx] || []).length;
        n[idx] = Math.max(0, stackLenNow - 1);
        return n;
      });
      setMockupActiveScreenIds(ids => {
        const n = ids.length === count ? [...ids] : new Array(count).fill(null);
        n[idx] = spec.screens?.[0]?.id || null;
        return n;
      });
      applyQuota(res.data);
      outcome = 'Done';
    } catch (err) {
      if (!stillLive()) return;
      if (handleQuotaError(err)) {
        outcome = 'Failed';
      } else {
        const aborted = err?.code === 'ERR_CANCELED' || err?.name === 'CanceledError';
        if (aborted && mockupPreviousSpecRefs.current[idx]) {
          flashListenHint('That took too long, try again');
        } else if (!aborted) {
          setMockupErrors(p => {
            const n = p.length === count ? [...p] : new Array(count).fill(null);
            n[idx] = 'oops';
            return n;
          });
        } else {
          flashListenHint('That took too long, try again');
        }
        outcome = 'Failed';
      }
    } finally {
      clearTimeout(watchdog);
      abortControllersRef.current.delete(controller);
      mockupBusyRefs.current[idx] = false;
      if (stillLive()) {
        setMockupGenerating(p => {
          const n = p.length === count ? [...p] : new Array(count).fill(false);
          n[idx] = false;
          return n;
        });
        if (outcome === 'Done' || outcome === 'Failed') {
          setSpeakerStatuses(p => {
            const n = p.length === count ? [...p] : new Array(count).fill('Waiting');
            if (n[idx] === 'Generating' || n[idx] === 'Hearing') n[idx] = outcome;
            return n;
          });
          setTimeout(() => {
            if (vibeSessionIdRef.current !== sessionAtStart) return;
            setSpeakerStatuses(p => {
              const n = [...p];
              if (n[idx] === 'Done' || n[idx] === 'Failed') n[idx] = 'Waiting';
              return n;
            });
          }, 1800);
        }
        setSpeaking(false);
        if (outcome) flashMockupOutcome(outcome);
        lastSpeechAtRef.current = Date.now();
        chunkStartedAtRef.current = Date.now();
        loudFramesRef.current = 0;
        // Drain queued chunks for this mind
        const queued = mockupQueuesRef.current[idx];
        if (queued?.length && sendMockupAudioRef.current) {
          const nextBlob = queued.shift();
          sendMockupAudioRef.current(nextBlob, idx);
        }
      } else if (mockupQueuesRef.current[idx]) {
        mockupQueuesRef.current[idx] = [];
      }
    }
  };

  // Keep queue processor fresh so the live recorder never calls a stale closure
  // (stale demoToken / setters were a recurring "images stop working" failure mode).
  useEffect(() => { processQueueRef.current = processQueue; });
  useEffect(() => { sendMockupAudioRef.current = sendMockupAudio; });

  // Clones the focused mind's latest spec, mutates it, pushes a new iteration
  const applyMockupSpecEdit = (mutator, changeLogEntry, mindIdx = activeMockupMind) => {
    const idx = mindIdx ?? 0;
    const current = mockupPreviousSpecRefs.current[idx];
    if (!current) return;
    const cloned = JSON.parse(JSON.stringify(current));
    const changed = mutator(cloned);
    if (!changed) return;
    const stackLen = (mockupStacksRef.current[idx] || []).length;
    cloned.iterationNumber = stackLen + 1;
    cloned.previousIterationRef = current.iterationNumber ?? null;
    cloned.changeLog = [changeLogEntry];
    mockupPreviousSpecRefs.current[idx] = cloned;
    const newIteration = {
      iterationNumber: cloned.iterationNumber, spec: cloned,
      transcript: '(flow edit)', changeLog: cloned.changeLog,
    };
    const count = participantCountRef.current || 1;
    setMockupStacks(prev => {
      const base = prev.length === count ? prev : Array.from({ length: count }, (_, i) => prev[i] || []);
      const next = base.map((stack, i) => (i === idx ? [...stack, newIteration] : stack));
      mockupStacksRef.current = next;
      return next;
    });
    setMockupCurrentIdxs(idxs => {
      const n = idxs.length === count ? [...idxs] : new Array(count).fill(0);
      n[idx] = Math.max(0, (mockupStacksRef.current[idx] || []).length - 1);
      return n;
    });
    setActiveMockupMind(idx);
  };

  // Dragging a connector from one flowchart node onto another ADDS that route rather
  // than stealing an existing one. Order of preference:
  //   1. the link already points there → nothing to do
  //   2. an unwired Button / ListRow / nav link → wire it up
  //   3. nothing spare → append a real Button to the screen for the new route
  // Overwriting a working link (the old behaviour) meant every new connection silently
  // broke an existing one, so the flow you wanted never actually appeared.
  const handleFlowRewire = (fromScreenId, toScreenId, mindIdx = activeMockupMind) => {
    applyMockupSpecEdit((spec) => {
      const screen = spec.screens?.find(s => s.id === fromScreenId);
      if (!screen || fromScreenId === toScreenId) return false;
      const toScreen = spec.screens?.find(s => s.id === toScreenId);

      let alreadyLinked = false;
      let firstFree = null;   // an element with no target yet
      const walk = (list) => {
        for (const c of list || []) {
          if ((c.type === 'Button' || c.type === 'ListRow') && c.props) {
            if (c.props.target === toScreenId) alreadyLinked = true;
            else if (!firstFree && !c.props.target) firstFree = c.props;
          }
          if (c.type === 'List') {
            for (const row of c.props?.rows || []) {
              if (row.target === toScreenId) alreadyLinked = true;
              else if (!firstFree && !row.target) firstFree = row;
            }
          }
          if (c.type === 'Card' && Array.isArray(c.props?.components)) walk(c.props.components);
        }
      };
      walk(screen.components);

      const navBar = screen.components?.find(c => c.type === 'NavBar');
      for (const l of navBar?.props?.links || []) {
        if (l.target === toScreenId) alreadyLinked = true;
        else if (!firstFree && !l.target) firstFree = l;
      }
      const tabBar = screen.components?.find(c => c.type === 'TabBar');
      for (const t of tabBar?.props?.tabs || []) {
        if (t.target === toScreenId) alreadyLinked = true;
      }
      if (alreadyLinked) return false;

      if (firstFree) {
        firstFree.target = toScreenId;
        return true;
      }

      // Nothing spare — give the screen a real control for the route the user drew.
      const label = toScreen?.name || toScreenId;
      if (!Array.isArray(screen.components)) screen.components = [];
      screen.components.push({
        id: `btn_${fromScreenId}_${toScreenId}_${Date.now().toString(36)}`,
        type: 'Button',
        props: { label, variant: 'secondary', target: toScreenId },
        changeType: 'added',
      });
      return true;
    }, `linked flow: ${fromScreenId} → ${toScreenId}`, mindIdx);
  };

  // ── Recording: rolling slices (image) / pause VAD (mockup) ─────────────────
  const startVibeSession = async () => {
    setMicError(null);
    setListenHint(null);
    setMockupOutcome(null);
    setMockupGenerating(p => p.map(() => false));
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Microphone API unavailable in this browser');
      }
      const stream = await getMicStream();
      // Invalidate any prior session and claim a new one only after mic is live
      vibeSessionIdRef.current += 1;
      cutGenerationRef.current += 1;
      streamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // iOS starts AudioContext suspended until resume() after a user gesture
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      analyserRef.current = analyser;

      recorderRef.current = newAudioRecorder(stream);
      recorderRef.current.startRecording();
      pitchSamplesRef.current = [];

      lastSpeechAtRef.current = 0;
      speechSinceCutRef.current = false;
      cuttingRef.current = false;
      if (cutWatchdogRef.current) { clearTimeout(cutWatchdogRef.current); cutWatchdogRef.current = null; }
      chunkStartedAtRef.current = Date.now();
      firstSpeechAtRef.current = 0;
      speechMsInChunkRef.current = 0;
      loudFramesRef.current = 0;

      // Shared VAD for Image + Mockup. Tuned to be forgiving — silent drops from
      // over-strict gates were the main "it stopped generating" failure mode.
      const TICK_MS = 100;
      const SPEECH_RMS = 0.004;         // catch quiet mics / soft speech
      const SPEECH_ON_FRAMES = 2;       // ~200ms sustained loudness
      const MIN_SPEECH_MS = 400;        // short prompts still count
      const MAX_CHUNK_MS = 20000;       // hard cap for nonstop monologues
      const MIN_BLOB = 8000;            // tiny WAV floor; hadSpeech is the real gate

      const resetChunkCounters = () => {
        speechSinceCutRef.current = false;
        firstSpeechAtRef.current = 0;
        speechMsInChunkRef.current = 0;
        loudFramesRef.current = 0;
        lastSpeechAtRef.current = 0;
        chunkStartedAtRef.current = Date.now();
        setSpeaking(false);
      };

      const releaseCutLock = () => {
        if (cutWatchdogRef.current) {
          clearTimeout(cutWatchdogRef.current);
          cutWatchdogRef.current = null;
        }
        cuttingRef.current = false;
      };

      const cutChunk = () => {
        if (!recorderRef.current || !streamRef.current?.active) return;
        if (cuttingRef.current) return;
        if (!vibeSessionIdRef.current) return;
        cuttingRef.current = true;
        const cutId = ++cutGenerationRef.current;
        const sessionAtCut = vibeSessionIdRef.current;
        // If stopRecording's callback never fires, vibing used to lock forever.
        cutWatchdogRef.current = setTimeout(() => {
          // Only recover if this cut is still the active one
          if (cutGenerationRef.current !== cutId) return;
          console.warn('Cut watchdog: releasing stuck recorder lock');
          // Invalidate the late stopRecording callback so it won't double-upload
          cutGenerationRef.current += 1;
          cuttingRef.current = false;
          cutWatchdogRef.current = null;
          try {
            if (streamRef.current?.active && vibeSessionIdRef.current === sessionAtCut) {
              try { recorderRef.current?.destroy?.(); } catch { /* ignore */ }
              recorderRef.current = newAudioRecorder(streamRef.current);
              recorderRef.current.startRecording();
              resetChunkCounters();
            }
          } catch (e) {
            console.error('Cut watchdog recovery failed:', e);
          }
        }, 4000);

        const finishedRecorder = recorderRef.current;
        const hadSpeech = speechSinceCutRef.current;
        // Clear speech flag immediately so the next chunk starts clean even if
        // getBlob is slow — prevents double-cutting the same utterance.
        speechSinceCutRef.current = false;

        finishedRecorder.stopRecording(() => {
          // Stale after watchdog recovery or session stop — do nothing.
          if (cutGenerationRef.current !== cutId || vibeSessionIdRef.current !== sessionAtCut) {
            try { finishedRecorder.destroy(); } catch { /* ignore */ }
            return;
          }
          try {
            const blob = finishedRecorder.getBlob();

            if (appModeRef.current === 'mockup') {
              if (hadSpeech && blob?.size > MIN_BLOB && sendMockupAudioRef.current) {
                pitchSamplesRef.current.splice(0); // unused in mockup — don't let stale pitch leak
                const count = participantCountRef.current || 1;
                // Never use pitch for mockup: with 4 lanes it scatters speech onto empty
                // minds while the user watches the focused one and thinks nothing generated.
                const claimed = activeSpeakerRef.current;
                const focused = activeMockupMindRef.current;
                let speakerIdx = 0;
                if (claimed !== null && claimed >= 0 && claimed < count) {
                  speakerIdx = claimed;
                } else if (focused >= 0 && focused < count) {
                  speakerIdx = focused;
                }
                console.info('Mockup audio → Mind', speakerIdx + 1, `(${blob.size}b)`);
                sendMockupAudioRef.current(blob, speakerIdx);
              } else if (hadSpeech) {
                console.warn('Mockup chunk skipped (too small):', blob?.size, 'bytes');
                flashListenHintRef.current?.("Didn't catch that, keep talking");
              }
            } else if (hadSpeech && blob?.size > MIN_BLOB) {
              const samples = pitchSamplesRef.current.splice(0);
              const count = participantCountRef.current;
              const speakerIdx = mergeModeRef.current ? 0
                : (activeSpeakerRef.current !== null ? activeSpeakerRef.current
                : assignSpeaker(samples, count));

              if (!audioQueuesRef.current[speakerIdx]) audioQueuesRef.current[speakerIdx] = [];
              audioQueuesRef.current[speakerIdx].push(blob);
              processQueueRef.current?.(speakerIdx);
            } else if (hadSpeech) {
              console.warn('Image chunk skipped (too small):', blob?.size, 'bytes');
              flashListenHintRef.current?.("Didn't catch that, keep talking");
            }

            pitchSamplesRef.current.splice(0);
            try { finishedRecorder.destroy(); } catch { /* ignore */ }

            if (streamRef.current?.active && vibeSessionIdRef.current === sessionAtCut) {
              recorderRef.current = newAudioRecorder(streamRef.current);
              recorderRef.current.startRecording();
            }
            resetChunkCounters();
          } catch (e) {
            console.error('cutChunk failed:', e);
            flashListenHintRef.current?.('Recorder glitch, keep talking');
            try {
              if (streamRef.current?.active && vibeSessionIdRef.current === sessionAtCut) {
                recorderRef.current = newAudioRecorder(streamRef.current);
                recorderRef.current.startRecording();
              }
            } catch { /* ignore */ }
            resetChunkCounters();
          } finally {
            if (cutGenerationRef.current === cutId) releaseCutLock();
          }
        });
      };

      pitchSampleIntervalRef.current = setInterval(() => {
        if (!analyserRef.current || !audioCtxRef.current) return;
        // Auto-resume if the browser suspended the context (tab background, HMR, iOS)
        if (audioCtxRef.current.state === 'suspended') {
          audioCtxRef.current.resume().catch(() => {});
        }
        const timeData = new Float32Array(analyserRef.current.fftSize);
        analyserRef.current.getFloatTimeDomainData(timeData);
        const rms = Math.sqrt(timeData.reduce((s, v) => s + v * v, 0) / timeData.length);
        const now = Date.now();

        if (rms >= SPEECH_RMS) {
          loudFramesRef.current += 1;
          if (loudFramesRef.current >= SPEECH_ON_FRAMES) {
            lastSpeechAtRef.current = now;
            speechSinceCutRef.current = true;
            speechMsInChunkRef.current += TICK_MS;
            if (!firstSpeechAtRef.current) firstSpeechAtRef.current = now;
            const pitch = detectDominantPitch(analyserRef.current, audioCtxRef.current.sampleRate);
            if (pitch) pitchSamplesRef.current.push(pitch);
            setSpeaking(true);
            setSpeakerStatuses(p => {
              if (appModeRef.current === 'mockup') {
                // Only light the mind that will receive this chunk (claim → focus → 0)
                const count = p.length || participantCountRef.current || 1;
                const claimed = activeSpeakerRef.current;
                const focused = activeMockupMindRef.current;
                let idx = 0;
                if (claimed !== null && claimed >= 0 && claimed < count) idx = claimed;
                else if (focused >= 0 && focused < count) idx = focused;
                const next = p.map((s, i) => {
                  if (i === idx) {
                    return (s === 'Generating') ? s : 'Hearing';
                  }
                  return s === 'Hearing' ? 'Waiting' : s;
                });
                return next.every((s, i) => s === p[i]) ? p : next;
              }
              // Image mode: already hearing / generating — leave alone
              if (p.every(s => s === 'Hearing' || s === 'Generating')) return p;
              return p.map(s =>
                (s === 'Waiting' || s === 'Listening' || s === 'Idle' || s === 'Failed' || s === 'Done')
                  ? 'Hearing' : s
              );
            });
          }
        } else {
          loudFramesRef.current = 0;
          if (isSpeakingRef.current && lastSpeechAtRef.current && (now - lastSpeechAtRef.current) >= 350) {
            setSpeaking(false);
            setSpeakerStatuses(p => {
              if (!p.some(s => s === 'Hearing')) return p;
              return p.map(s => s === 'Hearing' ? 'Waiting' : s);
            });
          }
        }

        if (!speechSinceCutRef.current || cuttingRef.current) return;
        if (!firstSpeechAtRef.current || !lastSpeechAtRef.current) return;

        const pauseMs = appModeRef.current === 'mockup' ? 4000 : 1400;
        const silentFor = now - lastSpeechAtRef.current;
        const hasEnoughSpeech = speechMsInChunkRef.current >= MIN_SPEECH_MS;
        const longPause = silentFor >= pauseMs;
        const hitCap = now - chunkStartedAtRef.current >= MAX_CHUNK_MS;

        if ((longPause && hasEnoughSpeech) || (hitCap && hasEnoughSpeech)) {
          cutChunk();
        }
      }, TICK_MS);

      if (sliceTimerRef.current) { clearInterval(sliceTimerRef.current); sliceTimerRef.current = null; }

      setSpeakerStatuses(new Array(participantCountRef.current).fill('Waiting'));
      setSpeaking(false);
      // Multi-mockup: claim the focused mind so the first cut isn't ambiguous
      if (appModeRef.current === 'mockup' && participantCountRef.current > 1) {
        const focus = Math.max(0, Math.min(activeMockupMindRef.current, participantCountRef.current - 1));
        setActiveSpeaker(focus);
        setActiveMockupMind(focus);
      }
    } catch (err) {
      console.error('Mic error:', err);
      vibeSessionIdRef.current = 0;
      setMicError(micErrorMessage(err));
      setVibeMode(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      if (audioCtxRef.current?.state !== 'closed') audioCtxRef.current?.close();
      audioCtxRef.current = null;
      analyserRef.current = null;
    }
  };

  const stopVibeSession = () => {
    // Invalidate session FIRST so in-flight callbacks bail out and ignore results
    vibeSessionIdRef.current = 0;
    cutGenerationRef.current += 1;

    // Abort every in-flight upload/mockup request
    for (const c of abortControllersRef.current) {
      try { c.abort(); } catch { /* ignore */ }
    }
    abortControllersRef.current.clear();

    // Drop any queued audio so processQueue can't drain after stop
    audioQueuesRef.current = audioQueuesRef.current.map(() => []);
    isProcessingRefs.current = isProcessingRefs.current.map(() => false);

    setVibeMode(false);
    setSpeaking(false);
    setMockupGenerating(p => p.map(() => false));
    setMockupOutcome(null);
    if (mockupOutcomeTimerRef.current) clearTimeout(mockupOutcomeTimerRef.current);
    mockupBusyRefs.current = mockupBusyRefs.current.map(() => false);
    mockupQueuesRef.current = mockupQueuesRef.current.map(() => []);
    cuttingRef.current = false;
    if (cutWatchdogRef.current) { clearTimeout(cutWatchdogRef.current); cutWatchdogRef.current = null; }
    if (sliceTimerRef.current) { clearInterval(sliceTimerRef.current); sliceTimerRef.current = null; }
    if (pitchSampleIntervalRef.current) { clearInterval(pitchSampleIntervalRef.current); pitchSampleIntervalRef.current = null; }
    if (hearingResetRef.current) clearTimeout(hearingResetRef.current);
    if (recorderRef.current) {
      try { recorderRef.current.stopRecording(() => {}); } catch { /* ignore */ }
      try { recorderRef.current.destroy?.(); } catch { /* ignore */ }
      recorderRef.current = null;
    }
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    if (audioCtxRef.current?.state !== 'closed') audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    setSpeakerGenerating(p => p.map(() => false));
    setSpeakerStatuses(p => p.map(() => 'Idle'));
    setActiveSpeaker(null);
  };

  const toggleVibe = () => {
    if (vibeMode) stopVibeSession();
    else { setVibeMode(true); startVibeSession(); }
  };

  const resetSession = () => {
    stopVibeSession();
    // Detach from whatever saved session was open — a fresh start must never
    // autosave over it. restoreSessionSnapshot re-attaches right after calling this.
    activeSessionRef.current = null;
    mergeModeRef.current = false;
    setMergeMode(false);
    originalHistoriesRef.current = [];
    // Back to "How many minds are in the room?"
    participantCountRef.current = 1;
    setParticipantCount(null);
    setActiveSpeaker(null);
    setSpeaking(false);
    setMockupOutcome(null);
    // badgeDocked is NOT reset here — the badge-docking effect (keyed on
    // participantCount) already handles this. Setting it here directly caused a
    // real, visible flash: restoreSessionSnapshot calls resetSession() then
    // immediately restores participantCount, and this line forced one committed
    // render with the badge undocked in between, before the effect re-docked it.
    setBadgeLeftPx(null);
    setListenHint(null);
    setMicError(null);
    setAppMode('image');
    // Clear all session content so the next pick starts clean
    setSpeakerHistories([]);
    setSpeakerIndices([]);
    setSpeakerStatuses([]);
    setSpeakerGenerating([]);
    speakerHistoryRefs.current = [];
    audioQueuesRef.current = [];
    isProcessingRefs.current = [];
    setMockupStacks([]);
    setMockupCurrentIdxs([]);
    setMockupGenerating([]);
    setMockupErrors([]);
    setMockupActiveScreenIds([]);
    setMockupShowFlow([]);
    setMockupShowTranscript([]);
    setActiveMockupMind(0);
    mockupPreviousSpecRefs.current = [];
    mockupPendingRefs.current = [];
    mockupBusyRefs.current = [];
    mockupQueuesRef.current = [];
    mockupStacksRef.current = [];
  };

  // ── Merge all speakers into one unified channel ────────────────────────────
  const triggerMerge = async () => {
    // Preserve original histories so the merged channel has full context
    originalHistoriesRef.current = speakerHistories.map(h => [...h]);

    mergeModeRef.current = true;
    setMergeMode(true);
    setIsSynthesizing(true);
    participantCountRef.current = 1;

    // Reconfigure all arrays to single channel
    setSpeakerHistories([[]]);
    setSpeakerIndices([0]);
    setSpeakerStatuses(['Generating']);
    setSpeakerGenerating([true]);
    speakerHistoryRefs.current = [[]];
    audioQueuesRef.current = [[]];
    isProcessingRefs.current = [false];

    try {
      const formData = new FormData();
      formData.append(
        'histories_json',
        JSON.stringify(originalHistoriesRef.current.map(h => h.slice(-3)))
      );
      formData.append('demo_token', demoTokenRef.current);

      const res = await axios.post(`${API_BASE}/synthesize`, formData, {
        timeout: 180000, headers: authHeadersRef.current,
      });

      applyQuota(res.data);

      const hasMedia = !!(res.data.image_url || res.data.video_url || res.data.diagram_code);
      if (!res.data.error && hasMedia) {
        const newItem = { ...res.data, id: Date.now() };
        setSpeakerHistories([[newItem]]);
        speakerHistoryRefs.current[0] = [newItem];
        setSpeakerIndices([0]);
        setSpeakerStatuses(['Done']);
      } else {
        setSpeakerStatuses(['Failed']);
      }
    } catch (e) {
      console.error('Synthesis error:', e);
      setSpeakerStatuses(['Failed']);
    } finally {
      setIsSynthesizing(false);
      setSpeakerGenerating([false]);
      setTimeout(() => {
        setSpeakerStatuses(p => p.map(s =>
          (s === 'Done' || s === 'Failed') ? (vibeModeRef.current ? 'Waiting' : 'Idle') : s
        ));
      }, 2000);
    }
  };

  // ── Export session (images ZIP, or ALL iterations for the focused mockup mind) ────────
  const commitSession = async () => {
    // Mockup mode: export every iteration in the focused mind's stack
    if (appMode === 'mockup') {
      const mind = Math.max(0, Math.min(activeMockupMind, (mockupStacks.length || 1) - 1));
      const stack = (mockupStacks[mind] || []).filter(it => it?.spec);
      if (stack.length === 0) return;
      try {
        const formData = new FormData();
        formData.append('iterations_json', JSON.stringify(stack.map((it, i) => ({
          iterationNumber: it.iterationNumber ?? i + 1,
          spec: it.spec,
          transcript: it.transcript || '',
          changeLog: it.changeLog || it.spec?.changeLog || [],
        }))));
        const response = await axios.post(`${API_BASE}/mockup-export`, formData, {
          responseType: 'blob', timeout: 120000,
        });
        const blob = response.data;
        const cd = response.headers['content-disposition'] || '';
        const m = cd.match(/filename="?([^";]+)"?/i);
        const filename = m?.[1]?.trim()
          || (stack.length > 1
            ? `mind-${mind + 1}-buddy-mockup-${stack.length}-iterations.zip`
            : `mind-${mind + 1}-iteration-${String(stack[0].iterationNumber || 1).padStart(2, '0')}.zip`);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.rel = 'noopener';
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error('Mockup export error:', err);
      }
      return;
    }

    const allHistory = mergeMode
      ? speakerHistories[0]?.map(item => ({ ...item })) || []
      : speakerHistories.flatMap((h, si) =>
          h.map(item => ({ ...item, speaker_label: `Mind ${si + 1}` }))
        );

    if (allHistory.length === 0) return;

    try {
      const formData = new FormData();
      formData.append('history_json', JSON.stringify(
        allHistory.map(item => ({
          transcript: item.speaker_label ? `[${item.speaker_label}] ${item.transcript}` : item.transcript,
          visual_prompt: item.visual_prompt,
          image_url: item.image_url,
          mode: item.mode,
        }))
      ));

      const response = await axios.post(`${API_BASE}/commit-session`, formData, {
        responseType: 'blob', timeout: 120000,
      });
      const blob = response.data;
      const cd = response.headers['content-disposition'] || '';
      const m = cd.match(/filename="?([^";]+)"?/i);
      const filename = m?.[1]?.trim() || `consensus-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.zip`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Commit error:', err);
    }
  };

  const hasAnyHistory = appMode === 'mockup'
    ? mockupStacks.some(s => (s || []).length > 0)
    : speakerHistories.some(h => h.length > 0);

  // ── Save/restore work to the signed-in account ─────────────────────────
  const buildSessionSnapshot = () => ({
    appMode,
    participantCount,
    speakerHistories,
    speakerIndices,
    mockupStacks,
    mockupCurrentIdxs,
    mockupActiveScreenIds,
    mockupShowFlow,
    mockupShowTranscript,
    activeMockupMind,
  });

  const saveCurrentSession = async (title) => {
    const res = await axios.post(
      `${API_BASE}/sessions`,
      { title, data: buildSessionSnapshot() },
      { headers: auth.authHeaders },
    );
    // Adopt the new session so later generations auto-save into it.
    activeSessionRef.current = { id: res.data.id, title: res.data.title };
  };

  const restoreSessionSnapshot = (data, meta) => {
    if (!data) return;
    resetSession();
    // Track which saved session is on screen so new generations flow back into it.
    activeSessionRef.current = meta?.id ? { id: meta.id, title: meta.title } : null;
    setAppMode(data.appMode ?? 'image');
    setParticipantCount(data.participantCount ?? null);
    // The state above drives what renders; this ref drives array sizing every time
    // a vibe session starts (new Array(participantCountRef.current)...). resetSession
    // just above set it to 1, and nothing else here touched it — so continuing a
    // restored multi-speaker session would rebuild speakerStatuses etc. at length 1
    // against a longer speakerHistories, exactly the kind of mismatch that only a
    // 1-speaker session's stale-but-coincidentally-correct ref would hide.
    participantCountRef.current = data.participantCount || 1;
    setSpeakerHistories(data.speakerHistories ?? []);
    setSpeakerIndices(data.speakerIndices ?? []);
    setMockupStacks(data.mockupStacks ?? []);
    mockupStacksRef.current = data.mockupStacks ?? [];
    // The next generation for a mind is sent to the backend as a refinement of
    // mockupPreviousSpecRefs.current[idx], not of whatever's in mockupStacks — that
    // ref only gets sized (padded with null) by the participantCount effect below,
    // never filled with real data here. So continuing a restored session generated
    // a brand new, unrelated app from previous_spec_json: null every time, which is
    // what looked like the old session's work being wiped out.
    mockupPreviousSpecRefs.current = (data.mockupStacks ?? []).map(
      stack => (stack && stack.length > 0 ? stack[stack.length - 1].spec : null) ?? null
    );
    setMockupCurrentIdxs(data.mockupCurrentIdxs ?? []);
    setMockupActiveScreenIds(data.mockupActiveScreenIds ?? []);
    setMockupShowFlow(data.mockupShowFlow ?? []);
    setMockupShowTranscript(data.mockupShowTranscript ?? []);
    setActiveMockupMind(data.activeMockupMind ?? 0);
  };

  // Autosave: once a session is open (loaded or just saved), new generations flow
  // straight back into it. Debounced so a burst of rapid generations writes once,
  // and skipped entirely while a generation is still in flight.
  const anyGenerating = speakerGenerating.some(Boolean) || mockupGenerating.some(Boolean) || isSynthesizing;
  useEffect(() => {
    const active = activeSessionRef.current;
    if (!active?.id || !auth.user || anyGenerating || !hasAnyHistory) return undefined;
    const t = setTimeout(() => {
      axios.put(
        `${API_BASE}/sessions/${active.id}`,
        { title: active.title, data: buildSessionSnapshot() },
        { headers: authHeadersRef.current },
      ).then(() => setSessionsVersion(v => v + 1))
        .catch(() => { /* autosave is best-effort; the manual Save button still works */ });
    }, 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakerHistories, mockupStacks, anyGenerating, hasAnyHistory, auth.user]);

  const focusedMind = Math.max(0, Math.min(activeMockupMind, Math.max(0, (participantCount || 1) - 1)));
  const mockupAnyGenerating = mockupGenerating.some(Boolean);
  const multiMockup = appMode === 'mockup' && participantCount > 1;

  // Helpers for per-mind deck / screen navigation
  const setMindMockupCurrentIdx = (mindIdx, updater) => {
    setMockupCurrentIdxs(prev => {
      const n = prev.length === participantCount ? [...prev] : new Array(participantCount || 1).fill(0);
      const cur = n[mindIdx] ?? 0;
      n[mindIdx] = typeof updater === 'function' ? updater(cur) : updater;
      return n;
    });
  };
  const setMindMockupActiveScreenId = (mindIdx, id) => {
    setMockupActiveScreenIds(prev => {
      const n = prev.length === participantCount ? [...prev] : new Array(participantCount || 1).fill(null);
      n[mindIdx] = typeof id === 'function' ? id(n[mindIdx]) : id;
      return n;
    });
    setActiveMockupMind(mindIdx);
  };

  const canMerge = !mergeMode
    && participantCount > 1
    && speakerHistories.filter(h => h.length > 0).length >= 2;
  const totalUsed = DEMO_LIMIT - demoUsesLeft;
  // Multi-mind layouts lock to the viewport so cards fit without page scroll
  const crowdedImageLayout = appMode === 'image' && !mergeMode && participantCount >= 2;
  const crowdedMockupLayout = multiMockup && participantCount >= 2;

  // Status badge: appear bottom-left, then dock flush with the content's left edge
  const [badgeDocked, setBadgeDocked] = useState(false);
  const [badgeLeftPx, setBadgeLeftPx] = useState(null);
  const contentEdgeRef = useRef(null);
  const badgeIntroPlayedRef = useRef(false);

  useEffect(() => {
    if (participantCount == null) {
      // Do NOT reset badgeIntroPlayedRef here: restoreSessionSnapshot briefly nulls
      // participantCount via resetSession() before restoring it, and that must not
      // count as "leaving the app" and replay the drop-in intro a second time.
      setBadgeDocked(false);
      return undefined;
    }
    // The drop-then-dock is a one-time intro. Anything that changes the participant
    // count later (restoring saved work, for one) must not replay it, or the badge
    // visibly falls back down mid-session.
    if (badgeIntroPlayedRef.current) {
      setBadgeDocked(true);
      return undefined;
    }
    setBadgeDocked(false);
    const t = setTimeout(() => {
      badgeIntroPlayedRef.current = true;
      setBadgeDocked(true);
    }, 1100);
    return () => clearTimeout(t);
  }, [participantCount]);

  // Keep docked indicator glued to the left edge of mind panels / mockup content
  useEffect(() => {
    if (participantCount == null) return undefined;

    const measure = () => {
      const root = contentEdgeRef.current;
      if (!root) return;
      // Single-mind: align Buddy to the user-flow panel's left edge.
      // Multi-mind / image: fall back to the first mind panel.
      const target =
        root.querySelector('.flowchart-panel') ||
        root.querySelector('.mockup-mind-block') ||
        root.querySelector('.speaker-panel') ||
        root.querySelector('.mockup-with-flow') ||
        root.querySelector('.mockup-mode-wrap') ||
        root.querySelector('.flip-card') ||
        root.querySelector('.mockup-frame') ||
        root;
      const left = Math.round(target.getBoundingClientRect().left);
      // The badge docks at top:24px and the hamburger is fixed at the same height,
      // so any content edge near the left margin (the web mockup's flow column, in
      // particular) parks Buddy right on top of it. Never dock left of the button.
      const hamburger = document.querySelector('.hamburger-btn');
      const minLeft = hamburger
        ? Math.round(hamburger.getBoundingClientRect().right) + 14
        : 0;
      const docked = Math.max(left, minLeft);
      if (Number.isFinite(docked) && docked >= 0) setBadgeLeftPx(docked);
    };

    measure();
    const t1 = requestAnimationFrame(measure);
    const t2 = setTimeout(measure, 80);
    const t3 = setTimeout(measure, 400);
    // Re-measure when the badge docks so spring lands on the true edge
    const t4 = setTimeout(measure, 1100);

    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    const root = contentEdgeRef.current;
    const flowPanel = root?.querySelector('.flowchart-panel');
    if (ro && root) ro.observe(root);
    if (ro && flowPanel) ro.observe(flowPanel);
    window.addEventListener('resize', measure);
    return () => {
      cancelAnimationFrame(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [participantCount, appMode, mergeMode, mockupStacks, crowdedImageLayout, crowdedMockupLayout, badgeDocked, multiMockup]);

  // Unified buddy status — Listening ONLY while talking; Failed (not Done) when nothing was produced
  const displayStatus =
    (appMode === 'mockup' ? mockupAnyGenerating : (speakerStatuses.includes('Generating') || isSynthesizing))
      ? 'Generating'
      : (isSpeaking || speakerStatuses.includes('Hearing'))
        ? 'Listening'
        : (appMode === 'mockup'
          ? (mockupOutcome === 'Failed' ? 'Failed'
            : mockupOutcome === 'Done' ? 'Done'
            : vibeMode ? 'Waiting' : 'Idle')
          : speakerStatuses.includes('Failed') ? 'Failed'
            : speakerStatuses.includes('Done') ? 'Done'
            : vibeMode ? 'Waiting' : 'Idle');
  const statusImageSrc = STATUS_IMAGES[displayStatus] || STATUS_IMAGES.default;

  return (
    <div className={`app${appMode === 'mockup' ? ' app--mockup' : ''}${crowdedImageLayout || crowdedMockupLayout ? ' app--crowded-image' : ''}${(hasAnyHistory || crowdedImageLayout || crowdedMockupLayout) ? ' app--scrollable' : ''}${multiMockup ? ' app--multi-mockup' : ''}`}>

      {/* ── Login gate: sign in, sign up, or continue as a demo guest ──
          Waits on auth.ready so a returning signed-in visitor never sees the gate
          flash before the stored token is confirmed valid. */}
      <AnimatePresence>
        {auth.ready && !showApp && (
          <LoginGate auth={auth} onEnter={() => setEntered(true)} onDemo={() => setEntered(true)} />
        )}
      </AnimatePresence>

      {/* ── Guided walkthrough: 5-step spotlight tour for trial (unauthenticated) users ── */}
      <AnimatePresence>
        {showApp && !auth.user && walkthroughStep !== null && (
          <motion.div
            key="wt-overlay"
            className="wt-overlay"
            data-step={walkthroughStep}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          />
        )}
      </AnimatePresence>
      <AnimatePresence mode="wait">
        {showApp && !auth.user && walkthroughStep !== null && (
          <motion.div
            key={walkthroughStep}
            className="wt-card"
            style={WALKTHROUGH_STEPS[walkthroughStep].cardStyle}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
          >
            <span className="wt-num">{WALKTHROUGH_STEPS[walkthroughStep].num}</span>
            <h2 className="wt-title">{WALKTHROUGH_STEPS[walkthroughStep].title}</h2>
            <p className="wt-body">{WALKTHROUGH_STEPS[walkthroughStep].body}</p>
            <div className="wt-actions">
              <button type="button" className="wt-skip" onClick={finishWalkthrough}>skip</button>
              <button type="button" className="wt-next" onClick={advanceWalkthrough}>
                {walkthroughStep === WALKTHROUGH_STEPS.length - 1 ? "let's go" : 'next'}
              </button>
            </div>
            <div className="wt-dots">
              {WALKTHROUGH_STEPS.map((_, i) => (
                <span key={i} className={`wt-dot${i === walkthroughStep ? ' wt-dot--active' : ''}`} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* While waiting on /auth/me: with nothing here, a saved login plus a cold
          backend (Cloud Run scales to zero when idle) meant a genuinely blank white
          screen for however long that first request took, with no sign anything was
          happening. */}
      {!auth.ready && (
        <div className="auth-loading-screen">
          <img src="/images/buddyname.svg" alt="Buddy" className="auth-loading-logo" />
          <div className="auth-loading-spinner" />
        </div>
      )}

      {/* Sign-in triggered from inside the app (header button, "sign up free" prompt) —
          same full-page gate, but dismissible since a demo session is already underway. */}
      {showLoginGate && (
        <LoginGate
          auth={auth}
          onEnter={() => setShowLoginGate(false)}
          onCancel={() => setShowLoginGate(false)}
        />
      )}

      {/* ── Participant selector ── */}
      <AnimatePresence>
        {showApp && participantCount === null && (
          <ParticipantSelector onSelect={initializeSpeakers} />
        )}
      </AnimatePresence>

      {/* ── Main app ── */}
      {showApp && participantCount !== null && (
        <>
          {/* Mode toggle — shared on/off switch for Image ↔ Mockup */}
          <div className={`mode-toggle-row mode-toggle-row--chrome${vibeMode ? ' mode-toggle-row--locked' : ''}`}>
            <div
              className={`mode-toggle-switch${appMode === 'mockup' ? ' mode-toggle-switch--mockup' : ' mode-toggle-switch--image'}`}
              role="group"
              aria-label="Mode"
            >
              <span className="mode-toggle-thumb" aria-hidden="true" />
              <button
                type="button"
                className={`mode-toggle-pill${appMode === 'image' ? ' mode-toggle-pill--active' : ''}${vibeMode ? ' mode-toggle-pill--locked' : ''}`}
                onClick={() => { if (!vibeMode) setAppMode('image'); }}
                title={vibeMode ? 'Stop session to switch mode' : undefined}
                aria-pressed={appMode === 'image'}
              >
                Image
              </button>
              <button
                type="button"
                className={`mode-toggle-pill${appMode === 'mockup' ? ' mode-toggle-pill--active' : ''}${vibeMode ? ' mode-toggle-pill--locked' : ''}`}
                onClick={() => { if (!vibeMode) setAppMode('mockup'); }}
                title={vibeMode ? 'Stop session to switch mode' : undefined}
                aria-pressed={appMode === 'mockup'}
              >
                Mockup
              </button>
            </div>
          </div>

          {/* Only the panels / mockup scroll */}
          <div className="app-scroll">
          <div className={`app-inner${participantCount > 1 && !mergeMode ? ' app-inner--wide' : ''}`}>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }}
              className="app-main"
            >
              <div className="mode-content-slot" ref={contentEdgeRef}>
              {/* ── Image mode panels — say "make a video of..." and it auto-produces video ── */}
              {appMode === 'image' && (
                <>
                  <AnimatePresence mode="wait">
                    {mergeMode ? (
                      <motion.div
                        key="merged"
                        className="panels-row panels-row--1"
                        initial={{ opacity: 0, scale: 0.96 }}
                        animate={{ opacity: 1, scale: 1 }}
                        transition={{ duration: 0.5, ease: 'easeOut' }}
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          blobTargetRef.current = { x: (e.clientX - rect.left) / rect.width - 0.5, y: (e.clientY - rect.top) / rect.height - 0.5 };
                        }}
                        onMouseLeave={() => { blobTargetRef.current = { x: 0, y: 0 }; }}
                      >
                        <SpeakerPanel
                          index={0}
                          count={1}
                          history={speakerHistories[0] || []}
                          currentIndex={speakerIndices[0] || 0}
                          status={speakerStatuses[0] || 'Idle'}
                          isGenerating={speakerGenerating[0] || isSynthesizing}
                          blobPos={blobPos}
                          isMerged={true}
                          isVideoMode={speakerHistories[0]?.slice(-1)[0]?.mode === 'VIDEO'}
                          onPrev={() => setSpeakerIndices(p => { const n=[...p]; n[0]=Math.max(0,n[0]-1); return n; })}
                          onNext={() => setSpeakerIndices(p => { const n=[...p]; n[0]=Math.min((speakerHistories[0]||[]).length-1,n[0]+1); return n; })}
                        />
                      </motion.div>
                    ) : (
                      <motion.div
                        key="split"
                        className={`panels-row panels-row--${participantCount}`}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0, scale: 0.94 }}
                        transition={{ duration: 0.4, ease: 'easeIn' }}
                        onMouseMove={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          blobTargetRef.current = { x: (e.clientX - rect.left) / rect.width - 0.5, y: (e.clientY - rect.top) / rect.height - 0.5 };
                        }}
                        onMouseLeave={() => { blobTargetRef.current = { x: 0, y: 0 }; }}
                      >
                        {Array.from({ length: participantCount }).map((_, i) => (
                          <SpeakerPanel
                            key={i}
                            index={i}
                            count={participantCount}
                            history={speakerHistories[i] || []}
                            currentIndex={speakerIndices[i] || 0}
                            status={speakerStatuses[i] || 'Idle'}
                            isGenerating={speakerGenerating[i] || false}
                            blobPos={blobPos}
                            isMerged={false}
                            vibeMode={vibeMode}
                            isVideoMode={speakerHistories[i]?.slice(-1)[0]?.mode === 'VIDEO'}
                            isActiveSpeaker={activeSpeaker === i}
                            onClaim={() => setActiveSpeaker(prev => prev === i ? null : i)}
                            onPrev={() => setSpeakerIndices(p => { const n=[...p]; n[i]=Math.max(0,n[i]-1); return n; })}
                            onNext={() => setSpeakerIndices(p => { const n=[...p]; n[i]=Math.min((speakerHistories[i]||[]).length-1,n[i]+1); return n; })}
                          />
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>

                  {/* Unite Visions button */}
                  <AnimatePresence>
                    {canMerge && (
                      <motion.div
                        key="merge-cta"
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 6 }}
                        transition={{ duration: 0.35, ease: 'easeOut' }}
                        style={{ display: 'flex', justifyContent: 'center', marginTop: '18px' }}
                      >
                        <button type="button" className="merge-btn" onClick={triggerMerge}>
                          <span className="merge-btn-icon">✦</span>
                          Unite Visions
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}

              {/* ── Mockup mode ── */}
              {appMode === 'mockup' && (
                <MockupErrorBoundary onReset={resetSession}>
                {multiMockup ? (
                  /* Multi-mind: SAME grid + stage classes as Image so purple boxes cannot diverge */
                  <div
                    className={`panels-row panels-row--${participantCount}`}
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      blobTargetRef.current = { x: (e.clientX - rect.left) / rect.width - 0.5, y: (e.clientY - rect.top) / rect.height - 0.5 };
                    }}
                    onMouseLeave={() => { blobTargetRef.current = { x: 0, y: 0 }; }}
                  >
                    {Array.from({ length: participantCount }).map((_, mindIdx) => {
                      const stack = mockupStacks[mindIdx] || [];
                      const rawIdx = mockupCurrentIdxs[mindIdx] ?? 0;
                      const curIdx = stack.length ? Math.max(0, Math.min(rawIdx, stack.length - 1)) : 0;
                      const gen = !!mockupGenerating[mindIdx];
                      const err = mockupErrors[mindIdx] || null;
                      const latestSpec = stack[stack.length - 1]?.spec || null;
                      const currentIter = stack[curIdx] || null;
                      const isOnLatest = stack.length > 0 && curIdx === stack.length - 1;
                      const screenId = mockupActiveScreenIds[mindIdx] || latestSpec?.screens?.[0]?.id || null;
                      const color = SPEAKER_COLORS[mindIdx % SPEAKER_COLORS.length];
                      const isActive = gen || speakerStatuses[mindIdx] === 'Hearing';
                      const showFlow = !!mockupShowFlow[mindIdx];
                      const showTranscript = !!mockupShowTranscript[mindIdx];
                      // Scaled site width/height ratio — used to hug the header buttons
                      // to the visible edges of the generated site (which is centered
                      // inside the card with gutters when aspect ratios differ).
                      const surfaceSpec = currentIter?.spec || latestSpec;
                      const iterPlatform = String(surfaceSpec?.platform || surfaceSpec?.formFactor || '').toLowerCase();
                      const iterIsWeb = ['web', 'website', 'desktop', 'browser'].includes(iterPlatform);
                      const mockAspect = iterIsWeb ? 900 / 560 : 402 / 874;
                      const hasSurface = !!surfaceSpec;
                      return (
                        <MockupErrorBoundary key={`mind-${mindIdx}`} onReset={resetSession}>
                          <div
                            id={`mockup-phone-${mindIdx}`}
                            className={`speaker-panel${isActive ? ' speaker-panel--mockup-active' : ''}`}
                            style={hasSurface ? { '--mock-aspect': mockAspect } : undefined}
                            onClick={() => {
                              setActiveMockupMind(mindIdx);
                              if (vibeMode) setActiveSpeaker(mindIdx);
                            }}
                          >
                            <div className={`mockup-cell-header${hasSurface ? ' mockup-cell-header--hug' : ''}`}>
                              <div className="mockup-cell-actions mockup-cell-actions--left">
                                <button
                                  type="button"
                                  className={`mockup-flow-toggle${showFlow ? ' mockup-flow-toggle--active' : ''}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMockupShowFlow(p => {
                                      const n = p.length === participantCount ? [...p] : new Array(participantCount).fill(false);
                                      n[mindIdx] = !n[mindIdx];
                                      return n;
                                    });
                                    // Don't keep transcript flipped under the flow layer
                                    if (!showFlow) {
                                      setMockupShowTranscript(p => {
                                        const n = p.length === participantCount ? [...p] : new Array(participantCount).fill(false);
                                        n[mindIdx] = false;
                                        return n;
                                      });
                                    }
                                  }}
                                  title={showFlow ? 'Back to the mockup' : 'See the user flow'}
                                >
                                  {showFlow ? 'mockup' : 'user flow'}
                                </button>
                              </div>
                              <div className={`speaker-label speaker-label--phone${activeSpeaker === mindIdx ? ' speaker-label--claimed' : ''}`}>
                                <span className="speaker-label-dot" style={{ background: color }} />
                                <span className="speaker-label-text">Mind {mindIdx + 1}</span>
                                {isActive && <span className="speaker-active-dot" style={{ background: color }} />}
                                {vibeMode && (
                                  <button
                                    type="button"
                                    className={`speaker-claim-btn${activeSpeaker === mindIdx ? ' speaker-claim-btn--active' : ''}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setActiveSpeaker(prev => prev === mindIdx ? null : mindIdx);
                                      setActiveMockupMind(mindIdx);
                                    }}
                                    title={activeSpeaker === mindIdx ? 'Release panel' : 'Tap to claim this panel'}
                                  >
                                    {activeSpeaker === mindIdx ? 'talking' : '🎤'}
                                  </button>
                                )}
                              </div>
                              <div className="mockup-cell-actions mockup-cell-actions--right">
                                {currentIter && (
                                  <button
                                    type="button"
                                    className={`mockup-flow-toggle mockup-transcript-toggle${showTranscript ? ' mockup-flow-toggle--active' : ''}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setMockupShowTranscript(p => {
                                        const n = p.length === participantCount ? [...p] : new Array(participantCount).fill(false);
                                        n[mindIdx] = !n[mindIdx];
                                        return n;
                                      });
                                      // Leave user-flow mode so the shared website/transcript layer is visible
                                      if (showFlow) {
                                        setMockupShowFlow(p => {
                                          const n = p.length === participantCount ? [...p] : new Array(participantCount).fill(false);
                                          n[mindIdx] = false;
                                          return n;
                                        });
                                      }
                                    }}
                                    title={showTranscript ? 'Back to mockup' : 'See transcript'}
                                  >
                                    {showTranscript ? 'mockup' : 'transcript'}
                                  </button>
                                )}
                              </div>
                            </div>
                            <div className={`stage speaker-stage${hasSurface ? ' stage--mockup-live' : ''}`}>
                              {currentIter ? (
                                <>
                                  <div
                                    className={`mockup-stage-layer mockup-stage-layer--flow${showFlow ? ' mockup-stage-layer--active' : ''}`}
                                    aria-hidden={!showFlow}
                                  >
                                    <div className="mockup-stage-fill mockup-stage-fill--site-sized">
                                      <FlowChart
                                        spec={surfaceSpec}
                                        activeScreenId={screenId}
                                        onSelectScreen={(id) => {
                                          setMindMockupActiveScreenId(mindIdx, id);
                                          if (stack.length > 0) setMindMockupCurrentIdx(mindIdx, stack.length - 1);
                                        }}
                                        onRewire={(fromId, toId) => handleFlowRewire(fromId, toId, mindIdx)}
                                      />
                                    </div>
                                  </div>
                                  <div
                                    className={`mockup-stage-layer mockup-stage-layer--website${!showFlow ? ' mockup-stage-layer--active' : ''}`}
                                    aria-hidden={showFlow}
                                  >
                                    <div className="mockup-stage-fill mockup-stage-fill--site-sized">
                                      <FlipCard
                                        key={`mockup-m${mindIdx}`}
                                        compact
                                        flipped={showTranscript}
                                        onToggleFlip={() => setMockupShowTranscript(p => {
                                          const n = p.length === participantCount ? [...p] : new Array(participantCount).fill(false);
                                          n[mindIdx] = !n[mindIdx];
                                          return n;
                                        })}
                                        hideToggle
                                        iterations={stack}
                                        front={
                                          <MockupRenderer
                                            spec={currentIter.spec}
                                            scaleToFit
                                            activeScreenId={isOnLatest ? screenId : undefined}
                                            onScreenChange={isOnLatest
                                              ? (id) => setMindMockupActiveScreenId(mindIdx, id)
                                              : undefined}
                                          />
                                        }
                                        transcript={currentIter.transcript}
                                        changeLog={currentIter.changeLog}
                                        iterationNumber={currentIter.iterationNumber}
                                      />
                                    </div>
                                  </div>
                                  {!showFlow && stack.length > 1 && (
                                    <div className="mockup-deck-nav mockup-deck-nav--overlay">
                                      <button
                                        type="button"
                                        className="mockup-nav-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setMindMockupCurrentIdx(mindIdx, i => Math.max(0, i - 1));
                                        }}
                                        disabled={curIdx === 0}
                                      >
                                        ‹
                                      </button>
                                      <span className="mockup-nav-label">{curIdx + 1} / {stack.length}</span>
                                      <button
                                        type="button"
                                        className="mockup-nav-btn"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setMindMockupCurrentIdx(mindIdx, i => Math.min(stack.length - 1, i + 1));
                                        }}
                                        disabled={curIdx === stack.length - 1}
                                      >
                                        ›
                                      </button>
                                    </div>
                                  )}
                                  {!showFlow && gen && <div className="mockup-live-dot" title="Processing..." />}
                                </>
                              ) : showFlow ? (
                                <div className="mockup-stage-fill mockup-stage-fill--site-sized">
                                  <FlowChart
                                    spec={surfaceSpec}
                                    activeScreenId={screenId}
                                    onSelectScreen={(id) => {
                                      setMindMockupActiveScreenId(mindIdx, id);
                                      if (stack.length > 0) setMindMockupCurrentIdx(mindIdx, stack.length - 1);
                                    }}
                                    onRewire={(fromId, toId) => handleFlowRewire(fromId, toId, mindIdx)}
                                  />
                                </div>
                              ) : stack.length === 0 && !gen && !err ? (
                                <div className="stage-empty stage-empty--blobs">
                                  <EmptyBlobs blobPos={blobPos} />
                                </div>
                              ) : stack.length === 0 && gen ? (
                                <div className="stage-empty stage-empty--blobs mockup-generating-state">
                                  <EmptyBlobs blobPos={blobPos} />
                                  <div className="mockup-spinner" />
                                  <p>building…</p>
                                </div>
                              ) : err === 'oops' && stack.length === 0 ? (
                                <div className="stage-empty stage-empty--blobs mockup-oops-state">
                                  <EmptyBlobs blobPos={blobPos} />
                                  <p>oops, try again</p>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        </MockupErrorBoundary>
                      );
                    })}
                  </div>
                ) : (
                  /* Single mind: original side-by-side flow + mockup */
                  (() => {
                    const mindIdx = 0;
                    const stack = mockupStacks[0] || [];
                    const rawIdx = mockupCurrentIdxs[0] ?? 0;
                    const curIdx = stack.length ? Math.max(0, Math.min(rawIdx, stack.length - 1)) : 0;
                    const gen = !!mockupGenerating[0];
                    const err = mockupErrors[0] || null;
                    const latestSpec = stack[stack.length - 1]?.spec || null;
                    const currentIter = stack[curIdx] || null;
                    const currentSpec = currentIter?.spec || latestSpec;
                    const isWeb = ['web', 'website', 'desktop', 'browser'].includes(
                      String(currentSpec?.platform || currentSpec?.formFactor || '').toLowerCase()
                    );
                    const isOnLatest = stack.length > 0 && curIdx === stack.length - 1;
                    const screenId = mockupActiveScreenIds[0] || latestSpec?.screens?.[0]?.id || null;
                    const screenCount = latestSpec?.screens?.length || currentSpec?.screens?.length || 0;
                    const singleScreen = screenCount <= 1;
                    return (
                      <div className={`mockup-with-flow${isWeb ? ' mockup-with-flow--web' : ''}${singleScreen ? ' mockup-with-flow--single-screen' : ''}`}>
                        <div className="flowchart-panel">
                          <FlowChart
                            spec={currentSpec}
                            activeScreenId={screenId}
                            onSelectScreen={(id) => {
                              setMindMockupActiveScreenId(0, id);
                              if (stack.length > 0) setMindMockupCurrentIdx(0, stack.length - 1);
                            }}
                            onRewire={(fromId, toId) => handleFlowRewire(fromId, toId, 0)}
                          />
                        </div>
                        {stack.length > 0 && <div className="flow-connector" aria-hidden="true">→</div>}
                        <div
                          className="mockup-mode-wrap"
                          onMouseMove={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            blobTargetRef.current = { x: (e.clientX - rect.left) / rect.width - 0.5, y: (e.clientY - rect.top) / rect.height - 0.5 };
                          }}
                          onMouseLeave={() => { blobTargetRef.current = { x: 0, y: 0 }; }}
                        >
                          <div className="mockup-deck">
                            {stack.length === 0 && !gen && !err && (
                              <div className="mockup-frame mockup-empty-state mockup-frame--blobs">
                                <EmptyBlobs blobPos={blobPos} />
                              </div>
                            )}
                            {stack.length === 0 && gen && (
                              <div className="mockup-frame mockup-generating-state mockup-frame--blobs">
                                <EmptyBlobs blobPos={blobPos} />
                                <div className="mockup-spinner" />
                                <p>listening...</p>
                              </div>
                            )}
                            {err === 'oops' && stack.length === 0 && (
                              <div className="mockup-frame mockup-oops-state mockup-frame--blobs">
                                <EmptyBlobs blobPos={blobPos} />
                                <p>oops, i messed up, let's try again</p>
                              </div>
                            )}
                            {currentIter && (
                              <>
                                <FlipCard
                                  key="mockup-m0"
                                  iterations={stack}
                                  front={
                                    <MockupRenderer
                                      spec={currentIter.spec}
                                      scaleToFit
                                      activeScreenId={isOnLatest ? screenId : undefined}
                                      onScreenChange={isOnLatest
                                        ? (id) => setMindMockupActiveScreenId(0, id)
                                        : undefined}
                                    />
                                  }
                                  transcript={currentIter.transcript}
                                  changeLog={currentIter.changeLog}
                                  iterationNumber={currentIter.iterationNumber}
                                />
                                {stack.length > 1 && (
                                  <div className="mockup-deck-nav">
                                    <button type="button" className="mockup-nav-btn" onClick={() => setMindMockupCurrentIdx(0, i => Math.max(0, i - 1))} disabled={curIdx === 0}>‹</button>
                                    <span className="mockup-nav-label">{curIdx + 1} / {stack.length}</span>
                                    <button type="button" className="mockup-nav-btn" onClick={() => setMindMockupCurrentIdx(0, i => Math.min(stack.length - 1, i + 1))} disabled={curIdx === stack.length - 1}>›</button>
                                  </div>
                                )}
                                {gen && <div className="mockup-live-dot" title="Processing next chunk..." />}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })()
                )}
                </MockupErrorBoundary>
              )}
              </div>
            </motion.div>
          </div>
          </div>{/* /.app-scroll */}

          {/* Same layout model as Image/Mockup: flex sibling outside scroll, not position:fixed */}
          <div className="app-bottom-bar">
            <div className={`controls${hasAnyHistory ? ' controls-caption' : ''}`}>
              <div className="controls-inner">
                <LiquidButton active={vibeMode} onClick={toggleVibe} demoComplete={!unlimited && demoUsesLeft === 0} />
                <div className="controls-tags-row">
                  {/* Numbered pills only make sense for the tiny anonymous allowance —
                      an account has 100, so it gets a plain count instead. */}
                  {/* Paid accounts show nothing here — the "✦ Unlimited" tag lives in
                      the sidebar under Manage subscription instead. */}
                  {unlimited ? null : generationLimit === DEMO_LIMIT ? (
                    <div className="demo-tags" aria-label={`${demoUsesLeft} of ${DEMO_LIMIT} generations left`}>
                      {Array.from({ length: DEMO_LIMIT }).map((_, i) => {
                        const used = i < totalUsed;
                        return (
                          <span
                            key={i}
                            className={`demo-tag${used ? ' demo-tag--used' : ''}`}
                            title={used ? `Generation ${i + 1} used` : `Generation ${i + 1} available`}
                          >
                            {i + 1}
                          </span>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="demo-tags" aria-label={`${demoUsesLeft} of ${generationLimit} generations left`}>
                      <span className="demo-count">{demoUsesLeft} / {generationLimit}</span>
                    </div>
                  )}
                </div>
                <div className="controls-meta">
                  {micError
                    ? <span className="controls-meta-error">{micError}</span>
                    : listenHint
                      ? <span className="controls-meta-hint">{listenHint}</span>
                      : unlimited
                        // The "✦ Unlimited" pill above already says it — no need to repeat it as prose.
                        ? ''
                        : demoUsesLeft === 0
                          ? (auth.user
                              ? (auth.user.billing_enabled
                                  ? <span>out of generations, <button type="button" className="inline-upgrade-link" onClick={() => { setUpgradeReason(null); setShowUpgrade(true); }}>upgrade for unlimited</button></span>
                                  : <span>out of generations, <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a></span>)
                              : <span>want more? <button type="button" className="inline-upgrade-link" onClick={() => setShowLoginGate(true)}>sign up free</button></span>)
                          // The account tier already shows "99 / 100" in the pill above —
                          // repeating it here as prose is redundant. Anonymous demo users
                          // don't get that pill, so they keep the spelled-out count.
                          : generationLimit === DEMO_LIMIT
                            ? `${demoUsesLeft} of ${generationLimit} generations left`
                            : ''}
                </div>
              </div>
            </div>
          </div>

          {/* Header chrome on <body> so it never scrolls with panels */}
          {createPortal(
            <>
              <motion.div
                className={`status-badge-wrapper${badgeDocked ? ' status-badge-wrapper--docked' : ''}`}
                title={badgeDocked ? displayStatus : undefined}
                initial={{ top: '78%', left: '4%' }}
                animate={badgeDocked
                  ? {
                      top: 24,
                      left: badgeLeftPx != null ? badgeLeftPx : 'var(--app-padding)',
                    }
                  : { top: '78%', left: '4%' }}
                transition={{
                  type: 'spring',
                  stiffness: 68,
                  damping: 15,
                  mass: 0.9,
                }}
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={statusImageSrc}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.22 }}
                    className="status-badge-inner"
                  >
                    <img
                      src={statusImageSrc}
                      alt={`Status: ${displayStatus}`}
                      style={{ pointerEvents: 'none' }}
                      className={`status-badge-label${displayStatus === 'Generating' ? ' status-badge-label--spinning' : ''}`}
                      draggable={false}
                    />
                    <span className="status-text" style={{ color: STATUS_COLORS[displayStatus] ?? STATUS_COLORS.default }}>
                      {displayStatus}
                    </span>
                  </motion.div>
                </AnimatePresence>
              </motion.div>

              <div className="header-actions">
                {hasAnyHistory && (
                  <button type="button" onClick={commitSession} className="commit-btn" aria-label="Export session">
                    <img src="/images/commit-arrow.png" alt="Export" className="w-6 h-6 object-contain pointer-events-none select-none" />
                  </button>
                )}
                <button type="button" onClick={resetSession} className="restart-btn" aria-label="Reset">
                  <RotateCcw size={19} strokeWidth={2} />
                </button>
              </div>

              {!sidebarOpen && (
                <button
                  type="button"
                  className="hamburger-btn"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Open menu"
                >
                  <Menu size={19} strokeWidth={2} />
                </button>
              )}
              <Sidebar
                open={sidebarOpen}
                onClose={() => setSidebarOpen(false)}
                auth={auth}
                apiBase={API_BASE}
                contactEmail={CONTACT_EMAIL}
                onLoadSession={restoreSessionSnapshot}
                canSaveCurrent={hasAnyHistory}
                onSaveCurrent={saveCurrentSession}
                sessionsVersion={sessionsVersion}
                onOpenUpgrade={() => { setUpgradeReason(null); setShowUpgrade(true); }}
                onOpenPortal={auth.openBillingPortal}
                onSignOut={() => { auth.logout(); setEntered(false); }}
                onSignUp={() => setShowLoginGate(true)}
              />
            </>,
            document.body,
          )}

          {showUpgrade && (
            createPortal(
              <UpgradeModal
                auth={auth}
                reason={upgradeReason}
                onClose={() => setShowUpgrade(false)}
              />,
              document.body,
            )
          )}
          {showUpgradeSuccess && (
            createPortal(
              <div className="access-notice-backdrop" onClick={() => upgradeConfirmed && setShowUpgradeSuccess(false)}>
                <div className="access-notice-card" onClick={(e) => e.stopPropagation()}>
                  {upgradeConfirmed ? (
                    <>
                      <h2 className="access-notice-title">You're upgraded</h2>
                      <p className="access-notice-body">
                        Payment confirmed. Unlimited generations and unlimited video are unlocked on your account.
                      </p>
                      <button
                        type="button"
                        className="access-notice-btn"
                        onClick={() => setShowUpgradeSuccess(false)}
                      >
                        Continue
                      </button>
                    </>
                  ) : upgradePollDone ? (
                    <>
                      <h2 className="access-notice-title">Payment received</h2>
                      <p className="access-notice-body">
                        Stripe confirmed the payment. Your account is still finishing setup, this can take a few
                        extra seconds. Refresh in a moment if "Unlimited" doesn't show up yet.
                      </p>
                      <button
                        type="button"
                        className="access-notice-btn"
                        onClick={() => setShowUpgradeSuccess(false)}
                      >
                        Continue
                      </button>
                    </>
                  ) : (
                    <>
                      <h2 className="access-notice-title">Confirming your upgrade…</h2>
                      <p className="access-notice-body">
                        Checking in with Stripe. This only takes a moment.
                      </p>
                    </>
                  )}
                </div>
              </div>,
              document.body,
            )
          )}
        </>
      )}
    </div>
  );
}
