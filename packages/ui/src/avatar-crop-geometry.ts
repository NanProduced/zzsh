export function avatarCropRect(width: number, height: number, zoom = 1, panX = 0, panY = 0) {
  if (![width, height, zoom, panX, panY].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('图片尺寸无法读取');
  const side = Math.min(width, height) / Math.min(3, Math.max(1, zoom));
  const x = Math.max(-1, Math.min(1, panX)), y = Math.max(-1, Math.min(1, panY));
  return { x: (width - side) * (x + 1) / 2, y: (height - side) * (y + 1) / 2, size: side };
}
