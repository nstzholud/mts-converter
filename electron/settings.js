'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = {
  onboarded: false,
  outputDir: null,
  mode: 'copy', // 'copy' | 'deinterlace'
  audio: 'copy', // 'copy' | 'aac' | 'both'
  crf: 16,
  deinterlace: true,
  normalizePixels: true,
  locale: 'ru',
  windowBounds: null,
};

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.values = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (parsed[key] !== undefined) this.values[key] = parsed[key];
      }
    } catch {
      // First run or corrupted file: defaults are already in place.
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save settings:', err.message);
    }
  }

  get all() {
    return { ...this.values };
  }

  patch(partial) {
    for (const [key, value] of Object.entries(partial || {})) {
      if (key in DEFAULTS) this.values[key] = value;
    }
    this.save();
    return this.all;
  }
}

module.exports = { Settings, DEFAULTS };
