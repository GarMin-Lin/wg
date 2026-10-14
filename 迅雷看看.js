#!/usr/bin/env node
'use strict';
/**
 * 迅雷看看 字幕 —— Stremio 字幕插件 (subtitle addon)
 * 由 Forward 模块 xunlei.subtitle v1.1.0 转换而来。
 *
 * 零依赖，需要 Node 18+（用到全局 fetch / AbortSignal.timeout）。
 * 启动：node index.js
 * 安装：把启动日志里打印的 manifest 地址粘到播放器/Stremio 的插件框里。
 */
const http = require('node:http');

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_RESULTS = Number(process.env.MAX_RESULTS || 10);
const MAX_KEYS = Number(process.env.MAX_KEYS || 5); // 每个请求最多并发几个搜索词
const USE_CINEMETA = process.env.NO_CINEMETA !== '1'; // 无文件名时用片名兜底
const API_BASE = 'https://api-shoulei-ssl.xunlei.com';
const UA = 'ForwardWidgets/1.0.2';
// 代理只允许转发到迅雷自家的字幕 CDN（信任边界，避免被当成开放代理）
const SUB_HOST_ALLOW = ['geilijiasu.com', 'xunlei.com', 'xunlei.cn', 'xunlei.net', 'thunder.com'];

const MANIFEST = {
  id: 'org.xunlei.subtitle.addon',
  version: '1.1.0',
  name: '迅雷看看 字幕',
  description: '基于迅雷看看接口的字幕搜索（仅按片名/文件名搜索），由 Forward 模块转换而来。',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
};

/* ------------------------------------------------------------------ *
 * 工具函数（自 Forward 模块移植）
 * ------------------------------------------------------------------ */

const getText = v => String(v == null ? '' : v).trim();

function pad2(n) {
  return String(n).padStart(2, '0');
}

// 接口 duration 字段单位是毫秒，字符串形态则兼容 1:23:45 / 1小时2分3秒 / 秒数
function parseDuration(value) {
  if (value == null) return 0;
  if (typeof value === 'number' && Number.isFinite(value)) return value > 7200 ? value / 1000 : value;
  const text = getText(value);
  if (!text) return 0;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 7200 ? n / 1000 : n;
  }
  const hms = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
  if (hms) return Number(hms[1] || 0) * 3600 + Number(hms[2] || 0) * 60 + Number(hms[3] || 0);
  const zh = text.match(/(\d+)\s*小时(?:\s*(\d+)\s*分(?:钟)?)?(?:\s*(\d+)\s*秒)?/);
  if (zh) return Number(zh[1] || 0) * 3600 + Number(zh[2] || 0) * 60 + Number(zh[3] || 0);
  return 0;
}

function formatDuration(seconds) {
  const n = Math.floor(Number(seconds) || 0);
  if (n <= 0) return '';
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = n % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
}

function getExt(name) {
  const s = getText(name).toLowerCase();
  if (s.endsWith('.srt')) return '.srt';
  if (s.endsWith('.ass')) return '.ass';
  if (s.endsWith('.ssa')) return '.ssa';
  if (s.endsWith('.vtt')) return '.vtt';
  return '';
}

function getLangTag(langStr) {
  const t = getText(langStr).toLowerCase();
  if (!t) return '【其他】';
  if (t.includes('双语') || t.includes('中英')) return '【双语】';
  if (t.includes('简') || t.includes('chs') || t.includes('zho') || t.includes('chi')) return '【简中】';
  if (t.includes('繁') || t.includes('cht')) return '【繁中】';
  if (t.includes('英') || t.includes('eng')) return '【英文】';
  return '【字幕】';
}

// Stremio 侧的语言码：能识别成 ISO 639-2 就用码（可参与自动选集），否则退回展示文本
function langCode(tag) {
  if (tag === '【英文】') return 'eng';
  if (tag === '【简中】' || tag === '【繁中】' || tag === '【双语】') return 'chi';
  return 'und';
}

/* ------------------------------------------------------------------ *
 * 搜索词提取（自 Forward 模块移植）
 * ------------------------------------------------------------------ */

function extractSearchCode(text) {
  const s = getText(text).toUpperCase();
  if (!s) return '';
  const normalized = s.replace(/\./g, ' ').replace(/_/g, '-').replace(/\s+/g, ' ').trim();
  const patterns = [
    /\bFC2(?:[- ]?PPV)?[- ]?\d{5,8}\b/,
    /\bCARIB[- ]?\d{6,8}\b/,
    /\b1PONDO[- ]?\d{6,8}\b/,
    /\bHEYZO[- ]?\d{3,6}\b/,
    /\bT28[- ]?\d{6,8}\b/,
    /\b(?:S2M|MIAA|SSNI|SNIS|IPX|IPZZ|SSIS|JUQ|MIDE|MIDV|STARS|ABW|RKI|DVAJ|WANZ|LULU|DLDSS|VRTM|SDMU|SDDE|MKMP|HMN|MUDR|ADN|CAWD|PPPE|PRED|MGR|SHKD|MXGS|FSDSS|JUL|KTB|MIAB|GVH|MIMK|JUY|JUTA|IDBD|HND|DASD|CLO|BF|HONB|ROE|CEMD|MIUM|NITR|RCTD|RCT|IPVR|MIBD|JUR|JURD|SOE|ORE|PYO)\s*[-_ ]?\d{2,6}[A-Z]?(?:[-_ ]?[A-Z]{0,4})?\b/,
    /\b[A-Z]{2,10}(\s*[-_ ]?\s*)\d{2,8}[A-Z]?\b/,
    /\b\d{6,8}\b/,
  ];
  for (const reg of patterns) {
    const match = normalized.match(reg);
    if (!match?.[0]) continue;
    // “The Matrix 1999” 这类「片名+年份」会被误判成番号，用年份特征剔除
    const num = match[0].match(/\d+/)?.[0] || '';
    const hasSep = /[-_]/.test(match[1] || '');
    if (!hasSep && /^(?:19|20)\d{2}$/.test(num)) continue;
    return match[0]
      .replace(/\s+/g, '')
      .replace(/_/g, '-')
      .replace(/-+/g, '-')
      .toUpperCase();
  }
  return '';
}

function stripEpisodeMarkers(text) {
  return getText(text)
    .replace(/\b(?:第\s*\d+\s*集|第\s*\d+\s*話|EP\s*\d+|E\s*\d+|S\d{1,2}E\d{1,2}|\d{1,2}x\d{1,2}|Season\s*\d+\s*Episode\s*\d+)\b/gi, ' ')
    .replace(/\b(?:第\s*\d+\s*季|Season\s*\d+)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const RELEASE_TAGS = /\b(?:2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr10\+?|hdr|dolbyvision|dovi|sdr|web-?dl|web-?rip|webrip|hdtv|bluray|blu-ray|bdrip|brrip|dvdrip|hdrip|remux|x264|x265|h\.?264|h\.?265|hevc|avc|10bit|8bit|aac|ac3|eac3|dts(?:-hd)?|truehd|atmos|flac|repack|proper|extended|imax|multi|dual|chs|cht|chinese|english|subs|sub|中字|中英|简繁|简中|繁中|国语|粤语|双语|内嵌|外挂)\b/gi;

function cleanReleaseName(name) {
  return getText(name)
    .replace(/[._]+/g, ' ')
    .replace(RELEASE_TAGS, ' ')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/\s*-\s*[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]{1,11}\s*$/, '') // 去尾部发布组（须含字母，避免吃掉番号数字）
    .replace(/\s+/g, ' ')
    .trim();
}

function buildContext({ mediaType, id, extra, metaTitle }) {
  const filename = getText(extra.filename);
  const rawName = filename
    .replace(/\.(mkv|mp4|avi|mov|wmv|flv|ts|m2ts|m4v|webm|rmvb|iso)$/i, '')
    .trim();
  const fileTitle = cleanReleaseName(stripEpisodeMarkers(rawName));
  const title = fileTitle || getText(metaTitle) || rawName;

  const m = getText(id).match(/:(\d+):(\d+)$/);
  const season = m ? Number(m[1]) : 0;
  const episode = m ? Number(m[2]) : 0;

  const code = extractSearchCode([rawName, metaTitle].filter(Boolean).join(' '));

  let searchKeys = [];
  if (code) {
    searchKeys.push(code, code.replace(/[-_]/g, ''));
  }
  if (mediaType === 'series' && season > 0) {
    for (const base of [title, getText(metaTitle)].filter(Boolean)) {
      if (episode > 0) searchKeys.push(`${base} S${pad2(season)}E${pad2(episode)}`, `${base} ${pad2(season)}x${pad2(episode)}`, `${base} E${pad2(episode)}`);
      searchKeys.push(`${base} S${pad2(season)}`);
    }
  }
  searchKeys.push(title);
  if (getText(metaTitle) && getText(metaTitle) !== title) searchKeys.push(getText(metaTitle));
  if (rawName && rawName !== title) searchKeys.push(rawName);

  return {
    mediaType,
    title,
    metaTitle: getText(metaTitle),
    rawName,
    season,
    episode,
    code,
    S: season > 0 ? pad2(season) : '',
    E: episode > 0 ? pad2(episode) : '',
    searchKeys: [...new Set(searchKeys.map(k => getText(k)).filter(k => k.length >= 2))].slice(0, MAX_KEYS),
  };
}

/* ------------------------------------------------------------------ *
 * 打分 / 排序（自 Forward 模块移植，去掉接口不存在的字段）
 * ------------------------------------------------------------------ */

function scoreItem(item, ctx) {
  const text = (item.name + ' ' + item.langs + ' ' + item.ext).toLowerCase();
  const textLoose = text.replace(/[-_\s.]/g, '');
  let score = Number(item.score) || 0;
  score += Number(item.fingerprintScore) || 0;

  if (ctx.code) {
    const c = ctx.code.toLowerCase();
    if (text.includes(c) || textLoose.includes(c.replace(/[-_ ]/g, ''))) score += 25000;
  }
  if (item.duration > 0) score += 50;

  if (ctx.mediaType === 'series' && ctx.S && ctx.E) {
    if (text.includes(`s${ctx.S}e${ctx.E}`)) score += 10000;
    else if (text.includes(`${ctx.S}x${ctx.E}`)) score += 9000;
    else if (text.includes(`s${ctx.S}`)) score += 5000;
  }
  for (const t of [ctx.title, ctx.metaTitle]) {
    if (!t) continue;
    const tl = t.toLowerCase();
    if (text.includes(tl) || textLoose.includes(tl.replace(/[-_\s.]/g, ''))) {
      score += 1000;
      break;
    }
  }
  if (ctx.code && ctx.mediaType === 'movie') score += 500;
  if (text.includes('sub') || text.includes('字幕')) score += 300;
  return score;
}

/* ------------------------------------------------------------------ *
 * 迅雷接口
 * ------------------------------------------------------------------ */

async function searchSub(keyword) {
  const url = `${API_BASE}/oracle/subtitle?name=${encodeURIComponent(keyword)}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json();
    if (!data || Number(data.code) !== 0 || !Array.isArray(data.data)) {
      console.warn(`[xunlei] "${keyword}" 失败 code=${data && data.code} msg=${data && (data.msg || data.message)}`);
      return [];
    }
    return data.data;
  } catch (err) {
    console.warn(`[xunlei] "${keyword}" 异常: ${err && err.message}`);
    return [];
  }
}

function normalizeResult(item) {
  const langs = Array.isArray(item.languages) ? item.languages.join(',') : getText(item.languages);
  return {
    id: getText(item.cid || item.gcid || item.url),
    name: getText(item.name || item.simple_name || '迅雷字幕'),
    simpleName: getText(item.simple_name),
    langs,
    ext: getExt(item.name) || (item.ext ? '.' + getText(item.ext).replace(/^\./, '') : '.srt'),
    url: getText(item.url),
    duration: parseDuration(item.duration),
    score: Number(item.score) || 0,
    fingerprintScore: Number(item.fingerprintf_score || item.fingerprint_score || item.fingerprintScore) || 0,
  };
}

async function runSearches(searchKeys) {
  // 并发发出所有候选词，按优先级取第一个有结果的（命中即用，避免串行等待）
  const lists = await Promise.all(searchKeys.map(searchSub));
  for (let i = 0; i < lists.length; i++) {
    if (lists[i].length > 0) return { list: lists[i], hitKey: searchKeys[i] };
  }
  return { list: [], hitKey: '' };
}

async function searchSubtitles(ctx) {
  const { list, hitKey } = await runSearches(ctx.searchKeys);
  let items = list;
  if (items.length === 0) return { subtitles: [], hitKey, used: ctx };

  // 过滤：保留字幕名里含片名/番号的条目，全被过滤掉则退回原始列表
  const needles = [ctx.code, ctx.title, ctx.metaTitle]
    .filter(Boolean)
    .map(s => ({ raw: s.toLowerCase(), loose: s.toLowerCase().replace(/[-_\s.]/g, '') }));
  const matched = items.filter(raw => {
    const text = (getText(raw.name) + ' ' + getText(raw.simple_name) + ' ' + (Array.isArray(raw.languages) ? raw.languages.join(',') : '')).toLowerCase();
    const loose = text.replace(/[-_\s.]/g, '');
    return needles.some(n => text.includes(n.raw) || (n.loose && loose.includes(n.loose)));
  });
  if (matched.length > 0) items = matched;

  const scored = items
    .map(raw => {
      const item = normalizeResult(raw);
      return { item, score: scoreItem(item, ctx) };
    })
    .filter(({ item }) => item.url)
    .sort((a, b) => b.score - a.score);

  const out = [];
  const seen = new Set();
  for (const { item } of scored) {
    if (out.length >= MAX_RESULTS) break;
    const key = `${item.name.toLowerCase()}|${item.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return { subtitles: out, hitKey, used: ctx };
}

async function fetchMetaTitle(mediaType, id) {
  if (!USE_CINEMETA) return '';
  const bare = getText(id).replace(/:\d+:\d+$/, '');
  if (!bare) return '';
  try {
    const res = await fetch(`https://v3-cinemeta.strem.io/meta/${mediaType}/${bare}.json`, {
      signal: AbortSignal.timeout(6000),
    });
    const data = await res.json();
    return getText(data && data.meta && data.meta.name);
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * 字幕文件代理：抓原文件 → 探测编码 → 统一输出 UTF-8
 * ------------------------------------------------------------------ */

function decodeSubtitle(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch { /* 不是合法 UTF-8，继续猜 */ }
  for (const enc of ['gbk', 'big5']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch { /* 该编码不成立 */ }
  }
  return buf.toString('latin1');
}

function isAllowedSubUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    return SUB_HOST_ALLOW.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

function enqueueSubPath(url, ext) {
  return '/sub/' + Buffer.from(url, 'utf8').toString('base64url') + (ext || '');
}

async function handleSubProxy(req, res, pathname) {
  const m = pathname.match(/^\/sub\/([A-Za-z0-9_-]+)(\.[a-z0-9]{2,4})?$/);
  const target = m ? Buffer.from(m[1], 'base64url').toString('utf8') : '';
  if (!target || !isAllowedSubUrl(target)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad subtitle url');
  }
  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
      signal: AbortSignal.timeout(20000),
    });
    if (!upstream.ok) throw new Error('upstream ' + upstream.status);
    const body = decodeSubtitle(Buffer.from(await upstream.arrayBuffer()));
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(body);
  } catch (err) {
    console.warn(`[proxy] ${target} 失败: ${err && err.message}`);
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('subtitle fetch failed');
  }
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */

function parseExtra(segment) {
  const out = {};
  if (!segment) return out;
  for (const pair of segment.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = decodeURIComponent(pair.slice(0, i));
    const v = pair.slice(i + 1);
    try {
      out[k] = decodeURIComponent(v.replace(/\+/g, '%20'));
    } catch {
      out[k] = v;
    }
  }
  return out;
}

async function handleSubtitles(req, res, pathname, origin) {
  // /subtitles/:type/:id/:extra.json  或  /subtitles/:type/:id.json
  const parts = pathname.split('/').filter(Boolean); // ['subtitles', type, id, extra?]
  const mediaType = parts[1] === 'series' || parts[1] === 'tv' ? 'series' : 'movie';
  const id = decodeURIComponent(getText(parts[2]).replace(/\.json$/i, ''));
  const extra = parseExtra(getText(parts[3]).replace(/\.json$/i, ''));
  const file = extra.filename || '';

  // 没有文件名时先取片名；有文件名但一个都没搜到时，再补一次片名兜底
  let metaTitle = file ? '' : await fetchMetaTitle(mediaType, id);
  let ctx = buildContext({ mediaType, id, extra, metaTitle });

  console.log(
    `[req] ${mediaType} id=${id} file=${file || '-'} title="${ctx.title}" code=${ctx.code || '-'} ` +
      `season=${ctx.season} episode=${ctx.episode}`
  );
  console.log(`[key] ${ctx.searchKeys.join(' | ') || '(空)'}`);

  let { subtitles, hitKey } = ctx.searchKeys.length
    ? await searchSubtitles(ctx)
    : { subtitles: [], hitKey: '' };

  if (subtitles.length === 0 && file && USE_CINEMETA) {
    metaTitle = await fetchMetaTitle(mediaType, id);
    if (metaTitle) {
      ctx = buildContext({ mediaType, id, extra, metaTitle });
      console.log(`[retry] 片名兜底 title="${ctx.title}" keys=[${ctx.searchKeys.join(' | ')}]`);
      ({ subtitles, hitKey } = await searchSubtitles(ctx));
    }
  }

  const result = subtitles.map(item => {
    const tag = ctx.code ? '【简中】' : getLangTag(item.langs + ',' + item.name);
    const cleanName = item.name.replace(/\.(srt|ass|ssa|vtt|zip|rar|7z)$/i, '');
    const meta = [];
    if (item.duration > 0) meta.push(`时长${formatDuration(item.duration)}`);
    return {
      id: item.id || item.url,
      url: origin + enqueueSubPath(item.url, item.ext),
      lang: langCode(tag),
      label: `${tag}${cleanName}${item.ext}${meta.length ? ' · ' + meta.join(' | ') : ''}`,
    };
  });

  console.log(`[res] hit="${hitKey}" → ${result.length} 条`);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ subtitles: result }));
}

const server = http.createServer(async (req, res) => {
  const origin = `http://${req.headers.host || `127.0.0.1:${PORT}`}`;
  const pathname = decodeURI((req.url || '/').split('?')[0]);
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      return res.end();
    }
    if (pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify(MANIFEST));
    }
    if (pathname.startsWith('/sub/')) return await handleSubProxy(req, res, pathname);
    if (pathname.startsWith('/subtitles/')) return await handleSubtitles(req, res, pathname, origin);
    if (pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<meta charset="utf-8"><p>迅雷看看 字幕 · Stremio 插件</p><p>安装地址：<a href="${origin}/manifest.json">${origin}/manifest.json</a></p>`);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    console.error('[fatal]', err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('internal error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`迅雷看看 字幕 · Stremio 插件已启动`);
  console.log(`  本机安装地址:  http://127.0.0.1:${PORT}/manifest.json`);
  console.log(`  局域网地址:    用本机内网 IP 替换 127.0.0.1（手机/电视要用这个）`);
});
