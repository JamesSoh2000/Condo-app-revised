import React, { useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ZoomIn, ZoomOut, Download, RotateCcw, FileText, File } from 'lucide-react';

function formatBytes(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// --- Image Viewer with pan + zoom ---
function ImageViewer({ url, name }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef(null);
  const containerRef = useRef(null);

  const zoomIn = () => setScale(s => Math.min(s + 0.3, 5));
  const zoomOut = () => setScale(s => Math.max(s - 0.3, 0.3));
  const reset = () => { setScale(1); setPosition({ x: 0, y: 0 }); };

  const onMouseDown = (e) => {
    if (scale <= 1) return;
    setDragging(true);
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
  };
  const onMouseMove = (e) => {
    if (!dragging || !dragStart.current) return;
    setPosition({ x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y });
  };
  const onMouseUp = () => { setDragging(false); dragStart.current = null; };

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.15 : 0.15;
    setScale(s => Math.max(0.3, Math.min(5, s + delta)));
  }, []);

  return (
    <div className="flex flex-col h-full">
      {/* Controls */}
      <div className="flex items-center gap-2 p-2 bg-zinc-100 border-b border-zinc-200 flex-shrink-0">
        <Button variant="outline" size="sm" onClick={zoomOut}><ZoomOut className="w-4 h-4" /></Button>
        <span className="text-sm font-mono w-14 text-center">{Math.round(scale * 100)}%</span>
        <Button variant="outline" size="sm" onClick={zoomIn}><ZoomIn className="w-4 h-4" /></Button>
        <Button variant="outline" size="sm" onClick={reset}><RotateCcw className="w-4 h-4" /></Button>
        <div className="flex-1" />
        <a href={url} download={name} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm"><Download className="w-4 h-4 mr-1" />Download</Button>
        </a>
      </div>

      {/* Image canvas */}
      <div
        ref={containerRef}
        className="flex-1 overflow-hidden flex items-center justify-center bg-zinc-900 select-none"
        style={{ cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'default' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      >
        <img
          src={url}
          alt={name}
          draggable={false}
          style={{
            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
            transformOrigin: 'center center',
            transition: dragging ? 'none' : 'transform 0.15s ease',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            imageRendering: 'high-quality',
          }}
        />
      </div>
    </div>
  );
}

// --- PDF Viewer using browser embed ---
function PDFViewer({ url, name }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 bg-zinc-100 border-b border-zinc-200 flex-shrink-0">
        <FileText className="w-4 h-4 text-red-500" />
        <span className="text-sm font-medium truncate flex-1">{name}</span>
        <a href={url} download={name} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm"><Download className="w-4 h-4 mr-1" />Download</Button>
        </a>
      </div>
      <div className="flex-1">
        <iframe
          src={url + '#toolbar=1&navpanes=0&scrollbar=1&zoom=page-fit'}
          className="w-full h-full border-0"
          title={name}
          style={{ minHeight: 400 }}
        />
      </div>
    </div>
  );
}

// --- DOCX: show download + embedded iframe attempt ---
function DocxViewer({ url, name }) {
  // Use Microsoft Office Online viewer for DOCX files
  const officeViewerUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}`;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 bg-zinc-100 border-b border-zinc-200 flex-shrink-0">
        <File className="w-4 h-4 text-blue-500" />
        <span className="text-sm font-medium truncate flex-1">{name}</span>
        <a href={url} download={name} target="_blank" rel="noopener noreferrer">
          <Button variant="outline" size="sm"><Download className="w-4 h-4 mr-1" />Download</Button>
        </a>
      </div>
      <div className="flex-1">
        <iframe
          src={officeViewerUrl}
          className="w-full h-full border-0"
          title={name}
          style={{ minHeight: 400 }}
        />
      </div>
    </div>
  );
}

// --- Main exported viewer ---
export default function AttachmentViewer({ update }) {
  const { attachment_url, attachment_type, attachment_name, attachment_size } = update || {};

  if (!attachment_url) return null;

  return (
    <div className="mt-4 rounded-xl border border-zinc-200 overflow-hidden bg-white" style={{ height: 480 }}>
      {attachment_type === 'image' && (
        <ImageViewer url={attachment_url} name={attachment_name} />
      )}
      {attachment_type === 'pdf' && (
        <PDFViewer url={attachment_url} name={attachment_name} />
      )}
      {attachment_type === 'docx' && (
        <DocxViewer url={attachment_url} name={attachment_name} />
      )}
      {!attachment_type && (
        <div className="flex items-center justify-center h-full">
          <a href={attachment_url} download={attachment_name} target="_blank" rel="noopener noreferrer">
            <Button variant="outline"><Download className="w-4 h-4 mr-2" />Download {attachment_name}</Button>
          </a>
        </div>
      )}
    </div>
  );
}