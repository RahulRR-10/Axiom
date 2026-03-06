import React, { useState, useRef, useEffect } from 'react';
import {
  Highlighter,
  StickyNote,
  Type,
  Pencil,
  Image,
  Eraser,
  ZoomIn,
  ZoomOut,
  Save,
} from 'lucide-react';

export type PDFTool =
  | 'none'
  | 'highlight'
  | 'sticky'
  | 'textbox'
  | 'draw'
  | 'image'
  | 'eraser';

export const HIGHLIGHT_COLORS = [
  { label: 'Yellow', value: '#fde68a' },
  { label: 'Green',  value: '#a7f3d0' },
  { label: 'Pink',   value: '#fbb6ce' },
  { label: 'Blue',   value: '#93c5fd' },
  { label: 'Clear',  value: 'clear'   },
] as const;

export const TEXT_COLORS = [
  { label: 'White',  value: '#ffffff' },
  { label: 'Red',    value: '#ef4444' },
  { label: 'Yellow', value: '#facc15' },
  { label: 'Green',  value: '#22c55e' },
  { label: 'Blue',   value: '#3b82f6' },
  { label: 'Black',  value: '#1a1a1a' },
] as const;

export const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 36] as const;

type Props = {
  activeTool:        PDFTool;
  onToolChange:      (tool: PDFTool) => void;
  highlightColor:    string;
  onColorChange:     (color: string) => void;
  zoomLevel:         number;
  onZoomChange:      (z: number) => void;
  onSave?:           () => void;
  saving?:           boolean;
  currentPage?:      number;
  numPages?:         number;
  fontSize:          number;
  onFontSizeChange:  (s: number) => void;
  textColor:         string;
  onTextColorChange: (c: string) => void;
};

export const PDFToolbar: React.FC<Props> = ({
  activeTool,
  onToolChange,
  highlightColor,
  onColorChange,
  zoomLevel,
  onZoomChange,
  onSave,
  saving = false,
  currentPage = 1,
  numPages = 0,
  fontSize,
  onFontSizeChange,
  textColor,
  onTextColorChange,
}) => {
  const [colorOpen, setColorOpen]       = useState(false);
  const [fontSizeOpen, setFontSizeOpen] = useState(false);
  const [textColorOpen, setTextColorOpen] = useState(false);
  const colorRef    = useRef<HTMLDivElement>(null);
  const fontRef     = useRef<HTMLDivElement>(null);
  const textColRef  = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (colorRef.current && !colorRef.current.contains(e.target as Node)) setColorOpen(false);
      if (fontRef.current && !fontRef.current.contains(e.target as Node)) setFontSizeOpen(false);
      if (textColRef.current && !textColRef.current.contains(e.target as Node)) setTextColorOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const btnClass = (tool: PDFTool) =>
    `h-8 w-8 flex items-center justify-center rounded transition-colors ${
      activeTool === tool
        ? 'bg-[#3a3a3a] text-[#e4e4e4]'
        : 'text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4]'
    }`;

  const toggle = (tool: PDFTool) =>
    onToolChange(activeTool === tool ? 'none' : tool);

  return (
    <div
      style={{
        height:       '44px',
        background:   '#1e1e1e',
        borderBottom: '1px solid #2a2a2a',
        flexShrink:   0,
      }}
      className="flex items-center px-3"
    >
      {/* ── Left: tool buttons ── */}
      <div className="flex items-center gap-1">

        {/* Highlight + color picker */}
        <div className="relative" ref={colorRef}>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => toggle('highlight')}
              className={btnClass('highlight')}
              title="Highlight"
            >
              <Highlighter size={16} />
            </button>
            <button
              type="button"
              onClick={() => setColorOpen(o => !o)}
              className="h-8 flex items-center justify-center px-1 rounded hover:bg-[#2a2a2a] transition-colors"
              title="Highlight color"
            >
              <span
                style={{ background: highlightColor === 'clear'
                  ? 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 6px 6px'
                  : highlightColor }}
                className="inline-block w-3 h-3 rounded-sm border border-[#444]"
              />
              <span className="text-[#6e6e6e] text-xs ml-0.5">▾</span>
            </button>
          </div>

          {colorOpen && (
            <div
              style={{
                position: 'absolute', top: '36px', left: 0,
                background: '#2d2d2d', border: '1px solid #444',
                borderRadius: '8px', padding: '6px', zIndex: 100,
                display: 'flex', gap: '6px',
              }}
            >
              {HIGHLIGHT_COLORS.map(c => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => { onColorChange(c.value); setColorOpen(false); }}
                  title={c.label}
                  style={c.value === 'clear' ? {
                    background: 'repeating-conic-gradient(#555 0% 25%, #333 0% 50%) 50% / 8px 8px',
                  } : { background: c.value }}
                  className={`w-7 h-7 rounded border-2 transition-colors ${
                    highlightColor === c.value ? 'border-white' : 'border-transparent'
                  }`}
                />
              ))}
            </div>
          )}
        </div>

        <button type="button" onClick={() => toggle('sticky')}   className={btnClass('sticky')}  title="Sticky Note"><StickyNote size={16} /></button>

        {/* Textbox + font size + text color */}
        <div className="flex items-center">
          <button type="button" onClick={() => toggle('textbox')} className={btnClass('textbox')} title="Text Box"><Type size={16} /></button>

          {/* Font size dropdown */}
          <div className="relative" ref={fontRef}>
            <button
              type="button"
              onClick={() => { setFontSizeOpen(o => !o); setTextColorOpen(false); }}
              className="h-8 flex items-center px-1 rounded hover:bg-[#2a2a2a] transition-colors text-[#8a8a8a] text-xs"
              title="Font size"
            >
              {fontSize}
              <span className="text-[#6e6e6e] ml-0.5">▾</span>
            </button>
            {fontSizeOpen && (
              <div style={{
                position: 'absolute', top: '36px', left: 0,
                background: '#2d2d2d', border: '1px solid #444',
                borderRadius: '6px', padding: '4px', zIndex: 100,
                maxHeight: '200px', overflowY: 'auto',
              }}>
                {FONT_SIZES.map(s => (
                  <button
                    key={s} type="button"
                    onClick={() => { onFontSizeChange(s); setFontSizeOpen(false); }}
                    className={`block w-full text-left px-3 py-1 text-xs rounded transition-colors ${
                      fontSize === s ? 'bg-[#3a3a3a] text-white' : 'text-[#ccc] hover:bg-[#333]'
                    }`}
                  >
                    {s}px
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Text color picker */}
          <div className="relative" ref={textColRef}>
            <button
              type="button"
              onClick={() => { setTextColorOpen(o => !o); setFontSizeOpen(false); }}
              className="h-8 flex items-center px-1 rounded hover:bg-[#2a2a2a] transition-colors"
              title="Text color"
            >
              <span style={{ background: textColor }} className="inline-block w-3 h-3 rounded-sm border border-[#444]" />
              <span className="text-[#6e6e6e] text-xs ml-0.5">▾</span>
            </button>
            {textColorOpen && (
              <div style={{
                position: 'absolute', top: '36px', left: 0,
                background: '#2d2d2d', border: '1px solid #444',
                borderRadius: '8px', padding: '6px', zIndex: 100,
                display: 'flex', gap: '6px',
              }}>
                {TEXT_COLORS.map(c => (
                  <button
                    key={c.value} type="button"
                    onClick={() => { onTextColorChange(c.value); setTextColorOpen(false); }}
                    title={c.label}
                    style={{ background: c.value }}
                    className={`w-6 h-6 rounded border-2 transition-colors ${
                      textColor === c.value ? 'border-white' : 'border-transparent'
                    }`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
        <button type="button" onClick={() => toggle('draw')}     className={btnClass('draw')}    title="Draw"><Pencil size={16} /></button>
        <button type="button" onClick={() => toggle('image')}    className={btnClass('image')}   title="Image Stamp"><Image size={16} /></button>
        <button type="button" onClick={() => toggle('eraser')}   className={btnClass('eraser')}  title="Eraser"><Eraser size={16} /></button>
      </div>

      {/* ── Center: page indicator ── */}
      <div className="flex-1 flex items-center justify-center">
        {numPages > 0 && (
          <span className="text-xs text-[#8a8a8a] select-none">
            Page {currentPage} / {numPages}
          </span>
        )}
      </div>

      {/* ── Right: save + zoom controls ── */}
      <div className="flex items-center gap-1">
        {/* Save button */}
        {onSave && (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            className={`h-8 px-3 flex items-center gap-1.5 rounded text-xs transition-colors ${
              saving
                ? 'bg-[#2a2a2a] text-[#6e6e6e] cursor-wait'
                : 'text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4]'
            }`}
            title="Save annotated PDF"
          >
            <Save size={14} />
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}

        <span className="w-px h-5 bg-[#333] mx-1" />

        <button
          type="button"
          onClick={() => onZoomChange(Math.max(0.25, zoomLevel - 0.25))}
          className="h-8 w-8 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors"
          title="Zoom Out"
        >
          <ZoomOut size={16} />
        </button>
        <span className="text-xs text-[#d4d4d4] w-12 text-center select-none">
          {Math.round(zoomLevel * 100)}%
        </span>
        <button
          type="button"
          onClick={() => onZoomChange(Math.min(4, zoomLevel + 0.25))}
          className="h-8 w-8 flex items-center justify-center rounded text-[#8a8a8a] hover:bg-[#2a2a2a] hover:text-[#d4d4d4] transition-colors"
          title="Zoom In"
        >
          <ZoomIn size={16} />
        </button>
      </div>
    </div>
  );
};
