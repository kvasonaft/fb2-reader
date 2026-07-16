# FB2 Reader

An [Obsidian](https://obsidian.md) plugin for reading FictionBook (`.fb2`) files directly in your vault. Works on desktop and mobile.

## Features

- **Reader view.** Open a `.fb2` file and it renders as a formatted book: cover, title page, authors, annotation, chapters, poems, quotes, footnotes, images, and tables.
- **Table of contents.** A side panel lists the chapters of the active book; click a chapter to scroll to it.
- **Reading position.** The plugin remembers where you stopped in each book (up to 300 books) and takes you back there when you reopen it.
- **Appearance settings.** Theme (light / dark / sepia or follow Obsidian), font family, font size, line height, text color, and optional drop caps.
- **Encoding detection.** Older FB2 books in windows-1251 and other legacy encodings are decoded automatically.

## Usage

Put a `.fb2` file anywhere in your vault and click it — it opens in the reader. Use the **Open table of contents** command (or switch to a reader tab) to show the chapter panel.

Note: zipped books (`.fb2.zip`) are not supported — unpack them to plain `.fb2` first. Obsidian identifies files by their final extension only, so claiming `.zip` would hijack every archive in the vault.

## Installation

### From community plugins

Search for **FB2 Reader** in Settings → Community plugins (once the plugin is accepted into the catalog).

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](../../releases/latest).
2. Copy them into `<your vault>/.obsidian/plugins/fiction-book-reader/`.
3. Reload Obsidian and enable **FB2 Reader** in Settings → Community plugins.

## Development

```bash
npm install
npm run dev    # watch mode, rebuilds main.js on change
npm run build  # typecheck + production build
```

The entire plugin lives in `src/main.ts`; esbuild bundles it into `main.js`.

## License

[MIT](LICENSE)
