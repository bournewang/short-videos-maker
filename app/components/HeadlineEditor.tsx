"use client";

import { HEADLINE_PRESETS, SUBTITLE_FONTS, hexOpacityCss, normalizeHeadlineStyle, normalizeSubtitleStyle } from "../lib/subtitle-style";
import { ColorSwatchRow, HEADLINE_BG_SWATCHES, HEADLINE_SUB_SWATCHES, HEADLINE_TEXT_SWATCHES, Stepper } from "./controls";

export type HeadlineStyle = ReturnType<typeof normalizeHeadlineStyle>;
export type SubHeadlineStyle = { fontScale: number; textColor: string };
type SubtitleStyle = ReturnType<typeof normalizeSubtitleStyle>;

type HeadlineEditorProps = {
  /** livestream: full editor incl. presets/swatches/sub-headline · dock: text + position row · prompter: compact settings rows */
  variant: "livestream" | "dock" | "prompter";
  headlineText: string;
  setHeadlineText: (value: string) => void;
  headlinePosition: number;
  setHeadlinePosition: (value: number) => void;
  /** Required for the livestream and prompter variants (dock renders no style controls). */
  headlineStyle?: HeadlineStyle;
  /** Patch-style setter; the parent re-normalizes. */
  setHeadlineStyle?: (patch: Partial<HeadlineStyle>) => void;
  /** Defaults to 100 for livestream/dock and 40 for prompter. */
  positionMax?: number;
  /** Optional sub-headline block, rendered by the livestream variant only. */
  subHeadline?: {
    text: string;
    setText: (value: string) => void;
    style: SubHeadlineStyle;
    setStyle: (patch: Partial<SubHeadlineStyle>) => void;
  };
};

export function HeadlineEditor({ variant, headlineText, setHeadlineText, headlinePosition, setHeadlinePosition, headlineStyle, setHeadlineStyle, positionMax, subHeadline }: HeadlineEditorProps) {
  if (variant === "dock") {
    return <div className="subtitle-dock-headline-row">
      <label className="field headline-field"><span>Headline</span><input type="text" value={headlineText} onChange={(event) => setHeadlineText(event.target.value)} placeholder="Broadcast headline text…"/></label>
      <label className="dock-range"><span>HL pos</span><input aria-label="Headline top position" type="range" min="0" max={positionMax ?? 100} step="1" value={headlinePosition} onChange={(event) => setHeadlinePosition(Number(event.target.value))}/><output>{headlinePosition}%</output></label>
    </div>;
  }

  const style = headlineStyle ? normalizeHeadlineStyle(headlineStyle) : normalizeHeadlineStyle();
  const patchStyle = setHeadlineStyle ?? (() => {});

  if (variant === "prompter") {
    return <>
      <label className="prompter-setting prompter-headline-text">
        <span>Headline</span>
        <input type="text" value={headlineText} onChange={(e) => setHeadlineText(e.target.value)} placeholder="Broadcast headline…" />
      </label>
      <label className="prompter-setting">
        <span>HL size</span>
        <Stepper className="prompter-stepper" value={style.fontScale} min={60} max={300} nudge={10} format={(v) => `${v}%`} onChange={(v) => patchStyle({ fontScale: v })}/>
      </label>
      <label className="prompter-setting">
        <span>HL position</span>
        <Stepper className="prompter-stepper" value={headlinePosition} min={0} max={positionMax ?? 40} nudge={2} format={(v) => `${v}%`} onChange={setHeadlinePosition}/>
      </label>
      <label className="prompter-setting">
        <span>HL text</span>
        <input type="color" value={style.textColor} onChange={(e) => patchStyle({ textColor: e.target.value })} />
      </label>
      <label className="prompter-setting">
        <span>HL bg</span>
        <input type="color" value={style.bgColor} onChange={(e) => patchStyle({ bgColor: e.target.value })} />
      </label>
      <label className="prompter-setting">
        <span>HL bg α</span>
        <Stepper className="prompter-stepper" value={style.bgOpacity} min={0} max={100} nudge={10} format={(v) => `${v}%`} onChange={(v) => patchStyle({ bgOpacity: v })}/>
      </label>
    </>;
  }

  const maxPos = positionMax ?? 100;
  const currentPresetId = HEADLINE_PRESETS.find((p) => JSON.stringify(p.style) === JSON.stringify(style))?.id || "";
  return <>
    <label className="field"><span>Text</span><textarea value={headlineText} onChange={(e) => setHeadlineText(e.target.value)} placeholder="Broadcast headline…" rows={2}/></label>
    <div className="livestream-inline-row">
      <label className="field"><span>Preset</span><select value={currentPresetId} onChange={(e) => { const preset = HEADLINE_PRESETS.find((p) => p.id === e.target.value); if (preset) { patchStyle(preset.style); if (preset.sub) subHeadline?.setStyle(preset.sub); } }}><option value="">Custom</option>{HEADLINE_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
      <label className="field"><span>Font</span><select value={style.fontFamily} onChange={(e) => patchStyle({ fontFamily: e.target.value })}>{SUBTITLE_FONTS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}</select></label>
      <label className="field"><span>Align</span><select value={style.textAlign || "center"} onChange={(e) => patchStyle({ textAlign: e.target.value })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
    </div>
    <div className="livestream-inline-row">
      <label className="field"><span>Position <b>{headlinePosition}%</b></span>
        <Stepper value={headlinePosition} min={0} max={maxPos} rangeStep={1} nudge={5} onChange={setHeadlinePosition} labels={{ decrease:"Move headline up", increase:"Move headline down" }}/>
      </label>
      <label className="field"><span>Size <b>{style.fontScale}%</b></span>
        <Stepper value={style.fontScale} min={60} max={300} rangeStep={5} nudge={10} onChange={(v) => patchStyle({ fontScale: v })} labels={{ decrease:"Decrease headline size", increase:"Increase headline size" }}/>
      </label>
      <label className="field"><span>Opacity <b>{style.bgOpacity}%</b></span><input type="range" min="0" max="100" step="5" value={style.bgOpacity} onChange={(e) => patchStyle({ bgOpacity: Number(e.target.value) })}/></label>
    </div>
    <ColorSwatchRow label="Text" colors={HEADLINE_TEXT_SWATCHES} value={style.textColor} onChange={(color) => patchStyle({ textColor: color })}/>
    <ColorSwatchRow label="BG" colors={HEADLINE_BG_SWATCHES} value={style.bgColor} onChange={(color) => patchStyle({ bgColor: color })}/>
    {subHeadline && <div style={{ borderTop:"1px solid var(--line)", paddingTop:"8px", marginTop:"2px" }}>
      <label className="field"><span>Subtitle</span><input value={subHeadline.text} onChange={(e) => subHeadline.setText(e.target.value)} placeholder="Episode title or subtitle…" /></label>
      <div className="livestream-inline-row" style={{ marginTop:"6px" }}>
        <label className="field"><span>Size <b>{subHeadline.style.fontScale}%</b></span>
          <Stepper value={subHeadline.style.fontScale} min={40} max={200} rangeStep={5} nudge={10} onChange={(v) => subHeadline.setStyle({ fontScale: v })} labels={{ decrease:"Decrease subtitle size", increase:"Increase subtitle size" }}/>
        </label>
        <label className="field"><span>Color</span>
          <ColorSwatchRow label="Subtitle" colors={HEADLINE_SUB_SWATCHES} value={subHeadline.style.textColor} onChange={(color) => subHeadline.setStyle({ textColor: color })} style={{ marginTop:0 }}/>
        </label>
      </div>
    </div>}
  </>;
}

export function BroadcastHeadlineOverlay({ headlineText, headlinePosition, subtitleStyle, headlineStyle, subHeadlineText, subHeadlineStyle }: {
  headlineText: string;
  headlinePosition: number;
  subtitleStyle: Partial<SubtitleStyle>;
  headlineStyle?: Partial<HeadlineStyle> | null;
  subHeadlineText?: string;
  subHeadlineStyle?: Partial<SubHeadlineStyle> | null;
}) {
  const hs = headlineStyle ? normalizeHeadlineStyle(headlineStyle) : null;
  const fontFamily = hs?.fontFamily || normalizeSubtitleStyle(subtitleStyle).fontFamily;
  const fontScale = hs?.fontScale || 100;
  const textColor = hs?.textColor || "#ffffff";
  const background = hexOpacityCss(hs?.bgColor || "#000000", hs?.bgOpacity ?? 65);
  const headlineFontSizeCqh = 0.028 * fontScale * 1.15;
  const outlinePx = Math.max(1, 2.5);
  const outlineColor = "#000000";
  const shadow = [`0 ${outlinePx}px 0 ${outlineColor}`,`0 -${outlinePx}px 0 ${outlineColor}`,`${outlinePx}px 0 0 ${outlineColor}`,`-${outlinePx}px 0 0 ${outlineColor}`].join(", ");
  const subScale = subHeadlineStyle?.fontScale || 70;
  const subColor = subHeadlineStyle?.textColor || "#e0d5c0";
  const subFontSizeCqh = 0.028 * subScale * 0.85;
  return <div className="preview-headline" style={{ top:`${headlinePosition}%`, background, fontFamily, fontWeight:700, textAlign:hs?.textAlign || "center" }}><span style={{ color:textColor, fontSize:`${headlineFontSizeCqh}cqh`, fontWeight:700, whiteSpace:"pre-line", textShadow:shadow, display:"block" }}>{headlineText}</span>{subHeadlineText && <span style={{ color:subColor, fontSize:`${subFontSizeCqh}cqh`, fontWeight:400, whiteSpace:"pre-line", marginTop:"0.3em", display:"block" }}>{subHeadlineText}</span>}</div>;
}
