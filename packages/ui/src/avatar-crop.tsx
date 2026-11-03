"use client";
import { useEffect, useRef, useState } from 'react';
import { avatarCropRect } from './avatar-crop-geometry';

/** Local preview only. The caller still sends the cropped image through its existing upload/review API. */
export function AvatarCropper({ file, onConfirm, onCancel }: { file: File; onConfirm: (file: File) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null), image = useRef<HTMLImageElement | null>(null), sequence = useRef(0);
  const drag = useRef<{ id: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(1), [pan, setPan] = useState({ x: 0, y: 0 });
  useEffect(() => {
    const id = ++sequence.current; setReady(false); setError(''); setZoom(1); setPan({ x: 0, y: 0 });
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size <= 0 || file.size > 10 * 1024 * 1024) { setError('请选择不超过 10 MiB 的 JPEG、PNG 或 WebP 图片。'); return; }
    const url = URL.createObjectURL(file), source = new Image();
    source.onload = () => {
      if (sequence.current !== id) return;
      if (!source.naturalWidth || !source.naturalHeight || Math.max(source.naturalWidth, source.naturalHeight) > 8192 || source.naturalWidth * source.naturalHeight > 40000000) { setError('图片尺寸过大，请选择单边不超过 8192 像素、总像素不超过 4000 万的图片。'); return; }
      image.current = source; setReady(true);
    };
    source.onerror = () => { if (sequence.current === id) setError('图片无法解码，请重新选择。'); };
    source.src = url;
    return () => { sequence.current++; source.onload = null; source.onerror = null; image.current = null; URL.revokeObjectURL(url); };
  }, [file]);
  useEffect(() => {
    const source = image.current, ctx = canvas.current?.getContext('2d');
    if (!ready || !source || !ctx) return;
    const crop = avatarCropRect(source.naturalWidth, source.naturalHeight, zoom, pan.x, pan.y);
    try { ctx.clearRect(0, 0, 512, 512); ctx.drawImage(source, crop.x, crop.y, crop.size, crop.size, 0, 0, 512, 512); }
    catch { setReady(false); setError('图片无法用于裁剪，请重新选择。'); }
  }, [ready, zoom, pan]);
  const clamp = (v: number) => Math.max(-1, Math.min(1, v));
  const confirm = () => {
    if (!ready || busy || !canvas.current) return;
    const id = sequence.current; setBusy(true); setError('');
    try { canvas.current.toBlob(blob => {
      if (sequence.current !== id) return;
      setBusy(false);
      if (!blob || !blob.size || blob.size > 10 * 1024 * 1024) { setError('裁剪图片生成失败，请重新选择或重试。'); return; }
      onConfirm(new File([blob], blob.type === 'image/webp' ? 'avatar-cropped.webp' : 'avatar-cropped.png', { type: blob.type }));
    }, 'image/webp', .92); } catch { setBusy(false); setError('裁剪图片生成失败，请重新选择。'); }
  };
  return <section className="avatar-crop" aria-label="裁剪头像">
    <p className="avatar-crop-help">拖动图片或用方向键调整位置。</p>
    <div className="avatar-crop-stage">
      <canvas ref={canvas} width={512} height={512} tabIndex={ready ? 0 : -1} role="img" aria-label="头像裁剪预览，使用方向键移动图片"
        onPointerDown={e => { if (!ready || busy) return; e.currentTarget.setPointerCapture(e.pointerId); drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }; }}
        onPointerMove={e => {
          const start = drag.current, source = image.current;
          if (!start || start.id !== e.pointerId || !source || busy) return;
          const crop = avatarCropRect(source.naturalWidth, source.naturalHeight, zoom), pixels = e.currentTarget.getBoundingClientRect().width;
          setPan({ x: clamp(start.panX - (e.clientX - start.x) / pixels * crop.size * 2 / Math.max(1, source.naturalWidth - crop.size)), y: clamp(start.panY - (e.clientY - start.y) / pixels * crop.size * 2 / Math.max(1, source.naturalHeight - crop.size)) });
        }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
        onKeyDown={e => { if (!ready || busy || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(e.key)) return; e.preventDefault(); if (e.key === 'Home') { setZoom(1); setPan({ x: 0, y: 0 }); } else setPan(p => ({ x: clamp(p.x + (e.key === 'ArrowLeft' ? -.05 : e.key === 'ArrowRight' ? .05 : 0)), y: clamp(p.y + (e.key === 'ArrowUp' ? -.05 : e.key === 'ArrowDown' ? .05 : 0)) })); }} />
      {!ready && !error ? <span role="status">正在读取图片…</span> : null}
    </div>
    <label className="avatar-crop-zoom">缩放<input type="range" min={1} max={3} step={.01} value={zoom} aria-label="头像缩放" disabled={!ready || busy} onChange={e => setZoom(Number(e.currentTarget.value))} /></label>
    {error ? <p className="avatar-crop-error" role="alert">{error}</p> : null}
    <div className="avatar-crop-actions"><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>返回选择</button><button type="button" className="button primary" disabled={!ready || busy} onClick={confirm}>{busy ? '正在生成预览…' : '完成裁剪'}</button></div>
  </section>;
}
