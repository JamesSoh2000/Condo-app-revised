import React, { useRef, useState } from 'react';
import { base44 } from '@/api/base44Client';
import { Paperclip, X, FileText, Image, File, Loader2 } from 'lucide-react';

const MAX_SIZE_BYTES = 30 * 1024 * 1024; // 30MB
const ALLOWED_TYPES = {
  'application/pdf': 'pdf',
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function FileIcon({ type }) {
  if (type === 'pdf') return <FileText className="w-5 h-5 text-red-500" />;
  if (type === 'image') return <Image className="w-5 h-5 text-blue-500" />;
  return <File className="w-5 h-5 text-zinc-500" />;
}

export default function NoticeAttachmentUpload({ attachment, onChange }) {
  const inputRef = useRef(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);

  const handleFile = async (file) => {
    setError('');
    if (!file) return;

    const detectedType = ALLOWED_TYPES[file.type];
    if (!detectedType) {
      setError('File type not supported. Use PDF, JPG, PNG, WEBP, or DOCX.');
      return;
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError(`File too large. Max size is ${formatBytes(MAX_SIZE_BYTES)}.`);
      return;
    }

    setLoading(true);
    const { file_url } = await base44.integrations.Core.UploadFile({ file });
    setLoading(false);

    onChange({
      attachment_url: file_url,
      attachment_type: detectedType,
      attachment_name: file.name,
      attachment_size: file.size,
    });
  };

  const handleInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  const handleRemove = () => {
    onChange(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="space-y-2">
      {attachment ? (
        <div className="flex items-center gap-3 p-3 bg-zinc-50 border border-zinc-200 rounded-lg">
          <FileIcon type={attachment.attachment_type} />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">{attachment.attachment_name}</p>
            <p className="text-xs text-zinc-400">{formatBytes(attachment.attachment_size)}</p>
          </div>
          <button
            onClick={handleRemove}
            className="p-1 rounded hover:bg-zinc-200 text-zinc-400 hover:text-zinc-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div
          className={`relative border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors
            ${dragging ? 'border-zinc-400 bg-zinc-50' : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50/50'}
            ${loading ? 'pointer-events-none opacity-60' : ''}
          `}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            accept=".pdf,.jpg,.jpeg,.png,.webp,.docx"
            onChange={handleInputChange}
          />
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-zinc-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Uploading...</span>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 text-zinc-400">
              <Paperclip className="w-4 h-4" />
              <span className="text-sm">Attach file (PDF, Image, DOCX · max 30MB)</span>
            </div>
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}