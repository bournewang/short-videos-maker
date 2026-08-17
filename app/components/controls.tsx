"use client";

import type { CSSProperties } from "react";

/* ---- Swatch palettes ---- */

export const HEADLINE_TEXT_SWATCHES = Object.freeze([
  "#ffffff", "#f5f0e8", "#fff3e0", "#ffeb3b", "#e0e0e0", "#cccccc",
]);

export const HEADLINE_BG_SWATCHES = Object.freeze([
  "#000000", "#1a1a1a", "#cc0000", "#1a1a2e", "#3e2723", "#0a0a0a",
]);

export const HEADLINE_SUB_SWATCHES = Object.freeze([
  "#c0b8a8", "#d4a574", "#ffe082", "#9098b0", "#e0d5c0", "#ffcccc",
]);

/* ---- Stepper ---- */

type StepperProps = {
  value: number;
  min: number;
  max: number;
  nudge: number;
  onChange: (value: number) => void;
  className?: string;
  format?: (v: number) => string;
  /** When provided, renders a range slider instead of a plain output display. */
  rangeStep?: number;
  /** Show an explicit <output> alongside the range slider. */
  showOutput?: boolean;
  labels?: { decrease?: string; increase?: string; range?: string };
};

export function Stepper({ value, min, max, nudge, onChange, className, format, rangeStep, showOutput, labels }: StepperProps) {
  const display = format ? format(value) : String(value);

  function decrease() { onChange(Math.max(min, value - nudge)); }
  function increase() { onChange(Math.min(max, value + nudge)); }

  if (rangeStep !== undefined) {
    return (
      <div className={className}>
        <button type="button" aria-label={labels?.decrease} onClick={decrease}>−</button>
        <input
          type="range"
          min={min}
          max={max}
          step={rangeStep}
          value={value}
          aria-label={labels?.range}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <button type="button" aria-label={labels?.increase} onClick={increase}>+</button>
        {showOutput && <output>{display}</output>}
      </div>
    );
  }

  return (
    <div className={className}>
      <button type="button" aria-label={labels?.decrease} onClick={decrease}>−</button>
      <output>{display}</output>
      <button type="button" aria-label={labels?.increase} onClick={increase}>+</button>
    </div>
  );
}

/* ---- ColorSwatchRow ---- */

type ColorSwatchRowProps = {
  label: string;
  colors: readonly string[];
  value: string;
  onChange: (color: string) => void;
  style?: CSSProperties;
};

export function ColorSwatchRow({ label, colors, value, onChange, style }: ColorSwatchRowProps) {
  return (
    <div className="color-swatch-row" style={style}>
      <span>{label}</span>
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          className={`color-swatch${color === value ? " selected" : ""}`}
          style={{ backgroundColor: color }}
          title={color}
          aria-label={color}
          aria-pressed={color === value}
          onClick={() => onChange(color)}
        />
      ))}
      <input
        type="color"
        value={value}
        aria-label={`Custom ${label} color`}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
