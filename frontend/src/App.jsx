import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import RecordRTC from 'recordrtc';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import mermaid from 'mermaid';

mermaid.initialize({
  startOnLoad: true,
  theme: 'base',
  securityLevel: 'loose',
  flowchart: { useMaxWidth: true },
  pie: { useMaxWidth: true },
  xychart: { width: 800, height: 500 },
  themeVariables: { fontSize: '18px' },
});

const API_BASE = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '');
const CONTACT_EMAIL = (import.meta.env.VITE_CONTACT_EMAIL || 'failennaselta@gmail.com').trim();
const DEMO_TOKEN_KEY = 'buddy_demo_token';
const DEMO_REMAINING_KEY = 'buddy_demo_remaining';
const DEMO_LIMIT = 3;

const SPEAKER_COLORS = ['#7c5cfc', '#0891b2', '#d97706', '#16a34a', '#dc2626', '#9333ea'];

// Find the dominant vocal frequency (80–320 Hz) in FFT data.
function detectDominantPitch(analyser, sampleRate) {
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Float32Array(bufferLength);
  analyser.getFloatFrequencyData(dataArray);
  const binSize = sampleRate / (2 * bufferLength);
  const minBin = Math.max(1, Math.floor(80 / binSize));
  const maxBin = Math.min(bufferLength - 1, Math.floor(320 / binSize));
  let maxVal = -Infinity;
  let maxBinIdx = minBin;
  for (let i = minBin; i <= maxBin; i++) {
    if (dataArray[i] > maxVal) { maxVal = dataArray[i]; maxBinIdx = i; }
  }
  if (maxVal < -55) return null;
  return maxBinIdx * binSize;
}

// Map median pitch for a 5-second window to one of N speaker lanes.
function assignSpeaker(pitchSamples, count) {
  if (count <= 1 || pitchSamples.length === 0) return 0;
  const sorted = [...pitchSamples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const MIN = 80, MAX = 320;
  const clamped = Math.max(MIN, Math.min(MAX - 1, median));
  const bucket = Math.floor((clamped - MIN) / (MAX - MIN) * count);
  return Math.min(bucket, count - 1);
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

// ─── Single speaker panel ─────────────────────────────────────────────────────
function SpeakerPanel({ index, count, history, currentIndex, onPrev, onNext, status, isGenerating, blobPos, isMerged }) {
  const mermaidNodeRef = useRef(null);
  const [imgError, setImgError] = useState(false);
  const currentItem = history[currentIndex];
  const color = isMerged ? null : SPEAKER_COLORS[index % SPEAKER_COLORS.length];
  const isActive = isGenerating || status === 'Hearing';

  useEffect(() => { setImgError(false); }, [currentIndex]);

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
        <div className={`speaker-label${isMerged ? ' speaker-label--merged' : ''}`}>
          {!isMerged && <span className="speaker-label-dot" style={{ background: color }} />}
          {isMerged
            ? <span className="speaker-label-text speaker-label-text--merged">Shared Vision</span>
            : <span className="speaker-label-text">Mind {index + 1}</span>
          }
          {isActive && <span className="speaker-active-dot" style={isMerged ? {} : { background: color }} />}
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
                <>
                  <div style={{ position: 'absolute', inset: 0, transform: `translate(${blobPos[0].x * 200}px,${blobPos[0].y * 150}px)` }}><div className="blob blob-1" /></div>
                  <div style={{ position: 'absolute', inset: 0, transform: `translate(${blobPos[1].x * 150}px,${blobPos[1].y * 110}px)` }}><div className="blob blob-2" /></div>
                  <div style={{ position: 'absolute', inset: 0, transform: `translate(${blobPos[2].x * 260}px,${blobPos[2].y * 190}px)` }}><div className="blob blob-3" /></div>
                </>
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
              ) : !currentItem.image_url ? (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-black/80">
                  <div className="text-4xl mb-4">⚠️</div>
                  <p className="text-red-400 font-bold mb-2">Image Generation Failed</p>
                </div>
              ) : imgError ? (
                <div className="w-full h-full flex flex-col items-center justify-center p-8 text-center bg-black/80">
                  <div className="text-4xl mb-4">❌</div>
                  <p className="text-red-400 font-bold mb-2">Failed to Load</p>
                </div>
              ) : currentItem.image_url?.endsWith('.mp4') ? (
                <video src={currentItem.image_url} className="stage-media" autoPlay loop muted playsInline />
              ) : (
                <img src={currentItem.image_url} alt="Generated" className="stage-media" onError={() => setImgError(true)} />
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

      {(status === 'Generating' || status === 'Done') && (
        <div
          className="panel-status"
          style={{ color: status === 'Done' ? '#16a34a' : (isMerged ? '#7c5cfc' : color) }}
        >
          {status === 'Generating' ? 'Generating...' : 'Done'}
        </div>
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [introPhase, setIntroPhase] = useState(0);
  const [vibeMode, setVibeMode] = useState(false);
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

  // Demo token
  const [demoToken, setDemoToken] = useState(() => {
    try { return localStorage.getItem(DEMO_TOKEN_KEY) || ''; } catch { return ''; }
  });
  const [demoUsesLeft, setDemoUsesLeft] = useState(() => {
    try {
      const s = localStorage.getItem(DEMO_REMAINING_KEY);
      return s !== null ? parseInt(s, 10) : DEMO_LIMIT;
    } catch { return DEMO_LIMIT; }
  });

  // Intro timing
  useEffect(() => {
    if (introPhase === 0) { const t = setTimeout(() => setIntroPhase(1), 1500); return () => clearTimeout(t); }
    if (introPhase === 1) { const t = setTimeout(() => setIntroPhase(2), 800); return () => clearTimeout(t); }
  }, [introPhase]);

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
    setParticipantCount(count);
  };

  // ── Per-speaker generation queue ───────────────────────────────────────────
  const processQueue = async (speakerIdx) => {
    if (isProcessingRefs.current[speakerIdx] || !audioQueuesRef.current[speakerIdx]?.length) return;
    isProcessingRefs.current[speakerIdx] = true;
    const blob = audioQueuesRef.current[speakerIdx].shift();

    setSpeakerStatuses(p => { const n = [...p]; n[speakerIdx] = 'Generating'; return n; });
    setSpeakerGenerating(p => { const n = [...p]; n[speakerIdx] = true; return n; });

    const timeoutId = setTimeout(() => {
      setSpeakerGenerating(p => { const n = [...p]; n[speakerIdx] = false; return n; });
      setSpeakerStatuses(p => { const n = [...p]; n[speakerIdx] = 'Idle'; return n; });
      isProcessingRefs.current[speakerIdx] = false;
    }, 60000);

    try {
      await sendAudio(blob, speakerIdx);
      clearTimeout(timeoutId);
    } catch (e) {
      clearTimeout(timeoutId);
      console.error('Speaker', speakerIdx, 'queue error:', e);
    } finally {
      clearTimeout(timeoutId);
      isProcessingRefs.current[speakerIdx] = false;
      setSpeakerGenerating(p => { const n = [...p]; n[speakerIdx] = false; return n; });
      if (audioQueuesRef.current[speakerIdx]?.length > 0) {
        processQueue(speakerIdx);
      } else {
        setSpeakerStatuses(p => { const n = [...p]; n[speakerIdx] = 'Done'; return n; });
        setTimeout(() => {
          setSpeakerStatuses(p => {
            const n = [...p];
            if (n[speakerIdx] === 'Done') n[speakerIdx] = 'Listening';
            return n;
          });
        }, 2000);
      }
    }
  };

  // ── Send a 5-second chunk; merged channel uses combined history for context ─
  const sendAudio = async (blob, speakerIdx) => {
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
    formData.append('demo_token', demoToken);

    try {
      const res = await axios.post(`${API_BASE}/upload-audio`, formData);
      if (res.data.error) return;

      if (res.data.demo_token) {
        const remaining = res.data.demo_uses_remaining ?? 0;
        setDemoToken(res.data.demo_token);
        setDemoUsesLeft(remaining);
        try {
          localStorage.setItem(DEMO_TOKEN_KEY, res.data.demo_token);
          localStorage.setItem(DEMO_REMAINING_KEY, String(remaining));
        } catch { /* ignore */ }
        if (remaining === 0) stopVibeSession();
      }

      const newItem = { ...res.data, id: Date.now() };
      // Ref lags one render — its length equals the pre-push length, which is the new item's index
      const newIdx = speakerHistoryRefs.current[speakerIdx]?.length || 0;
      setSpeakerHistories(prev => prev.map((h, i) => i === speakerIdx ? [...h, newItem] : h));
      setSpeakerIndices(prev => { const n = [...prev]; n[speakerIdx] = newIdx; return n; });

    } catch (err) {
      if (err?.response?.status === 429) {
        setDemoUsesLeft(0);
        try { localStorage.setItem(DEMO_REMAINING_KEY, '0'); } catch { /* ignore */ }
        stopVibeSession();
        return;
      }
      throw err;
    }
  };

  // ── Recording: 5-second rolling slices ────────────────────────────────────
  const startVibeSession = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 44100, channelCount: 1 },
      });
      streamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);
      analyserRef.current = analyser;

      recorderRef.current = new RecordRTC(stream, {
        type: 'audio', mimeType: 'audio/wav',
        recorderType: RecordRTC.StereoAudioRecorder, numberOfAudioChannels: 1,
      });
      recorderRef.current.startRecording();
      pitchSamplesRef.current = [];

      pitchSampleIntervalRef.current = setInterval(() => {
        if (!analyserRef.current || !audioCtxRef.current) return;
        const timeData = new Float32Array(analyserRef.current.fftSize);
        analyserRef.current.getFloatTimeDomainData(timeData);
        const rms = Math.sqrt(timeData.reduce((s, v) => s + v * v, 0) / timeData.length);
        if (rms < 0.015) return;
        const pitch = detectDominantPitch(analyserRef.current, audioCtxRef.current.sampleRate);
        if (pitch) pitchSamplesRef.current.push(pitch);
        setSpeakerStatuses(p => p.map(s => s === 'Listening' ? 'Hearing' : s));
        clearTimeout(hearingResetRef.current);
        hearingResetRef.current = setTimeout(() => {
          setSpeakerStatuses(p => p.map(s => s === 'Hearing' ? 'Listening' : s));
        }, 400);
      }, 150);

      sliceTimerRef.current = setInterval(() => {
        if (!recorderRef.current || !streamRef.current?.active) return;
        recorderRef.current.stopRecording(() => {
          const blob = recorderRef.current.getBlob();
          const samples = pitchSamplesRef.current.splice(0);
          const count = participantCountRef.current;
          // In merge mode, all audio goes to the single unified channel
          const speakerIdx = mergeModeRef.current ? 0 : assignSpeaker(samples, count);

          if (blob.size > 5000) {
            if (!audioQueuesRef.current[speakerIdx]) audioQueuesRef.current[speakerIdx] = [];
            audioQueuesRef.current[speakerIdx].push(blob);
            processQueue(speakerIdx);
          }

          if (streamRef.current?.active) {
            recorderRef.current.reset();
            recorderRef.current.startRecording();
          }
        });
      }, 5000);

      setSpeakerStatuses(new Array(participantCountRef.current).fill('Listening'));

    } catch (err) {
      console.error('Mic error:', err);
    }
  };

  const stopVibeSession = () => {
    setVibeMode(false);
    if (sliceTimerRef.current) { clearInterval(sliceTimerRef.current); sliceTimerRef.current = null; }
    if (pitchSampleIntervalRef.current) { clearInterval(pitchSampleIntervalRef.current); pitchSampleIntervalRef.current = null; }
    if (hearingResetRef.current) clearTimeout(hearingResetRef.current);
    if (recorderRef.current) recorderRef.current.stopRecording(() => {});
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    if (audioCtxRef.current?.state !== 'closed') audioCtxRef.current?.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    isProcessingRefs.current = isProcessingRefs.current.map(() => false);
    setSpeakerGenerating(p => p.map(() => false));
    setSpeakerStatuses(p => p.map(() => 'Idle'));
  };

  const toggleVibe = () => {
    if (vibeMode) stopVibeSession();
    else { setVibeMode(true); startVibeSession(); }
  };

  const resetSession = () => {
    stopVibeSession();
    mergeModeRef.current = false;
    setMergeMode(false);
    originalHistoriesRef.current = [];
    const count = participantCountRef.current;
    const empty = Array.from({ length: count }, () => []);
    setSpeakerHistories(empty);
    setSpeakerIndices(new Array(count).fill(0));
    setSpeakerStatuses(new Array(count).fill('Idle'));
    setSpeakerGenerating(new Array(count).fill(false));
    speakerHistoryRefs.current = Array.from({ length: count }, () => []);
    audioQueuesRef.current = Array.from({ length: count }, () => []);
    isProcessingRefs.current = new Array(count).fill(false);
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
      formData.append('demo_token', demoToken);

      const res = await axios.post(`${API_BASE}/synthesize`, formData);

      if (res.data.demo_token) {
        const remaining = res.data.demo_uses_remaining ?? 0;
        setDemoToken(res.data.demo_token);
        setDemoUsesLeft(remaining);
        try {
          localStorage.setItem(DEMO_TOKEN_KEY, res.data.demo_token);
          localStorage.setItem(DEMO_REMAINING_KEY, String(remaining));
        } catch { /* ignore */ }
        if (remaining === 0) stopVibeSession();
      }

      if (!res.data.error) {
        const newItem = { ...res.data, id: Date.now() };
        setSpeakerHistories([[newItem]]);
        speakerHistoryRefs.current[0] = [newItem];
        setSpeakerIndices([0]);
      }
    } catch (e) {
      console.error('Synthesis error:', e);
    } finally {
      setIsSynthesizing(false);
      setSpeakerGenerating([false]);
      setSpeakerStatuses(['Done']);
      setTimeout(() => {
        setSpeakerStatuses(p => p.map(s => s === 'Done' ? (vibeMode ? 'Listening' : 'Idle') : s));
      }, 2000);
    }
  };

  // ── Export all histories as one ZIP ───────────────────────────────────────
  const commitSession = async () => {
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

      const response = await axios.post(`${API_BASE}/commit-session`, formData, { responseType: 'blob' });
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

  const hasAnyHistory = speakerHistories.some(h => h.length > 0);
  const canMerge = !mergeMode
    && participantCount > 1
    && speakerHistories.filter(h => h.length > 0).length >= 2;
  const totalUsed = DEMO_LIMIT - demoUsesLeft;

  return (
    <div className="app">

      {/* ── Phase 0: Spiral ── */}
      <AnimatePresence mode="wait">
        {introPhase === 0 && (
          <motion.div key="p0" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }} className="intro-overlay intro-overlay--white">
            <motion.div initial={{ scale: 5, opacity: 1, rotate: 0 }} animate={{ scale: 0, opacity: 0, rotate: 360 }} transition={{ duration: 1.5, ease: 'easeInOut' }} className="intro-spiral-wrapper">
              <img src="/images/buddyname.svg" alt="" className="intro-spiral-svg" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Phase 1: Explosion ── */}
      <AnimatePresence mode="wait">
        {introPhase === 1 && (
          <motion.div key="p1" initial={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.5, ease: 'easeOut' }} className="intro-overlay intro-overlay--white">
            <motion.div layoutId="buddy-logo" initial={{ scale: 0 }} animate={{ scale: 5 }} transition={{ duration: 0.4, ease: 'easeOut' }} className="intro-explosion-wrapper">
              <img src="/images/Mask group.svg" alt="" className="intro-mask-svg" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Participant selector ── */}
      <AnimatePresence>
        {introPhase === 2 && participantCount === null && (
          <ParticipantSelector onSelect={initializeSpeakers} />
        )}
      </AnimatePresence>

      {/* ── Main app ── */}
      {introPhase === 2 && participantCount !== null && (
        <>
          {hasAnyHistory && (
            <button type="button" onClick={commitSession} className="commit-btn" aria-label="Export session">
              <img src="/images/commit-arrow.png" alt="Export" className="w-6 h-6 object-contain pointer-events-none select-none" />
            </button>
          )}

          <button type="button" onClick={resetSession} className="restart-btn" aria-label="Reset">
            <RotateCcw size={22} strokeWidth={2} />
          </button>

          <div className={`app-inner${participantCount > 2 && !mergeMode ? ' app-inner--wide' : ''}`}>
            <header className="header header--fixed">
              <button type="button" onClick={() => setIntroPhase(0)} className="header-logo-btn" aria-label="Replay intro">
                <img src="/images/buddyname.svg" alt="Buddy" className="header-logo-img" />
              </button>
            </header>

            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              transition={{ delay: 0.25, duration: 0.5, ease: 'easeOut' }}
              className="app-main"
            >
              {/* Panels: animate between split view and merged view */}
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
                        onPrev={() => setSpeakerIndices(p => { const n=[...p]; n[i]=Math.max(0,n[i]-1); return n; })}
                        onNext={() => setSpeakerIndices(p => { const n=[...p]; n[i]=Math.min((speakerHistories[i]||[]).length-1,n[i]+1); return n; })}
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Unite Visions button — appears when 2+ speakers have content */}
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

              {/* Controls */}
              <div className={`controls${hasAnyHistory ? ' controls-caption' : ''}`}>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                  <LiquidButton active={vibeMode} onClick={toggleVibe} demoComplete={demoUsesLeft === 0} />
                  <div style={{ fontSize: '13px', opacity: 0.55, fontFamily: 'inherit', letterSpacing: '0.04em', textAlign: 'center', lineHeight: '1.6' }}>
                    {demoUsesLeft === 0
                      ? <span>want more? <a href={`mailto:${CONTACT_EMAIL}`} style={{ textDecoration: 'underline' }}>{CONTACT_EMAIL}</a></span>
                      : totalUsed > 0
                        ? `${demoUsesLeft} of ${DEMO_LIMIT} generations left`
                        : null}
                  </div>
                </div>
              </div>
            </motion.div>
          </div>
        </>
      )}
    </div>
  );
}
