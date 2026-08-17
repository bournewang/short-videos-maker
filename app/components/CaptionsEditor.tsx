"use client";

export type CaptionShot = {
  id: string;
  narration: string;
  chinese: string;
  start: number;
  end: number;
};

type CaptionsEditorProps = {
  shots: CaptionShot[];
  /** Called with the shot id and a partial patch when any field changes. */
  onChange: (id: string, patch: Partial<Pick<CaptionShot, "narration" | "chinese">>) => void;
  /** Highlight the shot that contains this playback time (seconds). */
  currentTime?: number;
};

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function CaptionsEditor({ shots, onChange, currentTime = -1 }: CaptionsEditorProps) {
  if (shots.length === 0) {
    return (
      <div className="captions-editor captions-editor--empty">
        <span>No shots yet. Add shots in the storyboard to edit captions here.</span>
      </div>
    );
  }

  return (
    <div className="captions-editor">
      {shots.map((shot) => {
        const isActive = currentTime >= shot.start && currentTime < shot.end;
        return (
          <div key={shot.id} className={`captions-row${isActive ? " captions-row--active" : ""}`}>
            <span className="captions-time">{formatTime(shot.start)}</span>
            <div className="captions-fields">
              <label className="captions-label">
                <span>EN</span>
                <textarea
                  className="captions-text"
                  rows={2}
                  value={shot.narration}
                  placeholder="English narration…"
                  onChange={(e) => onChange(shot.id, { narration: e.target.value })}
                />
              </label>
              <label className="captions-label">
                <span>中文</span>
                <textarea
                  className="captions-text captions-text--zh"
                  rows={2}
                  value={shot.chinese}
                  placeholder="中文字幕…"
                  onChange={(e) => onChange(shot.id, { chinese: e.target.value })}
                />
              </label>
            </div>
            <span className="captions-duration">{(shot.end - shot.start).toFixed(1)}s</span>
          </div>
        );
      })}
    </div>
  );
}
