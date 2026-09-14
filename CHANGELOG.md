# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Version numbers follow [SemVer](https://semver.org/).

## [1.0.4] — 2026-09-14

### Changed

- App and installer names are English: `MTS Converter.app`, `MTS-Converter-Setup-*.exe`, `MTS-Converter-*-arm64.dmg`

[1.0.4]: https://github.com/nstzholud/mts-converter/releases/tag/v1.0.4

## [1.0.3] — 2026-09-14

### Added

- GitHub Actions now builds the macOS DMG (Apple Silicon) and attaches it to the same release as the Windows installer

[1.0.3]: https://github.com/nstzholud/mts-converter/releases/tag/v1.0.3

## [1.0.2] — 2026-09-14

### Fixed

- Windows CI: do not let electron-builder publish on a git tag (that needs `GH_TOKEN`). The workflow already attaches the exe to the GitHub Release.

[1.0.2]: https://github.com/nstzholud/mts-converter/releases/tag/v1.0.2

## [1.0.1] — 2026-09-14

### Fixed

- Windows CI installer: run electron-builder through Node so the Unix `.bin` shim is not spawned on the runner

[1.0.1]: https://github.com/nstzholud/mts-converter/releases/tag/v1.0.1

## [1.0.0] — 2026-09-14

First public release.

### Added

- Batch convert MTS / M2TS / TS to MP4 with a pink pixel-art UI
- English and Russian interface (title-bar switch, Russian by default)
- Lossless remux when the codecs already fit in MP4
- Re-encode path that removes interlace combing and normalizes anamorphic pixels
- Audio as original, AAC, or both tracks
- Mandatory output folder, overwrite-or-keep dialog on a repeat run
- One-click Windows installer and a macOS DMG
- Bundled FFmpeg, no command line required

[1.0.0]: https://github.com/nstzholud/mts-converter/releases/tag/v1.0.0
