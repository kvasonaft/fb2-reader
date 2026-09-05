# Changelog

All notable changes to the FB2 Reader plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.3] - 2026-09-06

### Fixed

- **The reading position is kept again.** Since 0.3.1 opening a book could
  put it back on the first page and save that as the new position. The
  paged layout is laid out once the reader's size stops changing, and the
  page to return to was remembered when the change began — while the book
  was still opening, that was the front of the book, and the layout then
  settled on it a moment after the saved position had been restored. On a
  small or medium book that raced the same way on every open; on a tablet a
  rotation passed through a size of zero, which measured every block as being
  on the first page and overwrote the position with it. The position is now
  the block the reader is on, set from the saved position before anything is
  laid out; every layout puts the reader on whatever page that block lands
  on, and the block itself is only read off the page when the reader turns
  one or follows a link — never after a reflow, and never in a viewport with
  no area.
- **The page drifted backwards through the book.** Reading the position off
  the page again after every layout step walked it back a block or so at a
  time as the page-foot notes were filled in, so a book reopened a page or
  two before where it was closed, and a rotation and back did not return to
  the same page. A page in the middle of one long paragraph is now remembered
  as that paragraph plus the pages into it, instead of falling back to the
  page before.
- **Positions are written out at once**, not two seconds after the last page
  turn: on a phone or tablet the app can be suspended and dropped at any
  moment, and a deferred write could leave a whole session unsaved.

## [0.3.2] - 2026-09-05

### Fixed

- **Rotating a tablet no longer blanks the screen.** 0.3.1 covered the reader
  for the whole layout, and on a long book with many footnotes that is seconds
  of work, so the cover turned a second of flicker into ten seconds of nothing.
  The cover now lasts only the one quick step that puts the reader back on
  their page. The footnotes are then filled in behind them, page by page, with
  the reader held on the paragraph they were reading, so the text no longer
  slides away while the rest of the book is laid out.
- **The page landed on after a rotation.** The new pagination was measured
  while the old page-foot notes were still in place, cut for the old page
  height, so the reader was put on a page that only ever existed halfway
  through the change. The notes are cleared before anything is measured.

## [0.3.1] - 2026-09-04

### Fixed

- **Rotating a tablet no longer flickers its way to the new page.** The book
  was laid out while the size was still changing, and then again, page by page
  across dozens of frames, as the page-foot footnotes took their room back —
  all of it in full view, so the text jumped around for a second before
  settling in the right place. The layout now happens once, after the size
  stops changing, under a cover that lifts on the finished page. Changing the
  font or the line spacing is handled the same way.
- **Rotating while a book is still opening** no longer loses the saved reading
  position and leaves you at the front of the book.

## [0.3.0] - 2026-09-04

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
- **The table-of-contents panel no longer reopens itself.** It is added to
  the right sidebar once, the first time a book is opened; after that, a
  panel you close stays closed. Bring it back with the ribbon button or the
  "Open table of contents" command.
- **Reading positions follow a renamed book.** Renaming or moving a file, or
  the folder it sits in, used to send it back to page one.
- **Table-of-contents entries are reachable from the keyboard.** They take
  focus and open with Enter or Space, and screen readers announce them as
  buttons.

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
- **Closing a book while it loads.** Closing the tab before a large file had
  finished loading left the book's images in memory for the rest of the
  session and drew it into the closed tab. The load is now abandoned.
- **Links into the notes section in paged mode.** A cross-reference pointing
  at a footnote jumped to an arbitrary page, because paged mode hides the
  notes section at the end of the book. It now goes to the page carrying
  that note's marker, where the note is printed.
- **Turning pages deep into a book** no longer gets slower the further you
  read, and resizing the window is smoother for the same reason.
- **Rotating a tablet, or resizing the window, no longer jumps several pages.**
  In paged mode the reflow used to hold on to the first block *visible* on the
  page. A page normally opens in the middle of a paragraph carried over from
  the page before, and that paragraph belongs to the previous page, so every
  reflow stepped one page back — and an orientation change reflows several
  times over. The reflow now holds on to the block the page opens with, and
  holds the same one for the whole rotation. Sizes reported mid-rotation,
  including the empty ones iPadOS goes through, are ignored rather than
  collapsing the page count and throwing the reader to the front of the book.
- **Reopening a book in paged mode** lands on the page you left, instead of
  the one before it, for the same reason.

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
