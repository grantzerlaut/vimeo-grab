// File and folder names that Chrome's downloads API will accept on every OS.
//
// Chrome rejects a whole download ("Invalid filename") if any path component
// contains "*/:<>?\|~, control or format characters (Unicode Cc/Cf),
// starts or ends with a dot or whitespace, or is a reserved Windows device name.

export const DEFAULT_TEMPLATE = '{title} [{id}] {quality}';
export const TEMPLATE_TOKENS = ['title', 'id', 'quality', 'owner', 'date', 'site'];
const MAX_NAME = 120;
const MAX_TITLE = 90;
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// A title ending like "invoice.pdf.exe" would look like that file type when
// Windows hides the real .mp4 extension, so its dot is dropped.
const LOOKALIKE = /\.(exe|scr|bat|cmd|com|pif|msi|lnk|js|jse|vbs|vbe|wsf|ps1|hta|html?|jar|apk|app|dmg|pdf|docx?|xlsx?|pptx?|zip|rar|7z|iso)$/i;

/** Make one path component safe. Never returns an empty string. */
export function safeName(value, fallback = 'Vimeo video') {
  let name = String(value ?? '').normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}\uFFFD]/gu, '')
    .replace(/["*/:<>?\\|~]/g, ' ')
    .replace(/\s+/g, ' ');
  name = trimEnds(truncate(trimEnds(name), MAX_NAME));
  if (!name) name = fallback;
  if (RESERVED.test(name)) name = `_${name}`;
  return name;
}

/**
 * safeName for the final file name, checked after cleaning and truncation so a
 * name can't end in a misleading extension like ".exe" once ".mp4" is hidden.
 */
function safeBaseName(value, fallback) {
  const name = safeName(value, fallback);
  return LOOKALIKE.test(name) ? safeName(name.replace(LOOKALIKE, ' $1'), fallback) : name;
}

const trimEnds = value => value.replace(/^[\s.]+|[\s.]+$/gu, '');
// Cut by code point so a surrogate pair (emoji) is never split in half.
const truncate = (value, max) => Array.from(value).slice(0, max).join('');

/** Sanitise a user-chosen subfolder like "Vimeo/Courses". Empty means Downloads itself. */
export function safeFolder(value) {
  return String(value ?? '').split(/[/\\]+/)
    .map(part => trimEnds(part.trim()))
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => safeName(part, 'Vimeo'))
    .slice(0, 5)
    .join('/');
}

/**
 * Fill a filename template. Unknown tokens are left as text; empty tokens
 * collapse along with their surrounding brackets and separators.
 */
export function renderTemplate(template, values) {
  const source = String(template || '').trim() || DEFAULT_TEMPLATE;
  const text = source.replace(/\{(\w+)\}/g, (whole, key) =>
    TEMPLATE_TOKENS.includes(key) ? String(values[key] ?? '').replace(/[{}]/g, '') : whole);
  return text.replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/(?:\s*([-–—|·,])\s*){2,}/g, ' $1 ')
    .replace(/^[\s\-–—|·,]+|[\s\-–—|·,]+$/g, '');
}

/** Full relative download path for a video, e.g. "Vimeo/My film [123] 1080p.mp4". */
export function buildFilename({template, folder, extension = 'mp4', values}) {
  const fallback = values.id ? `Vimeo ${values.id}` : 'Vimeo video';
  // Shorten long titles first so the rest of the template (ID, quality) survives.
  const short = {...values, title: truncate(String(values.title ?? ''), MAX_TITLE)};
  const name = safeBaseName(renderTemplate(template, short), fallback);
  const dir = safeFolder(folder);
  return `${dir ? dir + '/' : ''}${name}.${extension}`;
}

/** Same name with a different suffix, e.g. "film.en.vtt" next to "film.mp4". */
export function siblingFilename(path, suffix) {
  return path.replace(/\.[^./]+$/, '') + suffix;
}

export function isoDate(date = new Date()) {
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
