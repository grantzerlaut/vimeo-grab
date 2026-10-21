// User preferences, stored in chrome.storage.local and synced nowhere.
import {DEFAULT_TEMPLATE} from './filename.mjs';

export const QUALITIES = [
  ['best', 'Best available'],
  ['2160', 'Up to 4K'],
  ['1440', 'Up to 1440p'],
  ['1080', 'Up to 1080p'],
  ['720', 'Up to 720p'],
  ['480', 'Up to 480p'],
  ['smallest', 'Smallest file'],
  ['audio', 'Audio only (M4A)'],
];

export const DEFAULTS = Object.freeze({
  quality: 'best',
  folder: 'Vimeo',
  template: DEFAULT_TEMPLATE,
  saveAs: false,
  subtitles: 'none', // 'none' | 'default' | 'all'
  subtitleFormat: 'vtt', // 'vtt' | 'srt'
  concurrency: 2,
  metadata: true,
});

/** Coerce stored values back into range; storage can hold anything. */
export function normalise(raw = {}) {
  const value = {...DEFAULTS, ...raw};
  const pick = (key, allowed) => (allowed.includes(value[key]) ? value[key] : DEFAULTS[key]);
  return {
    quality: pick('quality', QUALITIES.map(([key]) => key)),
    folder: typeof value.folder === 'string' ? value.folder.slice(0, 200) : DEFAULTS.folder,
    template: typeof value.template === 'string' && value.template.trim() ? value.template.slice(0, 200) : DEFAULTS.template,
    saveAs: value.saveAs === true,
    subtitles: pick('subtitles', ['none', 'default', 'all']),
    subtitleFormat: pick('subtitleFormat', ['vtt', 'srt']),
    concurrency: Math.min(3, Math.max(1, Math.round(Number(value.concurrency)) || DEFAULTS.concurrency)),
    metadata: value.metadata !== false,
  };
}

export async function loadSettings() {
  return normalise(await chrome.storage.local.get(Object.keys(DEFAULTS)));
}
