# Changelog

All notable changes to the FB2 Reader plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Footnotes at the foot of the page.** In paged mode the text of each note
  is printed at the bottom of the very page its marker appears on, ruled off
  from the text above it, one pixel smaller than the book text and in the same
  muted colour as the book's annotation. The collected notes section at the
  end of the book is hidden in paged mode, since every note is now shown in
  place; scroll mode, which has no pages, keeps it as before.

### Changed

- **Reading positions are now strictly device-local.** They moved out of the
  plugin's `data.json` into this vault's local storage, so no synchronisation
  method — Obsidian Sync, iCloud, Syncthing, Git — can carry them to another
  device, and a synced `data.json` can no longer overwrite your whole
  position table at once. Existing positions are migrated automatically on
  first launch. Note that positions are no longer part of a vault backup and
  are lost if Obsidian is reinstalled. Plugin settings are unaffected and
  stay in `data.json`.
- The minimum required Obsidian version is now **1.8.7**.

### Removed

- **Swipe paging.** Touchscreen swipes and two-finger trackpad swipes no
  longer turn pages, on any device or platform. Pages are turned with the
  arrow keys / Page Up / Page Down or by clicking or tapping the left or
  right half of the page.

### Fixed

- **Page-foot note layout.** Reserving room for a note now breaks a long
  paragraph at the exact line where the text must stop instead of pushing
  the whole paragraph to the next page; the break never strands a lone
  character above the rule, never splits a hyphenated word, and paragraphs
  flowing in from the previous page are broken too (before, a note could
  cover their text). Pages after a note no longer start with a band of
  blank lines. Chapter headings are never broken mid-line — they move to
  the next page whole.
- **Phantom footnotes.** Markers inside the text of other notes no longer
  produce spurious note blocks on unrelated pages.
- **Popout windows.** Font, size, line height, theme and text color now
  apply to readers in popout windows, not only in the main one.
- **Returning to the beginning is remembered.** Going back to the first
  page (or scrolling to the top) and closing the book now reopens it at the
  beginning instead of the previous position.
- **UTF-16 files without a BOM** are now decoded correctly instead of
  turning into mojibake.
- **Table of contents text** no longer includes the bare digits of footnote
  markers that a chapter heading carries.

## [0.2.0] - 2026-07-21

### Added

- **Paged reading mode.** Read one page at a time instead of an endless
  scroll. Turn pages by tapping the left or right half of the page, with the
  arrow keys / Space / Page Up / Page Down, by swiping on a touchscreen, or
  with a two-finger swipe on a trackpad. A "Page X of Y" indicator shows your
  progress. Choose between **Scroll** and **Paged** under the plugin settings.
- **Solarized Dark theme** for the reading area, with a matching "Solarized"
  text colour.
- **Font suggestions on iPhone and iPad.** iOS and iPadOS don't let apps list
  the installed fonts, so the Font setting now offers the standard system
  fonts and lets you type the name of any font installed on your device.

### Changed

- The **dark theme** now uses a pure black background, and the **light theme**
  a pure white background.
- The default **line spacing** is now 1.5 and the default **font size** is 16.
- The **text colour** list was simplified to Black, Dark gray, Light gray,
  White, Sepia brown and Solarized.
- **Footnote markers** are now shown as a small superscript number next to the
  preceding word instead of a clickable "note N" link.
- The **table-of-contents panel** now uses a book icon.

### Fixed

- You can now **select and copy** text while reading.

### Removed

- The **Drop caps** option (large decorative first letter) has been removed.
