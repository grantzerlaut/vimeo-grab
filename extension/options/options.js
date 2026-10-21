import {DEFAULTS, QUALITIES, normalise, loadSettings} from '../lib/settings.mjs';
import {buildFilename, isoDate} from '../lib/filename.mjs';

const $ = selector => document.querySelector(selector);
const form = $('#settings');

for (const [value, label] of QUALITIES) $('#quality').append(new Option(label, value));
$('#version').textContent = `v${chrome.runtime.getManifest().version}`;

function read() {
  return normalise({
    quality: form.quality.value,
    folder: form.folder.value,
    template: form.template.value,
    saveAs: form.saveAs.checked,
    metadata: form.metadata.checked,
    concurrency: Number(form.concurrency.value),
    subtitles: form.subtitles.value,
    subtitleFormat: form.subtitleFormat.value,
  });
}

function fill(settings) {
  for (const key of ['quality', 'folder', 'template', 'subtitles', 'subtitleFormat']) form[key].value = settings[key];
  form.concurrency.value = String(settings.concurrency);
  form.saveAs.checked = settings.saveAs;
  form.metadata.checked = settings.metadata;
  preview();
}

function preview() {
  const settings = read();
  $('#preview').textContent = buildFilename({
    template: settings.template, folder: settings.folder,
    values: {title: 'Our product tour', id: '76979871', quality: '1080p', owner: 'Studio Name', date: isoDate(), site: 'example.com'},
  });
  form.subtitleFormat.disabled = settings.subtitles === 'none';
}

let savedTimer;
async function save() {
  preview();
  await chrome.storage.local.set(read());
  clearTimeout(savedTimer);
  $('#saved').textContent = 'Saved.';
  savedTimer = setTimeout(() => { $('#saved').textContent = ''; }, 1500);
}

form.addEventListener('input', save);
form.addEventListener('change', save);
form.addEventListener('submit', event => event.preventDefault());

for (const button of document.querySelectorAll('.token')) {
  button.addEventListener('click', () => {
    const input = form.template;
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    input.setRangeText(button.textContent, start, end, 'end');
    input.focus();
    void save();
  });
}

$('#reset').addEventListener('click', async () => {
  fill(normalise(DEFAULTS));
  await save();
});

$('#shortcuts').addEventListener('click', () => chrome.tabs.create({url: 'chrome://extensions/shortcuts'}));

chrome.commands.getAll(commands => {
  const action = commands.find(command => command.name === '_execute_action');
  const text = action?.shortcut || 'not set';
  $('#shortcut').textContent = text;
  $('#shortcut-2').textContent = text;
});

loadSettings().then(fill);
