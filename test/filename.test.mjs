import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeName, safeFolder, renderTemplate, buildFilename, siblingFilename, DEFAULT_TEMPLATE} from '../extension/lib/filename.mjs';

// The characters Chrome's IsFilenameLegal() rejects anywhere in a name.
const ILLEGAL = /["*/:<>?\\|~\p{Cc}\p{Cf}]/u;

test('safeName removes everything Chrome would reject', () => {
  const nasty = 'Intro ~ "Part 1": a/b\\c <draft>? | *final*\u200B\u202E\u0007\uFEFF';
  const name = safeName(nasty);
  assert.doesNotMatch(name, ILLEGAL);
  assert.equal(name, 'Intro Part 1 a b c draft final');
});

test('safeName trims dots and spaces and never returns empty', () => {
  assert.equal(safeName('  ...hidden. . '), 'hidden');
  assert.equal(safeName('...'), 'Vimeo video');
  assert.equal(safeName(''), 'Vimeo video');
  assert.equal(safeName(null, 'Fallback'), 'Fallback');
});

test('safeName guards reserved Windows device names', () => {
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('com1.txt'), '_com1.txt');
  assert.equal(safeName('Console'), 'Console');
});

test('safeName truncates by code point without splitting emoji', () => {
  const name = safeName('🎬'.repeat(200));
  assert.equal(Array.from(name).length, 120);
  assert.ok(name.isWellFormed());
});

test('safeFolder sanitises each component and blocks traversal', () => {
  assert.equal(safeFolder('Vimeo'), 'Vimeo');
  assert.equal(safeFolder('Vimeo/Courses//Week 1 '), 'Vimeo/Courses/Week 1');
  assert.equal(safeFolder('../../etc/passwd'), 'etc/passwd');
  assert.equal(safeFolder('C:\\Windows'), 'C/Windows');
  assert.equal(safeFolder(''), '');
  assert.equal(safeFolder('  / . /'), '');
});

test('renderTemplate fills tokens and tidies empty ones', () => {
  const values = {title: 'Film', id: '42', quality: '1080p', owner: '', date: '2026-01-02', site: 'example.com'};
  assert.equal(renderTemplate(DEFAULT_TEMPLATE, values), 'Film [42] 1080p');
  assert.equal(renderTemplate('{owner} - {title} ({quality})', values), 'Film (1080p)');
  assert.equal(renderTemplate('{title} - {owner} - {quality}', values), 'Film - 1080p');
  assert.equal(renderTemplate('{date} {title} {unknown}', values), '2026-01-02 Film {unknown}');
  assert.equal(renderTemplate('', values), 'Film [42] 1080p');
});

test('renderTemplate cannot be tricked into new tokens by values', () => {
  assert.equal(renderTemplate('{title}', {title: '{id}', id: 'x'}), 'id');
});

test('buildFilename produces a full safe path', () => {
  const values = {title: 'What? A ~ video', id: '42', quality: '720p'};
  assert.equal(buildFilename({template: DEFAULT_TEMPLATE, folder: 'Vimeo', values}), 'Vimeo/What A video [42] 720p.mp4');
  assert.equal(buildFilename({template: '{title}', folder: '', extension: 'm4a', values}), 'What A video.m4a');
  assert.equal(buildFilename({template: '{owner}', folder: 'x', values: {id: '7'}}), 'x/Vimeo 7.mp4');
});

test('invisible fillers are stripped and lookalike extensions defused', () => {
  const filler = String.fromCharCode(0x3164); // Hangul filler: renders as blank space.
  assert.equal(safeName(filler.repeat(3)), 'Vimeo video');
  assert.equal(buildFilename({template: '{title}', folder: '', values: {title: 'invoice.pdf.exe', id: '1'}}),
    'invoice.pdf exe.mp4');
  assert.equal(buildFilename({template: '{title}', folder: '', values: {title: 'Release v1.2', id: '1'}}),
    'Release v1.2.mp4');
  // Tricks that only show up after cleaning: trailing dot, invisible character, tilde.
  const zeroWidth = String.fromCharCode(0x200b);
  for (const title of ['invoice.pdf.exe.', `invoice.pdf.exe${zeroWidth}`, 'invoice.pdf.exe~']) {
    assert.equal(buildFilename({template: '{title}', folder: '', values: {title, id: '1'}}), 'invoice.pdf exe.mp4', title);
  }
});

test('long titles are shortened so the ID and quality stay in the name', () => {
  const title = `${'x'.repeat(100)} scan.exe`;
  const name = buildFilename({template: DEFAULT_TEMPLATE, folder: '', values: {title, id: '42', quality: '720p'}});
  assert.match(name, /\[42\] 720p\.mp4$/);
  assert.ok(!/\.exe\./.test(name));
});

test('siblingFilename swaps the extension', () => {
  assert.equal(siblingFilename('Vimeo/Film [1] 720p.mp4', '.en.vtt'), 'Vimeo/Film [1] 720p.en.vtt');
  assert.equal(siblingFilename('v1.0 film.mp4', '.srt'), 'v1.0 film.srt');
});
