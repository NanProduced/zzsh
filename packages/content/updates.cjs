const UPDATE_SURFACES = ['publish', 'rental', 'orders'];
const DEFAULT_UPDATE_SETTINGS = Object.freeze({ format: 'plain', tickerEnabled: false, tickerFrom: null, tickerUntil: null, pinned: false, pinnedUntil: null, validUntil: null, noticeKind: 'general', effectiveAt: null, impact: '', surfaces: Object.freeze([]), mediaIds: Object.freeze([]) });
function updateSettings(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !Object.prototype.hasOwnProperty.call(DEFAULT_UPDATE_SETTINGS, k))) throw new Error('动态发布设置字段无效');
  const row = { ...DEFAULT_UPDATE_SETTINGS, ...value };
  if (!['plain', 'markdown'].includes(row.format) || !['general', 'maintenance', 'rule-change'].includes(row.noticeKind) || typeof row.tickerEnabled !== 'boolean' || typeof row.pinned !== 'boolean') throw new Error('动态发布设置无效');
  for (const key of ['tickerFrom', 'tickerUntil', 'pinnedUntil', 'validUntil', 'effectiveAt']) {
    const text = row[key];
    if (text !== null && (typeof text !== 'string' || text.startsWith('0000') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(text) || !Number.isFinite(Date.parse(text)) || new Date(text).toISOString().slice(0, 19) !== text.slice(0, 19))) throw new Error(`${key} 必须是有效的 UTC 时间`);
  }
  if (typeof row.impact !== 'string' || row.impact.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.impact)) throw new Error('影响范围最多500字符');
  if (!Array.isArray(row.surfaces) || row.surfaces.length > 3 || new Set(row.surfaces).size !== row.surfaces.length || row.surfaces.some(x => !UPDATE_SURFACES.includes(x))) throw new Error('提醒页面无效');
  if (!Array.isArray(row.mediaIds) || row.mediaIds.length > 300 || new Set(row.mediaIds).size !== row.mediaIds.length || row.mediaIds.some(x => typeof x !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(x))) throw new Error('正文媒体清单无效');
  if (row.tickerFrom && row.tickerUntil && Date.parse(row.tickerFrom) >= Date.parse(row.tickerUntil)) throw new Error('轮播开始时间必须早于结束时间');
  return { ...row, surfaces: [...row.surfaces], mediaIds: [...row.mediaIds] };
}
function checkUpdatePublication(type, value) {
  const row = updateSettings(value);
  if (row.tickerEnabled && !row.tickerUntil) throw new Error('首页轮播必须填写结束时间');
  if (row.pinned && (type !== 'ANNOUNCEMENT' || !row.pinnedUntil)) throw new Error('只有公告可置顶，且必须填写置顶结束时间');
  if (type !== 'ANNOUNCEMENT' && (row.noticeKind !== 'general' || row.surfaces.length)) throw new Error('业务提醒只能由公告发布');
  if (row.noticeKind !== 'general' && (!row.effectiveAt || !row.impact.trim() || !row.surfaces.length)) throw new Error('维护或规则调整公告必须填写生效时间、影响范围及至少一个提醒页面');
  return row;
}
function updateVisibility(value, now = Date.now()) {
  const s = updateSettings(value), time = x => x ? Date.parse(x) : null;
  const expired = time(s.validUntil) !== null && now >= time(s.validUntil);
  return { expired, ticker: !expired && s.tickerEnabled && Boolean(s.tickerUntil) && (!s.tickerFrom || now >= time(s.tickerFrom)) && now < time(s.tickerUntil), pinned: !expired && s.pinned && Boolean(s.pinnedUntil) && now < time(s.pinnedUntil), reminder: !expired && s.surfaces.length > 0 };
}
// Legacy plain text must retain literal Markdown/HTML punctuation when rendered.
function plainTextMarkdown(text) { return text.replace(/([^A-Za-z0-9\s\u0080-\uFFFF])/g, '\\$1').replace(/\n/g, '  \n'); }
module.exports = { UPDATE_SURFACES, DEFAULT_UPDATE_SETTINGS, updateSettings, checkUpdatePublication, updateVisibility, plainTextMarkdown };
