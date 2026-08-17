"use client";

import { BROADCAST_MODE_STYLE, DEFAULT_SUBTITLE_STYLE, SUBTITLE_FONTS, SUBTITLE_PRESETS, normalizeSubtitleStyle } from "../lib/subtitle-style";
import { HeadlineEditor } from "./HeadlineEditor";
import { Stepper } from "./controls";

export type SubtitleStyle = ReturnType<typeof normalizeSubtitleStyle>;

type SubtitleStyleEditorProps = {
  subtitleStyle: SubtitleStyle;
  /** Patch-style setter; the parent re-normalizes (see changeSubtitleStyle in StudioApp). */
  setSubtitleStyle: (patch: Partial<SubtitleStyle>) => void;
  broadcastMode: boolean;
  setBroadcastMode: (on: boolean) => void;
  headlineText: string;
  setHeadlineText: (value: string) => void;
  headlinePosition: number;
  setHeadlinePosition: (value: number) => void;
  preBroadcastStyle: SubtitleStyle | null;
  setPreBroadcastStyle: (style: SubtitleStyle | null) => void;
  lineCount?: number;
  setLineCount?: (value: number) => void;
  displayMode?: "subtitle" | "prompter";
  setDisplayMode?: (mode: "subtitle" | "prompter") => void;
  hideBroadcastToggle?: boolean;
  hideHeadlineRow?: boolean;
};

export function SubtitleStyleEditor({ subtitleStyle, setSubtitleStyle, broadcastMode, setBroadcastMode, headlineText, setHeadlineText, headlinePosition, setHeadlinePosition, preBroadcastStyle, setPreBroadcastStyle, lineCount, setLineCount, displayMode, setDisplayMode, hideBroadcastToggle, hideHeadlineRow }: SubtitleStyleEditorProps) {
  const currentPresetId = SUBTITLE_PRESETS.find((preset) =>
    JSON.stringify(normalizeSubtitleStyle(preset.style)) === JSON.stringify(subtitleStyle)
  )?.id || "";
  const positionMax = 95;

  function toggleBroadcastMode(on: boolean) {
    if (on) {
      setPreBroadcastStyle({ ...subtitleStyle });
      setSubtitleStyle({ ...BROADCAST_MODE_STYLE });
    } else {
      if (preBroadcastStyle) setSubtitleStyle(preBroadcastStyle);
      setPreBroadcastStyle(null);
    }
    setBroadcastMode(on);
  }

  return <section className="subtitle-style-dock" aria-label="Subtitle style"><div className="subtitle-dock-title"><span className="eyebrow">SUBTITLES</span><b>Style</b></div><div className="subtitle-dock-body">
    {(broadcastMode || hideBroadcastToggle) && !hideHeadlineRow && <HeadlineEditor variant="dock" headlineText={headlineText} setHeadlineText={setHeadlineText} headlinePosition={headlinePosition} setHeadlinePosition={setHeadlinePosition}/>}
    <div className="subtitle-dock-controls">
    {displayMode && setDisplayMode && <fieldset className="subtitle-mode-control"><legend>Display</legend><label><input type="radio" name="livestream-display-mode" value="subtitle" checked={displayMode === "subtitle"} onChange={() => setDisplayMode("subtitle")}/><span>Subtitle</span></label><label><input type="radio" name="livestream-display-mode" value="prompter" checked={displayMode === "prompter"} onChange={() => setDisplayMode("prompter")}/><span>Prompter</span></label></fieldset>}
    {!hideBroadcastToggle && <label className="dock-toggle broadcast-toggle"><input type="checkbox" checked={broadcastMode} onChange={(event) => toggleBroadcastMode(event.target.checked)}/><span><b>Broadcast mode</b><small>Subtitles in middle + headline bar</small></span></label>}
    <label className="dock-select preset-select"><span>Preset</span><select value={currentPresetId} onChange={(event) => { if (!event.target.value) return; const preset = SUBTITLE_PRESETS.find((p) => p.id === event.target.value); if (preset) setSubtitleStyle(preset.style); }}><option value="">{currentPresetId ? "Custom" : "Choose…"}</option>{SUBTITLE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}</select></label>
    <label className="dock-select"><span>Font</span><select value={subtitleStyle.fontFamily} onChange={(event)=>setSubtitleStyle({ fontFamily:event.target.value })}>{SUBTITLE_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
    <label className="dock-select alignment"><span>Align</span><select value={subtitleStyle.alignment} onChange={(event)=>setSubtitleStyle({ alignment:event.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
    <label className="dock-range stepped"><span>Size</span><Stepper className="livestream-stepper dock-stepper" value={subtitleStyle.fontScale} min={60} max={300} rangeStep={5} nudge={10} showOutput format={(v) => `${v}%`} onChange={(v) => setSubtitleStyle({ fontScale:v })} labels={{ decrease:"Decrease subtitle size", increase:"Increase subtitle size", range:"Subtitle text size" }}/></label>
    <label className="dock-range stepped"><span>Position</span><Stepper className="livestream-stepper dock-stepper" value={subtitleStyle.position} min={5} max={positionMax} rangeStep={1} nudge={5} showOutput format={(v) => `${v}%`} onChange={(v) => setSubtitleStyle({ position:v })} labels={{ decrease:"Move subtitles up", increase:"Move subtitles down", range:"Subtitle bottom position" }}/></label>
    {lineCount != null && setLineCount && <label className="dock-range stepped"><span>Lines</span><Stepper className="livestream-stepper dock-stepper" value={lineCount} min={1} max={8} rangeStep={1} nudge={1} showOutput format={(v) => `${v}`} onChange={setLineCount} labels={{ decrease:"Show fewer teleprompter lines", increase:"Show more teleprompter lines", range:"Teleprompter lines" }}/></label>}
    <label className="dock-color" title="English text color"><span>EN</span><input aria-label="English subtitle color" type="color" value={subtitleStyle.englishColor} onChange={(event)=>setSubtitleStyle({ englishColor:event.target.value })}/></label>
    <label className="dock-color" title="Chinese text color"><span>中文</span><input aria-label="Chinese subtitle color" type="color" value={subtitleStyle.chineseColor} onChange={(event)=>setSubtitleStyle({ chineseColor:event.target.value })}/></label>
    <label className="dock-color" title="Subtitle background color"><span>BG</span><input aria-label="Subtitle background color" type="color" value={subtitleStyle.backgroundColor} onChange={(event)=>setSubtitleStyle({ backgroundColor:event.target.value })}/></label>
    <label className="dock-range"><span>BG alpha</span><input aria-label="Subtitle background opacity" type="range" min="0" max="100" step="5" value={subtitleStyle.backgroundOpacity} onChange={(event)=>setSubtitleStyle({ backgroundOpacity:Number(event.target.value) })}/><output>{subtitleStyle.backgroundOpacity}%</output></label>
    <label className="dock-range outline"><span>Outline</span><input aria-label="Subtitle outline size" type="range" min="0" max="5" step="0.5" value={subtitleStyle.outline} onChange={(event)=>setSubtitleStyle({ outline:Number(event.target.value) })}/><output>{subtitleStyle.outline}px</output></label>
    <label className="dock-toggle"><input type="checkbox" checked={subtitleStyle.bold} onChange={(event)=>setSubtitleStyle({ bold:event.target.checked })}/><span>Bold</span></label>
    <button type="button" className="ghost dock-reset" onClick={() => setSubtitleStyle(DEFAULT_SUBTITLE_STYLE)}>Reset</button>
  </div></div></section>;
}
