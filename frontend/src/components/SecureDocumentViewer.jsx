import React, { useState, useRef } from 'react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { X, ZoomIn, ZoomOut, RotateCcw, Download, FileText } from 'lucide-react';

function getFileType(url) {
  if (!url) return 'unknown';
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg)$/)) return 'image';
  return 'other';
}

function ImageViewer({ url, fileName }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef(null);

  const zoomIn = () => setScale(s => Math.min(s + 0.25, 4));
  const zoomOut = () => setScale(s => Math.max(s - 0.25, 0.5));
  const reset = () => { setScale(1); setPosition({ x: 0, y: 0 }); };

  const onMouseDown = (e) => {
    if (scale <= 1) return;
    setIsDragging(true);
    dragStart.current = { mx: e.clientX - position.x, my: e.clientY - position.y };
  };
  const onMouseMove = (e) => {
    if (!isDragging || !dragStart.current) return;
    setPosition({ x: e.clientX - dragStart.current.mx, y: e.clientY - dragStart.current.my });
  };
  const onMouseUp = () => setIsDragging(false);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 border-b bg-zinc-50">
        <span className="text-xs text-zinc-500 flex-1 truncate">{fileName}</span>
        <Button variant="ghost" size="sm" onClick={zoomOut} disabled={scale <= 0.5}><ZoomOut className="w-4 h-4" /></Button>
        <span className="text-xs text-zinc-600 w-12 text-center">{Math.round(scale * 100)}%</span>
        <Button variant="ghost" size="sm" onClick={zoomIn} disabled={scale >= 4}><ZoomIn className="w-4 h-4" /></Button>
        <Button variant="ghost" size="sm" onClick={reset}><RotateCcw className="w-4 h-4" /></Button>
        <a href={url} download={fileName} target="_blank" rel="noopener noreferrer">
          <Button variant="ghost" size="sm"><Download className="w-4 h-4" /></Button>
        </a>
      </div>
      <div
        className="flex-1 overflow-hidden bg-zinc-100 flex items-center justify-center"
        style={{ cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default' }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        <img
          src={url}
          alt={fileName}
          draggable={false}
          style={{
            transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
            transition: isDragging ? 'none' : 'transform 0.15s ease',
            maxWidth: '100%',
            maxHeight: '100%',
            objectFit: 'contain',
            userSelect: 'none',
          }}
        />
      </div>
    </div>
  );
}

function PdfViewer({ url, fileName }) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 p-2 border-b bg-zinc-50">
        <FileText className="w-4 h-4 text-red-500" />
        <span className="text-xs text-zinc-500 flex-1 truncate">{fileName}</span>
        <a href={url} download={fileName} target="_blank" rel="noopener noreferrer">
          <Button variant="ghost" size="sm"><Download className="w-4 h-4" /></Button>
        </a>
      </div>
      <div className="flex-1">
        <iframe
          src={url + '#toolbar=1&navpanes=0'}
          title={fileName}
          className="w-full h-full border-0"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
        />
      </div>
    </div>
  );
}

function OtherViewer({ url, fileName }) {
  return (
    <div className="flex flex-col h-full items-center justify-center gap-4 p-8">
      <FileText className="w-16 h-16 text-zinc-300" />
      <div className="text-center">
        <p className="font-medium text-zinc-700">{fileName}</p>
        <p className="text-sm text-zinc-400 mt-1">This file type cannot be previewed inline.</p>
      </div>
      <a href={url} download={fileName} target="_blank" rel="noopener noreferrer">
        <Button>
          <Download className="w-4 h-4 mr-2" />
          Download File
        </Button>
      </a>
    </div>
  );
}

export default function SecureDocumentViewer({ open, onClose, url, label }) {
  if (!url) return null;
  const fileType = getFileType(url);
  const fileName = label || url.split('/').pop().split('?')[0] || 'Document';

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl w-full p-0 overflow-hidden" style={{ height: '85vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 bg-zinc-900 text-white flex-none">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-zinc-400" />
            <span className="font-medium text-sm truncate max-w-xs">{label || fileName}</span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="text-zinc-400 hover:text-white hover:bg-zinc-700 h-8 w-8"
            onClick={onClose}
          >
            <X className="w-4 h-4" />
          </Button>
        </div>

        {/* Viewer body */}
        <div className="flex-1 overflow-hidden" style={{ height: 'calc(85vh - 52px)' }}>
          {fileType === 'image' && <ImageViewer url={url} fileName={fileName} />}
          {fileType === 'pdf' && <PdfViewer url={url} fileName={fileName} />}
          {fileType === 'other' && <OtherViewer url={url} fileName={fileName} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}