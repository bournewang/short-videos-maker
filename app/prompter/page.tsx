"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { alignBilingualChunks } from "../lib/subtitles";
import { listProjectCaches, readProjectCache } from "../lib/project-cache";
import { hexOpacityCss, normalizeHeadlineStyle, normalizeSubtitleStyle } from "../lib/subtitle-style";
import { HeadlineEditor } from "../components/HeadlineEditor";
import type { HeadlineStyle } from "../components/HeadlineEditor";
import { SubtitleStyleEditor } from "../components/SubtitleStyleEditor";
import type { SubtitleStyle } from "../components/SubtitleStyleEditor";
import { readStyleCache, writeStyleCache } from "../lib/style-cache";

type TimedChunk = {
  english: string;
  chinese: string;
  startTime: number;
  endTime: number;
};

type EpisodeSummary = {
  id: string;
  title: string;
  savedAt: number;
  shotCount: number;
  duration: number;
};

type CachedCover = {
  url?: string;
  screenRatio?: string;
};

export default function PrompterPage() {
  const [episodeId, setEpisodeId] = useState("");
  const [title, setTitle] = useState("");
  const [audioSrc, setAudioSrc] = useState("");
  const [bgImage, setBgImage] = useState("");
  const [chunks, setChunks] = useState<TimedChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [episodesLoaded, setEpisodesLoaded] = useState(false);

  const [visibleCount, setVisibleCount] = useState(3);
  const [fontScale, setFontScale] = useState(100);
  const [currentChunkIndex, setCurrentChunkIndex] = useState(-1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [muted, setMuted] = useState(false);

  /* subtitle style */
  const [subtitleStyle, setSubtitleStyleRaw] = useState<SubtitleStyle>(() => normalizeSubtitleStyle({}));
  const [broadcastMode, setBroadcastMode] = useState(false);
  const [preBroadcastStyle, setPreBroadcastStyle] = useState<SubtitleStyle | null>(null);
  function changeSubtitleStyle(patch: Partial<SubtitleStyle>) {
    setSubtitleStyleRaw((prev) => {
      const next = normalizeSubtitleStyle({ ...prev, ...patch });
      writeStyleCache(episodeId, { subtitleStyle: next, headlineStyle, headlinePosition, broadcastMode });
      return next;
    });
  }

  /* headline */
  const [headlineText, setHeadlineText] = useState("");
  const [headlineStyle, setHeadlineStyleRaw] = useState<HeadlineStyle>(() => normalizeHeadlineStyle({ bgOpacity: 65 }));
  const [headlinePosition, setHeadlinePosition] = useState(8);
  function changeHeadlinePosition(value: number) {
    setHeadlinePosition(value);
    writeStyleCache(episodeId, { subtitleStyle, headlineStyle, headlinePosition: value, broadcastMode });
  }
  function changeHeadlineStyle(patch: Partial<HeadlineStyle>) {
    setHeadlineStyleRaw((prev) => {
      const next = normalizeHeadlineStyle({ ...prev, ...patch });
      writeStyleCache(episodeId, { subtitleStyle, headlineStyle: next, headlinePosition, broadcastMode });
      return next;
    });
  }

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const scrollTrackRef = useRef<HTMLDivElement | null>(null);
  const [optionsHydrated, setOptionsHydrated] = useState(false);

  useEffect(() => {
    if (!episodeId) return;
    const cached = readStyleCache(episodeId);
    queueMicrotask(() => {
      if (cached?.subtitleStyle) setSubtitleStyleRaw(normalizeSubtitleStyle(cached.subtitleStyle));
      if (cached?.headlineStyle) setHeadlineStyleRaw(normalizeHeadlineStyle(cached.headlineStyle));
      if (Number.isFinite(Number(cached?.headlinePosition))) setHeadlinePosition(Number(cached.headlinePosition));
      if (Number.isFinite(Number(cached?.visibleCount))) setVisibleCount(Math.max(1, Math.min(12, Number(cached.visibleCount))));
      if (Number.isFinite(Number(cached?.fontScale))) setFontScale(Math.max(60, Math.min(300, Number(cached.fontScale))));
      if (Number.isFinite(Number(cached?.playbackRate))) setPlaybackRate(Number(cached.playbackRate));
      if (typeof cached?.muted === "boolean") setMuted(cached.muted);
      if (typeof cached?.broadcastMode === "boolean") setBroadcastMode(cached.broadcastMode);
      if (typeof cached?.headlineText === "string") setHeadlineText(cached.headlineText);
      setOptionsHydrated(true);
    });
  }, [episodeId]);

  useEffect(() => {
    if (!optionsHydrated || !episodeId) return;
    writeStyleCache(episodeId, { subtitleStyle, headlineStyle, headlinePosition, visibleCount, fontScale, playbackRate, muted, broadcastMode, headlineText });
  }, [optionsHydrated, episodeId, subtitleStyle, headlineStyle, headlinePosition, visibleCount, fontScale, playbackRate, muted, broadcastMode, headlineText]);

  /* ---- load episode list on mount ---- */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idFromUrl = params.get("episode") || "";
    listProjectCaches().then((list: EpisodeSummary[]) => {
      setEpisodes(list);
      setEpisodesLoaded(true);
      if (idFromUrl && list.some((e) => e.id === idFromUrl)) {
        setEpisodeId(idFromUrl);
      }
    }).catch(() => {
      setEpisodesLoaded(true);
    });
  }, []);

  /* ---- load episode data ---- */
  useEffect(() => {
    if (!episodeId) {
      setChunks([]);
      setAudioSrc("");
      setBgImage("");
      setTitle("");
      setCurrentChunkIndex(-1);
      setScrollOffset(0);
      setCurrentTime(0);
      setDuration(0);
      setIsPlaying(false);
      return;
    }
    setLoading(true);
    setError("");
    readProjectCache(episodeId)
      .then((data) => {
        if (!data) { setError("Episode not found."); setLoading(false); return; }
        const cachedStyles = readStyleCache(episodeId);
        if (cachedStyles?.subtitleStyle) setSubtitleStyleRaw(normalizeSubtitleStyle(cachedStyles.subtitleStyle));
        else if (data.subtitleStyle) setSubtitleStyleRaw(normalizeSubtitleStyle(data.subtitleStyle));
        if (cachedStyles?.headlineStyle) setHeadlineStyleRaw(normalizeHeadlineStyle(cachedStyles.headlineStyle));
        else if (data.headlineStyle) setHeadlineStyleRaw(normalizeHeadlineStyle(data.headlineStyle));
        if (Number.isFinite(Number(cachedStyles?.headlinePosition))) setHeadlinePosition(Number(cachedStyles.headlinePosition));
        else if (Number.isFinite(Number(data.headlinePosition))) setHeadlinePosition(Number(data.headlinePosition));
        const shots = Array.isArray(data.shots) ? data.shots : [];
        const covers: CachedCover[] = Array.isArray(data.covers) ? data.covers : [];
        const coverUrl = covers.find((c) => c?.screenRatio === "9:16" && c?.url)?.url
          || covers.find((c) => c?.url)?.url
          || "";
        setBgImage(String(data.chosenCoverUrl || coverUrl || shots[0]?.image || ""));
        setTitle(String(data.title || "Untitled"));
        setAudioSrc(String(data.audioData || ""));

        const timed: TimedChunk[] = [];
        for (const shot of shots) {
          const start = Math.max(0, Number(shot.start) || 0);
          const shotDuration = Math.max(0.6, Number(shot.duration) || 2);
          const end = Number.isFinite(Number(shot.end)) && Number(shot.end) > start
            ? Number(shot.end) : start + shotDuration;
          const realDuration = end - start;

          const aligned = alignBilingualChunks(
            String(shot.narration || ""),
            String(shot.chinese || "")
          );
          if (aligned.length === 0) continue;

          const weights = aligned.map((c) =>
            Math.max(1, c.english.split(/\s+/).filter(Boolean).length || c.chinese.length)
          );
          const totalWeight = weights.reduce((s, w) => s + w, 0);

          let cueStart = start;
          for (let i = 0; i < aligned.length; i++) {
            const cueDuration = Math.max(0.5, realDuration * weights[i] / totalWeight);
            const cueEnd = i === aligned.length - 1 ? end : Math.min(end, cueStart + cueDuration);
            timed.push({
              english: aligned[i].english,
              chinese: aligned[i].chinese,
              startTime: cueStart,
              endTime: cueEnd,
            });
            cueStart = cueEnd;
          }
        }
        setChunks(timed);
        setCurrentChunkIndex(-1);
        setScrollOffset(0);
        setCurrentTime(0);
        setDuration(0);
        setIsPlaying(false);
        setLoading(false);
      })
      .catch((err) => {
        setError("Failed to load episode: " + String(err?.message || err));
        setLoading(false);
      });
  }, [episodeId]);

  /* ---- audio event handlers ---- */
  const onPlay = useCallback(() => setIsPlaying(true), []);
  const onPause = useCallback(() => setIsPlaying(false), []);
  const onTimeUpdate = useCallback(() => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  }, []);
  const onLoadedMetadata = useCallback(() => {
    if (audioRef.current) setDuration(audioRef.current.duration || 0);
  }, []);
  const onEnded = useCallback(() => setIsPlaying(false), []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = playbackRate;
  }, [playbackRate]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted]);

  /* ---- find current chunk from audio time ---- */
  useEffect(() => {
    if (chunks.length === 0) { setCurrentChunkIndex(-1); return; }
    const idx = chunks.findIndex(
      (c) => currentTime >= c.startTime && currentTime < c.endTime
    );
    setCurrentChunkIndex(idx >= 0 ? idx : currentTime >= (chunks[chunks.length - 1]?.endTime || 0) ? chunks.length - 1 : 0);
  }, [currentTime, chunks]);

  /* ---- auto-scroll: keep current chunk near middle of window (only while playing,
     so manual scrollbar / wheel navigation is not overridden when paused) ---- */
  useEffect(() => {
    if (!isPlaying || currentChunkIndex < 0) return;
    const targetOffset = Math.max(0, currentChunkIndex - Math.floor(visibleCount / 2));
    const maxOffset = Math.max(0, chunks.length - visibleCount);
    setScrollOffset(Math.min(targetOffset, maxOffset));
  }, [isPlaying, currentChunkIndex, visibleCount, chunks.length]);

  /* ---- keyboard shortcuts ---- */
  const togglePlayRef = useRef(togglePlay);
  togglePlayRef.current = togglePlay;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.code === "Space" && event.target === document.body) {
        event.preventDefault();
        togglePlayRef.current();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio || !audioSrc) return;
    if (audio.paused) {
      if (audio.currentTime >= (audio.duration || 0) - 0.02) audio.currentTime = 0;
      void audio.play().catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  }

  function seekToChunk(index: number) {
    if (!audioRef.current || index < 0 || index >= chunks.length) return;
    audioRef.current.currentTime = chunks[index].startTime;
    setCurrentTime(chunks[index].startTime);
  }

  function handleEpisodeSelect(id: string) {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current.currentTime = 0; }
    setEpisodeId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("episode", id);
    window.history.replaceState({}, "", url.toString());
  }

  /* ---- manual scrolling (scrollbar + mouse wheel) ---- */
  function scrollWindowTo(clientY: number) {
    const track = scrollTrackRef.current;
    if (!track || chunks.length <= visibleCount) return;
    const rect = track.getBoundingClientRect();
    const thumbRatio = visibleCount / chunks.length;
    const usable = rect.height * (1 - thumbRatio);
    if (usable <= 0) return;
    const y = Math.min(Math.max(clientY - rect.top - (rect.height * thumbRatio) / 2, 0), usable);
    const maxOffset = chunks.length - visibleCount;
    setScrollOffset(Math.round((y / usable) * maxOffset));
  }

  function onScrollbarPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    scrollWindowTo(e.clientY);
  }

  function onScrollbarPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) scrollWindowTo(e.clientY);
  }

  function onChunksWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (chunks.length <= visibleCount) return;
    const maxOffset = chunks.length - visibleCount;
    const delta = e.deltaY > 0 ? 1 : -1;
    setScrollOffset((prev) => Math.min(Math.max(prev + delta, 0), maxOffset));
  }

  function formatTime(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  const maxScrollOffset = Math.max(0, chunks.length - visibleCount);
  const clampedScrollOffset = Math.min(Math.max(scrollOffset, 0), maxScrollOffset);
  const visibleChunks = chunks.slice(clampedScrollOffset, clampedScrollOffset + visibleCount);
  const hasAudio = Boolean(audioSrc);
  const totalDuration = chunks.length > 0 ? chunks[chunks.length - 1].endTime : 0;
  const thumbHeightPct = chunks.length > 0 ? Math.min(100, (visibleCount / chunks.length) * 100) : 100;
  const thumbTopPct = maxScrollOffset > 0
    ? (clampedScrollOffset / maxScrollOffset) * (100 - thumbHeightPct)
    : 0;

  return (
    <div className="prompter-shell">
      {/* top bar */}
      <div className="prompter-topbar">
        <div className="prompter-topbar-left">
          <a href="/" className="prompter-back" title="Back to studio">← Studio</a>
          <span className="prompter-title">{title || "Teleprompter"}</span>
        </div>
        <div className="prompter-topbar-right">
          {episodesLoaded && (
            <select
              className="prompter-episode-select"
              value={episodeId}
              onChange={(e) => handleEpisodeSelect(e.target.value)}
            >
              <option value="">Select episode…</option>
              {episodes.map((ep) => (
                <option key={ep.id} value={ep.id}>
                  {ep.title || "Untitled"} ({ep.shotCount} shots)
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* two-column workspace */}
      <div className="prompter-workspace">

      {/* main area */}
      <div className="prompter-main">
      <div className="prompter-body">
        {loading && (
          <div className="prompter-message">
            <div className="prompter-spinner" />
            <span>Loading episode…</span>
          </div>
        )}

        {!loading && error && (
          <div className="prompter-message prompter-error">
            <span>{error}</span>
            <button className="prompter-btn" onClick={() => setEpisodeId("")}>
              Choose another episode
            </button>
          </div>
        )}

        {!loading && !error && !episodeId && (
          <div className="prompter-message">
            <span>Select an episode to start the teleprompter</span>
            {episodesLoaded && episodes.length === 0 && (
              <small>No saved episodes found. Create one in the studio first.</small>
            )}
          </div>
        )}

        {!loading && !error && episodeId && chunks.length === 0 && (
          <div className="prompter-message">
            <span>This episode has no script content.</span>
            <small>Add narration or Chinese text to the shots in the studio.</small>
          </div>
        )}

        {!loading && !error && chunks.length > 0 && (
          <div className="prompter-phone-frame">
            <div className="prompter-phone-canvas">
              {bgImage && <img className="prompter-bg" src={bgImage} alt="" />}
              {headlineText.trim() && (
                <div className="prompter-headline" style={{
                  top: `${headlinePosition}%`,
                  background: hexOpacityCss(headlineStyle.bgColor, headlineStyle.bgOpacity),
                }}>
                  <span style={{
                    color: headlineStyle.textColor,
                    fontSize: `${headlineStyle.fontScale * 0.032}cqh`,
                    fontWeight: 700,
                    textShadow: "0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000",
                  }}>{headlineText}</span>
                </div>
              )}
              <div className="prompter-scroll" onWheel={onChunksWheel}>
                <div className="prompter-chunk-list">
                {visibleChunks.map((chunk, i) => {
                  const globalIndex = clampedScrollOffset + i;
                  const isActive = globalIndex === currentChunkIndex;
                  return (
                    <div
                      key={globalIndex}
                      className={`prompter-chunk${isActive ? " active" : ""}`}
                      onClick={() => seekToChunk(globalIndex)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          seekToChunk(globalIndex);
                        }
                      }}
                    >
                      <div
                        className="prompter-chunk-en"
                        style={{ fontSize: `${fontScale * 0.028}cqh` }}
                      >
                        {chunk.english || " "}
                      </div>
                      {chunk.chinese && (
                        <div
                          className="prompter-chunk-zh"
                          style={{ fontSize: `${fontScale * 0.022}cqh` }}
                        >
                          {chunk.chinese}
                        </div>
                      )}
                    </div>
                  );
                })}
                {clampedScrollOffset + visibleCount >= chunks.length && (
                  <div className="prompter-end">— End of script —</div>
                )}
                </div>
              </div>
              {chunks.length > visibleCount && (
                <div
                  ref={scrollTrackRef}
                  className="prompter-scrollbar"
                  onPointerDown={onScrollbarPointerDown}
                  onPointerMove={onScrollbarPointerMove}
                  role="scrollbar"
                  aria-orientation="vertical"
                  aria-valuenow={clampedScrollOffset + 1}
                  aria-valuemin={1}
                  aria-valuemax={maxScrollOffset + 1}
                >
                  <div
                    className="prompter-scrollbar-thumb"
                    style={{ top: `${thumbTopPct}%`, height: `${thumbHeightPct}%` }}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* bottom bar */}
      {chunks.length > 0 && (
        <div className="prompter-bottombar">
          <button
            className="prompter-play-btn"
            onClick={togglePlay}
            disabled={!hasAudio}
            title={!hasAudio ? "No audio available" : isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button
            className="prompter-mute-btn"
            onClick={() => setMuted(!muted)}
            disabled={!hasAudio}
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? "🔇" : "🔊"}
          </button>
          <div className="prompter-time">
            {formatTime(currentTime)} / {formatTime(totalDuration || duration)}
          </div>
          <div className="prompter-chunk-indicator">
            {currentChunkIndex >= 0
              ? `Chunk ${currentChunkIndex + 1} / ${chunks.length}`
              : "Ready"}
          </div>
          <div className="prompter-bottombar-spacer" />
          <span className="prompter-hint">Space to play/pause · Click a line to jump</span>
        </div>
      )}
      </div>{/* end prompter-main */}

      {/* right sidebar */}
      <aside className="prompter-sidebar">
        <div className="prompter-settings">
          <label className="prompter-setting">
            <span>Sentences at a time</span>
            <div className="prompter-stepper">
              <button onClick={() => setVisibleCount(Math.max(1, visibleCount - 1))}>−</button>
              <output>{visibleCount}</output>
              <button onClick={() => setVisibleCount(Math.min(12, visibleCount + 1))}>+</button>
            </div>
          </label>
          <label className="prompter-setting">
            <span>Text size</span>
            <div className="prompter-stepper">
              <button onClick={() => setFontScale(Math.max(60, fontScale - 10))}>−</button>
              <output>{fontScale}%</output>
              <button onClick={() => setFontScale(Math.min(300, fontScale + 10))}>+</button>
            </div>
          </label>
          <label className="prompter-setting">
            <span>Speed</span>
            <select value={playbackRate} onChange={(e) => setPlaybackRate(Number(e.target.value))}>
              <option value={0.5}>0.5x</option>
              <option value={0.75}>0.75x</option>
              <option value={0.8}>0.8x</option>
              <option value={0.85}>0.85x</option>
              <option value={0.9}>0.9x</option>
              <option value={1}>1x</option>
              <option value={1.25}>1.25x</option>
              <option value={1.5}>1.5x</option>
              <option value={2}>2x</option>
            </select>
          </label>
        </div>
        <div className="prompter-settings-divider" />
        <HeadlineEditor
          variant="prompter"
          headlineText={headlineText}
          setHeadlineText={setHeadlineText}
          headlinePosition={headlinePosition}
          setHeadlinePosition={changeHeadlinePosition}
          headlineStyle={headlineStyle}
          setHeadlineStyle={changeHeadlineStyle}
        />
        <div className="prompter-settings-divider" />
        <SubtitleStyleEditor
          subtitleStyle={subtitleStyle}
          setSubtitleStyle={changeSubtitleStyle}
          broadcastMode={broadcastMode}
          setBroadcastMode={setBroadcastMode}
          headlineText={headlineText}
          setHeadlineText={setHeadlineText}
          headlinePosition={headlinePosition}
          setHeadlinePosition={setHeadlinePosition}
          preBroadcastStyle={preBroadcastStyle}
          setPreBroadcastStyle={setPreBroadcastStyle}
          hideBroadcastToggle
          hideHeadlineRow
        />
      </aside>

      </div>{/* end prompter-workspace */}

      {audioSrc && (
        <audio
          ref={audioRef}
          src={audioSrc}
          preload="auto"
          onPlay={onPlay}
          onPause={onPause}
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onEnded={onEnded}
          onError={() => setError("Audio failed to load.")}
        />
      )}
    </div>
  );
}