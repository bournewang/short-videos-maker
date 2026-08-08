"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { alignBilingualChunks } from "./lib/subtitles";
import { listProjectCaches, readProjectCache } from "./lib/project-cache";

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

export default function PrompterPanel({ currentEpisodeId = "" }: { currentEpisodeId?: string }) {
  const [episodeId, setEpisodeId] = useState("");
  const [title, setTitle] = useState("");
  const [audioSrc, setAudioSrc] = useState("");
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
  const [showSettings, setShowSettings] = useState(false);

  /* headline */
  const [headlineText, setHeadlineText] = useState("");
  const [headlineFontScale, setHeadlineFontScale] = useState(100);
  const [headlineTextColor, setHeadlineTextColor] = useState("#ffffff");
  const [headlineBgColor, setHeadlineBgColor] = useState("#000000");
  const [headlineBgOpacity, setHeadlineBgOpacity] = useState(65);
  const [headlinePosition, setHeadlinePosition] = useState(8);

  const audioRef = useRef<HTMLAudioElement | null>(null);

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

  /* ---- auto-select current studio episode ---- */
  useEffect(() => {
    if (episodesLoaded && currentEpisodeId && !episodeId && episodes.some((e) => e.id === currentEpisodeId)) {
      setEpisodeId(currentEpisodeId);
    }
  }, [currentEpisodeId, episodesLoaded, episodeId, episodes]);

  /* ---- load episode data ---- */
  useEffect(() => {
    if (!episodeId) {
      setChunks([]);
      setAudioSrc("");
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
        const shots = Array.isArray(data.shots) ? data.shots : [];
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

  /* ---- auto-scroll: keep current chunk near middle of window ---- */
  useEffect(() => {
    if (currentChunkIndex < 0) return;
    const targetOffset = Math.max(0, currentChunkIndex - Math.floor(visibleCount / 2));
    const maxOffset = Math.max(0, chunks.length - visibleCount);
    setScrollOffset(Math.min(targetOffset, maxOffset));
  }, [currentChunkIndex, visibleCount, chunks.length]);

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

  function formatTime(seconds: number) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  const visibleChunks = chunks.slice(scrollOffset, scrollOffset + visibleCount);
  const hasAudio = Boolean(audioSrc);
  const totalDuration = chunks.length > 0 ? chunks[chunks.length - 1].endTime : 0;

  return (
    <div className="prompter-panel">
      {/* top bar */}
      <div className="prompter-topbar">
        <div className="prompter-topbar-left">
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
          <button
            className="prompter-settings-btn"
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </div>

      {/* settings panel */}
      {showSettings && (
        <div className="prompter-settings">
          <label className="prompter-setting">
            <span>Visible lines</span>
            <div className="prompter-stepper">
              <button onClick={() => setVisibleCount(Math.max(1, visibleCount - 1))}>−</button>
              <output>{visibleCount}</output>
              <button onClick={() => setVisibleCount(Math.min(8, visibleCount + 1))}>+</button>
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
          <div className="prompter-settings-divider" />
          <label className="prompter-setting prompter-headline-text">
            <span>Headline</span>
            <input type="text" value={headlineText} onChange={(e) => setHeadlineText(e.target.value)} placeholder="Broadcast headline…" />
          </label>
          <label className="prompter-setting">
            <span>HL size</span>
            <div className="prompter-stepper">
              <button onClick={() => setHeadlineFontScale(Math.max(60, headlineFontScale - 10))}>−</button>
              <output>{headlineFontScale}%</output>
              <button onClick={() => setHeadlineFontScale(Math.min(300, headlineFontScale + 10))}>+</button>
            </div>
          </label>
          <label className="prompter-setting">
            <span>HL position</span>
            <div className="prompter-stepper">
              <button onClick={() => setHeadlinePosition(Math.max(0, headlinePosition - 2))}>−</button>
              <output>{headlinePosition}%</output>
              <button onClick={() => setHeadlinePosition(Math.min(40, headlinePosition + 2))}>+</button>
            </div>
          </label>
          <label className="prompter-setting">
            <span>HL text</span>
            <input type="color" value={headlineTextColor} onChange={(e) => setHeadlineTextColor(e.target.value)} />
          </label>
          <label className="prompter-setting">
            <span>HL bg</span>
            <input type="color" value={headlineBgColor} onChange={(e) => setHeadlineBgColor(e.target.value)} />
          </label>
          <label className="prompter-setting">
            <span>HL bg α</span>
            <div className="prompter-stepper">
              <button onClick={() => setHeadlineBgOpacity(Math.max(0, headlineBgOpacity - 10))}>−</button>
              <output>{headlineBgOpacity}%</output>
              <button onClick={() => setHeadlineBgOpacity(Math.min(100, headlineBgOpacity + 10))}>+</button>
            </div>
          </label>
        </div>
      )}

      {/* main area */}
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
              {headlineText.trim() && (
                <div className="prompter-headline" style={{
                  top: `${headlinePosition}%`,
                  background: `rgba(${Number.parseInt(headlineBgColor.slice(1, 3), 16)}, ${Number.parseInt(headlineBgColor.slice(3, 5), 16)}, ${Number.parseInt(headlineBgColor.slice(5, 7), 16)}, ${headlineBgOpacity / 100})`,
                }}>
                  <span style={{
                    color: headlineTextColor,
                    fontSize: `${headlineFontScale * 0.032}cqh`,
                    fontWeight: 700,
                    textShadow: "0 2px 0 #000, 0 -2px 0 #000, 2px 0 0 #000, -2px 0 0 #000",
                  }}>{headlineText}</span>
                </div>
              )}
              <div className="prompter-chunk-list">
                {visibleChunks.map((chunk, i) => {
                  const globalIndex = scrollOffset + i;
                  const isActive = globalIndex === currentChunkIndex;
                  const isPast = globalIndex < currentChunkIndex;
                  return (
                    <div
                      key={globalIndex}
                      className={`prompter-chunk${isActive ? " active" : ""}${isPast ? " past" : ""}`}
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
                        {chunk.english || " "}
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
                {scrollOffset + visibleCount >= chunks.length && (
                  <div className="prompter-end">— End of script —</div>
                )}
              </div>
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