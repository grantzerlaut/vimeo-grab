// WebVTT → SubRip, for editors and players that only take .srt.

const TIMING = /^\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lrm: String.fromCharCode(0x200e), rlm: String.fromCharCode(0x200f)};

function srtTime(value) {
  const [clock, fraction = '0'] = value.replace(',', '.').split('.');
  const parts = clock.split(':').map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [hours, minutes, seconds] = parts;
  const pad = (number, size = 2) => String(number).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${fraction.padEnd(3, '0').slice(0, 3)}`;
}

function cueText(lines) {
  return lines.join('\n')
    // Keep italic/bold/underline (dropping WebVTT classes), remove every other tag.
    .replace(/<([ibu])(?:[.\s][^>]*)?>/g, '<$1>')
    .replace(/<[^>]*>/g, tag => (/^<\/?[ibu]>$/.test(tag) ? tag : ''))
    // One pass, so "&amp;lt;" stays the text "&lt;" rather than becoming a tag.
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
      if (name[0] === '#') {
        const code = /^#x/i.test(name) ? parseInt(name.slice(2), 16) : Number(name.slice(1));
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return ENTITIES[name.toLowerCase()] ?? entity;
    })
    .trim();
}

/** Convert WebVTT text to SRT. Cue settings, styling and comments are dropped. */
export function vttToSrt(vtt) {
  // \s also covers a leading byte-order mark.
  const lines = String(vtt).replace(/^\s+/, '').split(/\r\n?|\n/);
  const cues = [];
  let current = null;
  // Lines after a whitespace-only line: cue text if the cue goes on, or a cue
  // id if a timing line comes next.
  let pending = null;
  const flush = () => {
    if (current && pending) current.lines.push(...pending);
    pending = null;
    if (!current) return;
    const text = cueText(current.lines);
    if (text) cues.push(`${cues.length + 1}\n${srtTime(current.start)} --> ${srtTime(current.end)}\n${text}`);
    current = null;
  };
  for (const line of lines) {
    const timing = line.match(TIMING);
    if (timing) {
      // Like browsers, any "-->" line starts a new cue, even without a blank line first.
      pending = null;
      flush();
      current = {start: timing[1], end: timing[2], lines: []};
    } else if (line === '') flush(); // Only a truly empty line ends a cue.
    else if (!current) continue; // Header, cue ids, NOTE, STYLE and REGION blocks.
    else if (!line.trim()) pending ||= [];
    else (pending || current.lines).push(line);
  }
  flush();
  return cues.join('\n\n') + '\n';
}
