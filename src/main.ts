/*
 * The entire plugin lives in this single file.
 *
 * File map (in order):
 *   1. Imports.
 *   2. Types and default settings.
 *   3. Lookup tables mapping FB2 tags to HTML elements.
 *   4. Helper functions: encoding detection and the like.
 *   5. Fb2View — the reader itself, renders an FB2 file as a page.
 *   6. Fb2TocView — the table-of-contents side panel.
 *   7. Fb2ReaderPlugin — the conductor: registers the views, stores the
 *      settings (data.json) and the reading positions (localStorage).
 *   8. Fb2SettingTab — the plugin settings tab.
 */

import {
	App,
	base64ToArrayBuffer,
	debounce,
	FileView,
	ItemView,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import type { SettingDefinitionItem } from "obsidian";

// Internal identifiers of our two view types.
const VIEW_TYPE_FB2 = "fb2-reader-view";
const VIEW_TYPE_TOC = "fb2-reader-toc";
// XML namespace for xlink:href attributes (links inside FB2).
const XLINK_NS = "http://www.w3.org/1999/xlink";

// ---------------------------------------------------------------------------
// Types and defaults
// ---------------------------------------------------------------------------

// One entry in the book's table of contents.
interface TocItem {
	text: string; // chapter heading text
	depth: number; // nesting depth (chapter, sub-chapter, ...)
	el: HTMLElement; // the heading element on the page, so we can scroll to it
}

// One deferred rendering unit: an FB2 block waiting to be turned into HTML.
// Large books are rendered through a queue of these in per-frame slices,
// so opening a book never freezes the UI.
interface RenderJob {
	el: Element; // the FB2 block to render
	parent: HTMLElement; // where its HTML goes
	depth: number; // section nesting depth (drives heading levels)
	toc: boolean; // whether headings inside contribute TOC entries
}

// Saved reading position for one book.
interface ReadingPosition {
	index: number; // index of the block to resume reading from
	ts: number; // when it was saved (used to evict the oldest entries)
}

// Reader color theme; the empty string means "same as Obsidian".
type Fb2Theme = "" | "light" | "dark" | "sepia" | "solarized-dark";

// Reading layout: the continuous scroll ("infinite page") or page-by-page.
type ReadingMode = "scroll" | "paged";

// All user-facing plugin settings.
interface Fb2Settings {
	fontFamily: string; // font ("" = same as Obsidian)
	fontSize: number; // font size in pixels
	lineHeight: number; // line spacing multiplier
	theme: Fb2Theme; // reader color theme
	textColor: string; // text color ("" = follow the theme)
	readingMode: ReadingMode; // scroll (infinite page) or paged
}

// Everything the plugin persists to disk (Obsidian stores it in data.json).
// Reading positions are deliberately NOT here — see POSITIONS_KEY.
interface Fb2Data {
	settings: Fb2Settings;
	// Whether the TOC panel has ever been added to the sidebar. It is put there
	// once, for the first book ever opened; after that a panel the user closed
	// stays closed, and the ribbon and the command bring it back.
	tocPanelCreated?: boolean;
}

// Reading positions are kept in the vault's localStorage rather than in
// data.json, which makes them strictly device-local: localStorage is WebView
// storage, not a file inside the vault, so no sync mechanism — Obsidian Sync,
// iCloud, Syncthing, Git — can carry it to another device. Keeping them out of
// data.json also means a synced data.json can no longer overwrite the whole
// position table at once. The trade-off is that positions are not part of a
// vault backup and are lost if Obsidian is reinstalled.
const POSITIONS_KEY = "fb2-reader-positions";

// Shape of data.json as written by older versions, which stored positions
// there. Read once on load so they can be migrated, then dropped.
interface LegacyFb2Data extends Partial<Fb2Data> {
	positions?: Record<string, ReadingPosition>;
}

// Defaults used on first run and by the "Reset to defaults" button.
const DEFAULT_SETTINGS: Fb2Settings = {
	fontFamily: "",
	fontSize: 16,
	lineHeight: 1.5,
	theme: "",
	textColor: "",
	readingMode: "scroll",
};

// Text color presets for the settings dropdown: "color code → label".
const TEXT_COLORS: Record<string, string> = {
	"": "Default (theme)",
	"#000000": "Black",
	"#555555": "Dark gray",
	"#9c9ca4": "Light gray",
	"#ffffff": "White",
	"#5b4636": "Sepia brown",
	"#839496": "Solarized",
};

// ---------------------------------------------------------------------------
// Lookup tables: FB2 tag → HTML element
//
// FB2 is XML with its own tags (<section>, <poem>, <emphasis>...), so every
// tag has to be translated to HTML. Most translations are trivial, so instead
// of a long chain of conditionals they are described by three tables.
// ---------------------------------------------------------------------------

// Block-level container tags: rendered as a wrapper with a CSS class,
// with their children processed as blocks.
// Only <section> increases the nesting depth (which drives heading levels).
const BLOCK_CONTAINERS: Record<string, { tag: "div" | "blockquote"; cls: string }> = {
	section: { tag: "div", cls: "fb2-section" }, // book chapter
	epigraph: { tag: "div", cls: "fb2-epigraph" },
	poem: { tag: "div", cls: "fb2-poem" },
	stanza: { tag: "div", cls: "fb2-stanza" },
	annotation: { tag: "div", cls: "fb2-annotation" },
	cite: { tag: "blockquote", cls: "fb2-cite" }, // quotation
};

// Block-level tags rendered as a <p> with the given CSS class;
// their content is inline (emphasis, links, etc.).
const BLOCK_PARAGRAPHS: Record<string, string> = {
	p: "fb2-p", // regular paragraph
	subtitle: "fb2-subtitle",
	v: "fb2-verse", // line of a poem
	"text-author": "fb2-text-author", // author byline under a quote/epigraph
};

// Inline tags with a direct HTML counterpart.
const INLINE_TAGS: Record<string, keyof HTMLElementTagNameMap> = {
	strong: "strong",
	emphasis: "em",
	strikethrough: "s",
	sub: "sub",
	sup: "sup",
	code: "code",
};

// ---------------------------------------------------------------------------
// Helpers: reading and decoding the file
// ---------------------------------------------------------------------------

// Reads the encoding="..." declaration from the XML prolog, if any.
// The first 512 bytes are decoded as latin1 (safe for arbitrary bytes).
function declaredEncoding(buf: ArrayBuffer): string | null {
	const head = new TextDecoder("latin1").decode(buf.slice(0, 512));
	const m = head.match(/encoding=["']([\w-]+)["']/i);
	return m ? m[1].toLowerCase() : null;
}

// Turns the bytes of an FB2 file into text. The encoding is decided
// in three steps:
//   1. A UTF-16 BOM is reliable — decode as UTF-16 right away.
//   2. A declared non-UTF-8 encoding (windows-1251, koi8-r...) is used as is;
//      TextDecoder supports the legacy single-byte encodings natively.
//   3. Otherwise decode as strict UTF-8 (fatal: true): encoding declarations
//      lie often, and strict mode turns silent mojibake into an exception —
//      the trigger to fall back to windows-1251, the de facto FB2 default.
// A leading BOM is stripped by TextDecoder itself (ignoreBOM defaults
// to false).
function decodeFb2(buf: ArrayBuffer): string {
	const bom = new Uint8Array(buf.slice(0, 2));
	if (bom[0] === 0xff && bom[1] === 0xfe) {
		return new TextDecoder("utf-16le").decode(buf);
	}
	if (bom[0] === 0xfe && bom[1] === 0xff) {
		return new TextDecoder("utf-16be").decode(buf);
	}
	// UTF-16 without a BOM: XML must start with "<" (0x3C), so the first
	// 16-bit unit betrays the byte order. Without this check such a file
	// would fall through every later step (the NUL bytes hide the encoding
	// declaration from the latin1 sniff and break strict UTF-8) and come out
	// as windows-1251 mojibake.
	if (bom[0] === 0x3c && bom[1] === 0x00) {
		return new TextDecoder("utf-16le").decode(buf);
	}
	if (bom[0] === 0x00 && bom[1] === 0x3c) {
		return new TextDecoder("utf-16be").decode(buf);
	}

	const declared = declaredEncoding(buf);
	if (declared && declared !== "utf-8") {
		try {
			return new TextDecoder(declared).decode(buf);
		} catch {
			// Unknown encoding label — fall through to the UTF-8 path.
		}
	}

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(buf);
	} catch {
		return new TextDecoder("windows-1251").decode(buf);
	}
}

// Cached font list: querying the system is slow, so the first successful
// result is remembered.
let cachedSystemFonts: string[] | null = null;

async function getSystemFonts(): Promise<string[]> {
	if (cachedSystemFonts) return cachedSystemFonts;
	// window.queryLocalFonts is a relatively new browser API that may be
	// missing (it is Chromium-only), so type it manually and feature-detect.
	const queryLocalFonts = (
		window as { queryLocalFonts?: () => Promise<{ family: string }[]> }
	).queryLocalFonts;
	if (!queryLocalFonts) return [];
	try {
		const fonts: { family: string }[] = await queryLocalFonts.call(window);
		// Each family is listed once per style (regular, bold, italic...);
		// keep unique names and sort them.
		const families = Array.from(new Set(fonts.map((f) => f.family))).sort(
			(a, b) => a.localeCompare(b)
		);
		if (families.length) cachedSystemFonts = families;
		return families;
	} catch {
		return []; // permission denied — do without the list
	}
}

// Standard reading fonts shipped with iOS and iPadOS. Unlike desktop
// Chromium, WebKit (the only engine on iOS/iPadOS) exposes no
// queryLocalFonts API, so the installed fonts can't be enumerated there.
// These names are offered as suggestions instead; any other installed font
// can still be typed by hand.
const IOS_SYSTEM_FONTS: string[] = [
	"American Typewriter",
	"Arial",
	"Avenir",
	"Avenir Next",
	"Baskerville",
	"Charter",
	"Cochin",
	"Courier New",
	"Didot",
	"Futura",
	"Georgia",
	"Gill Sans",
	"Helvetica Neue",
	"Hoefler Text",
	"Iowan Old Style",
	"Marker Felt",
	"Menlo",
	"Noteworthy",
	"Optima",
	"Palatino",
	"Seravek",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

// Shown on iOS/iPadOS in place of the font dropdown, explaining why the
// system font list is missing and how to proceed.
const IOS_FONT_DESC =
	"On iPhone and iPad the installed fonts can't be listed. Pick one of the " +
	"standard system fonts, or type the exact name of any font installed on " +
	"your device. Leave empty to use the Obsidian theme font.";

// Extracts the link target from an FB2 element. Real-world books spell the
// attribute in different ways (xlink:href, l:href, plain href), so try
// every variant in turn.
function getHref(el: Element): string | null {
	return (
		el.getAttributeNS(XLINK_NS, "href") ??
		el.getAttribute("l:href") ??
		el.getAttribute("xlink:href") ??
		el.getAttribute("href")
	);
}

// Copies the FB2 id attribute onto the created HTML element (as data-fb2-id)
// so the book's internal links (footnotes, cross-references) can find their
// target and scroll to it.
function copyId(from: Element, to: HTMLElement) {
	const id = from.getAttribute("id");
	if (id) to.setAttribute("data-fb2-id", id);
}

// ---------------------------------------------------------------------------
// Fb2View — the reader
//
// Obsidian creates an Fb2View instance when the user opens an .fb2 file and
// drives its lifecycle methods (onLoadFile and friends) itself.
// ---------------------------------------------------------------------------

class Fb2View extends FileView {
	// TOC entries of the current book; read by the Fb2TocView panel.
	tocItems: TocItem[] = [];

	private plugin: Fb2ReaderPlugin;
	private bookTitle = ""; // book title (used for the tab header)
	private binaries = new Map<string, string>(); // book images: id → data URL
	private collectToc = false; // whether TOC entries are being collected right now
	private renderQueue: RenderJob[] = []; // blocks still waiting to be rendered
	private renderPass = 0; // bumping this cancels an in-flight render
	// Bumped whenever the view starts loading a file or lets one go. Reading a
	// file is asynchronous, so a read belonging to a book the view has already
	// moved on from has to be dropped when it finally lands.
	private loadPass = 0;
	// Paged mode: the columns layer, current/total pages, the "X of Y" overlay
	// and a resize watcher.
	private bookEl: HTMLElement | null = null;
	private pageIndex = 0;
	private pageCount = 1;
	// The block the current page opens with, recorded every time the reader
	// settles on a page. Reflows are anchored on it; see pageAnchorIndex.
	private pageAnchor = 0;
	// The anchor held for the duration of a resize burst, or -1 between bursts,
	// plus the size the last recompute was made for.
	private resizeAnchor = -1;
	private lastWidth = -1;
	private lastHeight = -1;
	// While a book opens the reader sits at the start waiting for layout, and
	// saving would clobber the real position with 0. Once the saved position
	// has been applied, saving the start becomes legitimate — the reader may
	// have gone back to the beginning on purpose, and that should stick.
	private positionRestored = false;
	private counterEl: HTMLElement | null = null;
	private resizeObserver: ResizeObserver | null = null;
	// Footnotes: id → the <section> in <body name="notes"> holding its text,
	// plus a pass counter that cancels a footnote layout still in flight.
	private noteSources = new Map<string, Element>();
	private notesPass = 0;
	// Last block of the book proper (the notes body excluded), cached because
	// recomputePagination measures against it every time it runs.
	private lastContentBlock: HTMLElement | null = null;
	// Set while a book is opening and its saved position has not been applied
	// yet. A reflow starting in the middle cancels the opening footnote layout,
	// and would drop the restore with it; it is picked up here instead.
	private pendingRestore: (() => void) | null = null;
	// Lays the book out for its new size, once the size has stopped changing.
	private settleResizeDebounced = debounce(() => this.settleResize(), 150);
	// True while the reader is covered for a reflow; see beginReflow.
	private reflowing = false;
	// Scroll fires dozens of times per second; saving once, 800 ms after
	// scrolling settles, is enough.
	private savePositionDebounced = debounce(
		() => this.saveReadingPosition(),
		800,
		true
	);

	constructor(leaf: WorkspaceLeaf, plugin: Fb2ReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = true; // the tab takes part in back/forward history
	}

	// Called once when the view is created. Subscribe to scrolling to keep
	// the reading position up to date; registerDomEvent unsubscribes
	// automatically when the view closes.
	onload(): void {
		super.onload();
		this.registerDomEvent(this.contentEl, "scroll", () =>
			this.savePositionDebounced()
		);
		// Paged-mode input. Every handler is a no-op in scroll mode. The
		// content element is made focusable (tabindex -1) so it can receive
		// key events once the reader is clicked.
		this.contentEl.tabIndex = -1;
		this.registerDomEvent(this.contentEl, "keydown", (e) => this.onKeyDown(e));
		this.registerDomEvent(this.contentEl, "click", (e) => this.onViewClick(e));
		// Re-paginate when the reader area changes size (window resize, sidebar
		// toggle, popout, tablet rotation). Cheap no-op in scroll mode.
		this.resizeObserver = new ResizeObserver(() => {
			// observe() fires once on its own, before any book is open.
			if (!this.isPaged() || !this.bookEl) return;
			const w = this.contentEl.clientWidth;
			const h = this.contentEl.clientHeight;
			// Rotating a tablet takes the reader through sizes that mean nothing,
			// a zero among them, and lastWidth/lastHeight hold the size the book
			// was actually laid out for, so a size it already fits is ignored.
			if (w <= 0 || h <= 0) return;
			if (w === this.lastWidth && h === this.lastHeight) return;
			// Nothing is laid out here. A rotation fires this several times as the
			// window animates, and every layout was landing on screen: each event
			// reflowed the whole book, and the footnote pass then reflowed it again
			// page by page over dozens of frames, all of it in front of the reader.
			// Instead the page the reader was on is remembered, the reader is
			// covered, and it is all laid out once the size stops changing.
			if (this.resizeAnchor < 0) this.resizeAnchor = this.pageAnchor;
			this.beginReflow();
			this.settleResizeDebounced();
		});
		this.resizeObserver.observe(this.contentEl);
	}

	onunload(): void {
		// Backstops for a teardown that never reaches onUnloadFile: stop the work
		// still in flight, flush a pending position save while the file is still
		// known, and revoke the book's image URLs, which nothing else would free.
		this.loadPass++;
		this.renderPass++;
		this.notesPass++;
		this.settleResizeDebounced.cancel();
		this.endReflow();
		this.savePositionDebounced.run();
		this.clearBinaries();
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		super.onunload();
	}

	getViewType(): string {
		return VIEW_TYPE_FB2;
	}

	getDisplayText(): string {
		// Tab title: book title, else file name, else "FB2".
		return this.bookTitle || this.file?.basename || "FB2";
	}

	getIcon(): string {
		return "book-open"; // icon name from Obsidian's built-in set
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "fb2";
	}

	// The main entry point: Obsidian calls it when this view has to open
	// a file. The whole pipeline happens here: bytes → text → XML → HTML.
	async onLoadFile(file: TFile): Promise<void> {
		const pass = ++this.loadPass;
		const container = this.contentEl;
		container.empty();
		this.endReflow(); // a cover must not carry over into the next book
		container.addClass("fb2-reader"); // CSS class the styles target
		this.tocItems = [];

		// Step 1: read the file from the vault as bytes.
		const buf = await this.app.vault.readBinary(file);
		// The tab may have been closed, or sent to another book, while the file
		// was being read. Everything below builds object URLs and DOM for a book
		// nobody is looking at any more, and nothing would ever free them.
		if (pass !== this.loadPass) return;

		// Step 2: bytes → text (with encoding detection).
		const xml = decodeFb2(buf);
		// Step 3: text → XML tree.
		const doc = new DOMParser().parseFromString(xml, "application/xml");

		// On a parse error DOMParser does not throw; it inserts a special
		// <parsererror> tag into the document instead.
		if (doc.querySelector("parsererror")) {
			container.createEl("p", {
				text: "Failed to parse the file: invalid XML.",
				cls: "fb2-error",
			});
			return;
		}

		// Step 4: collect images, start rendering the book and notify the
		// plugin (so it opens the TOC panel). Rendering is sliced across
		// frames; the reading position is restored when the queue drains.
		this.collectBinaries(doc);
		this.pendingRestore = null;
		this.pageIndex = 0;
		this.pageCount = 1;
		this.pageAnchor = 0;
		this.resizeAnchor = -1;
		this.lastWidth = -1;
		this.lastHeight = -1;
		this.positionRestored = false;
		this.bookEl = container.createDiv({ cls: "fb2-book" });
		this.applyModeClass();
		this.renderBook(doc, this.bookEl);
		this.plugin.onFb2Opened(this);
	}

	// Called when the file is closed: save the position and clean up
	// so a large book is not kept in memory.
	async onUnloadFile(file: TFile): Promise<void> {
		this.loadPass++; // drop a file read that has not landed yet
		this.renderPass++; // cancel a render that may still be in flight
		this.notesPass++; // ...and a footnote layout, likewise
		this.settleResizeDebounced.cancel();
		this.endReflow();
		this.renderQueue = [];
		this.pendingRestore = null;
		this.noteSources.clear();
		this.saveReadingPosition(file);
		this.plugin.clearTocFor(this);
		this.clearBinaries();
		this.tocItems = [];
		this.bookTitle = "";
		this.contentEl.empty();
		this.bookEl = null;
		this.counterEl = null;
		this.lastContentBlock = null;
		this.pageIndex = 0;
		this.pageCount = 1;
		this.pageAnchor = 0;
		this.resizeAnchor = -1;
		this.lastWidth = -1;
		this.lastHeight = -1;
		this.positionRestored = false;
	}

	// --- Reading position ---

	// All text blocks of the book in document order. The reading position is
	// stored as an index into this list — more robust than a pixel offset,
	// which changes with font or window size.
	private getScrollBlocks(): HTMLElement[] {
		return Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(
				".fb2-p, .fb2-title, .fb2-subtitle, .fb2-verse, .fb2-image-block"
			)
		);
	}

	// Index of the first block currently in view — in scroll mode, the first
	// whose bottom edge is below the top of the viewport.
	private firstVisibleScrollIndex(): number {
		const top = this.contentEl.getBoundingClientRect().top;
		const index = this.getScrollBlocks().findIndex(
			(b) => b.getBoundingClientRect().bottom > top
		);
		return index >= 0 ? index : 0;
	}

	// Save the position as a block index. Both modes store it the same way, so
	// switching between scroll and paged keeps the reader's place.
	private saveReadingPosition(file = this.file) {
		if (!file) return;
		if (this.isPaged()) {
			this.savePagedPosition(file);
			return;
		}
		// scrollTop 0 before the restore is just the book still loading.
		if (this.contentEl.scrollTop <= 0 && !this.positionRestored) return;
		this.plugin.setPosition(file.path, this.firstVisibleScrollIndex());
	}

	// Restore the position: scroll to (or turn to the page of) the saved block.
	private restoreReadingPosition(path: string) {
		const pos = this.plugin.getPosition(path);
		// By the next animation frame the browser has laid out all elements.
		// contentEl.win is the window owning this view — the correct one
		// when the reader lives in a popout window.
		this.contentEl.win.requestAnimationFrame(() => {
			this.positionRestored = true; // saving the start is allowed from here
			const blocks = this.getScrollBlocks();
			if (this.isPaged()) {
				const idx = pos ? Math.min(pos.index, blocks.length - 1) : 0;
				const target = blocks[Math.max(0, idx)];
				// A position saved inside the notes body (only reachable in
				// scroll mode, where that body is visible) has no page of its
				// own: paged mode prints those notes under their own pages and
				// hides the body, so fall back to the end of the book.
				if (target?.closest(".fb2-notes")) {
					this.goToPage(this.pageCount - 1, false);
					return;
				}
				this.goToPage(target ? this.pageOfElement(target) : 0, false);
				return;
			}
			if (!pos || pos.index <= 0) return;
			const target = blocks[Math.min(pos.index, blocks.length - 1)];
			target?.scrollIntoView({ block: "start" });
		});
	}

	// --- Paged mode ---
	//
	// The .fb2-book layer is laid out into full-width CSS columns of viewport
	// height; each column is one page. Turning a page slides the layer left
	// by one page width via a transform. All of this is inert in scroll mode.

	isPaged(): boolean {
		return this.plugin.fb2Settings.readingMode === "paged";
	}

	// Width of one page step in CSS pixels — the full viewport width. (The
	// book layer itself is narrower, by the side margins, so pages are centered
	// and neighbors stay off-screen.)
	private pageWidth(): number {
		return this.bookEl ? this.contentEl.clientWidth : 0;
	}

	// Which page a given element sits on. The book layer and the element are
	// both shifted by the current transform, so their difference is the
	// element's untranslated offset from the book's left edge. Dividing and
	// flooring (rather than rounding) is what makes this work for inline
	// elements too: a block starts at the column's left edge, but a footnote
	// marker sits at an arbitrary offset inside the column, which rounding
	// would push onto the next page. The 1px bias absorbs sub-pixel drift on
	// blocks that sit a hair to the left of their column.
	private pageOfElement(el: HTMLElement): number {
		const w = this.pageWidth();
		if (!this.bookEl || w <= 0) return 0;
		const bookLeft = this.bookEl.getBoundingClientRect().left;
		const elLeft = el.getBoundingClientRect().left;
		return Math.max(0, Math.floor((elLeft - bookLeft + 1) / w));
	}

	// Covers the reader for the duration of a reflow. Rebuilding the columns and
	// giving the footnotes their room back moves the text dozens of times over,
	// across as many frames, and every one of those was landing on screen. The
	// cover is painted over the book rather than hiding it, because the layout
	// underneath is measured throughout and must not be disturbed.
	private beginReflow() {
		if (this.reflowing) return;
		this.reflowing = true;
		this.contentEl.addClass("fb2-reflowing");
	}

	private endReflow() {
		if (!this.reflowing) return;
		this.reflowing = false;
		this.contentEl.removeClass("fb2-reflowing");
	}

	// Lays the book out for the size it now has. Deferred from the resize
	// observer, so it runs once per burst however many events the burst had.
	private settleResize() {
		const anchor = this.resizeAnchor;
		this.resizeAnchor = -1;
		if (!this.isPaged() || !this.bookEl) {
			this.endReflow();
			return;
		}
		this.lastWidth = this.contentEl.clientWidth;
		this.lastHeight = this.contentEl.clientHeight;
		// Take the old spacers out before measuring anything. They were cut for
		// the old page height, and pagination measured against them lands the
		// reader on a page that only ever existed halfway through the change.
		this.notesPass++; // stop a layout still placing the old notes
		this.clearFootnotes();
		this.recomputePagination(anchor);
		// The reader has their page back here, and everything below is filled in
		// behind them. Laying the notes out again reflows the whole book once per
		// page that carries one, which on a long book is seconds of work; holding
		// a blank screen for that is far worse than the churn it was hiding.
		this.endReflow();
		this.layoutFootnotes();
	}

	// Toggle the paged/scroll CSS class and create or drop the page counter.
	private applyModeClass() {
		const paged = this.isPaged();
		this.contentEl.toggleClass("fb2-paged", paged);
		if (paged) {
			if (!this.counterEl) {
				this.counterEl = this.contentEl.createDiv({ cls: "fb2-page-counter" });
			}
		} else {
			this.counterEl?.remove();
			this.counterEl = null;
			// Scroll mode has no pages to sit at the foot of; the notes body at
			// the end of the book becomes visible again instead.
			this.notesPass++; // cancel a footnote layout still in flight
			this.settleResizeDebounced.cancel();
			this.endReflow();
			this.clearFootnotes();
			// Drop the inline paged styles so scroll mode lays out normally.
			this.bookEl?.setCssStyles({
				transform: "",
				transition: "",
				width: "",
				columnWidth: "",
				columnGap: "",
				columnFill: "",
			});
		}
	}

	// Measure the layout and update the page count. `anchor` is the index of a
	// block to keep the page pointing at across the reflow, or -1 to stay on the
	// page number the reader is already on.
	private recomputePagination(anchor: number) {
		const book = this.bookEl;
		if (!book || !this.isPaged()) return;
		const w = this.contentEl.clientWidth; // viewport width = one page step
		// Nothing can be measured in a viewport with no area, and a rotating
		// tablet reports one. This used to set pageCount to 1, which then clamped
		// the next page turn to the very start of the book; leaving the last good
		// figures alone until the size settles is what keeps the reader in place.
		if (w <= 0 || this.contentEl.clientHeight <= 0) return;
		// Build columns one page-text wide (viewport minus symmetric margins),
		// separated by a gap of twice the margin. The book layer is centered
		// (margin: 0 auto), so each page sits with equal side margins and the
		// neighboring columns fall entirely outside the clipped viewport.
		const fs =
			parseFloat(this.contentEl.win.getComputedStyle(book).fontSize) || 16;
		const margin = Math.round(fs * 1.5);
		const colW = Math.max(1, w - 2 * margin);
		book.setCssStyles({
			width: `${colW}px`,
			columnWidth: `${colW}px`,
			columnGap: `${2 * margin}px`,
			columnFill: "auto",
		});
		// Page count two ways and take the larger: scrollWidth is usually
		// accurate, but the page of the last block is a reliable backstop if a
		// browser under-reports the overflowing multicol width.
		const byScroll = Math.round(book.scrollWidth / w);
		// The end-of-book notes body is hidden in paged mode (its notes are
		// printed at the foot of their own pages), and a hidden element has no
		// geometry — so the backstop measures the last block still on screen.
		const last = this.lastContentBlock;
		const byBlock = last ? this.pageOfElement(last) + 1 : 1;
		this.pageCount = Math.max(1, byScroll, byBlock);
		let page = this.pageIndex;
		if (anchor >= 0) {
			const blocks = this.getScrollBlocks();
			const el = blocks[Math.min(anchor, blocks.length - 1)];
			page = el ? this.pageOfElement(el) : 0;
		}
		this.goToPage(page, false);
	}

	// Slide to a page (clamped to the valid range).
	private goToPage(page: number, animate: boolean) {
		this.pageIndex = Math.max(0, Math.min(page, this.pageCount - 1));
		const book = this.bookEl;
		if (!book) return;
		book.setCssStyles({
			transition: animate ? "transform 0.18s ease" : "none",
			transform: `translateX(${-this.pageIndex * this.pageWidth()}px)`,
		});
		// Record the anchor here, where the columns and the viewport agree about
		// their width. Once a resize has begun they do not, and no measurement
		// taken before the reflow means anything.
		this.pageAnchor = this.pageAnchorIndex();
		this.updateCounter();
		this.saveReadingPosition();
	}

	// --- Paged mode: footnotes at the foot of their page ---
	//
	// FB2 keeps footnote text in a separate <body name="notes"> at the end of
	// the file and leaves only a superscript marker in the text. In paged mode
	// each note is reprinted at the bottom of the page its marker landed on,
	// the way a printed book does it, and the end-of-book notes body is hidden.
	//
	// How it works: a note block is an absolutely positioned child of the book
	// layer — an absolutely positioned child of a multi-column container is not
	// fragmented into columns, so it can be parked over any single page — and
	// the room it needs is taken out of the text flow by a spacer inserted at
	// the line where the text has to stop, breaking everything below it to the
	// next page.
	//
	// Pages must be processed strictly in order: reserving room on page N
	// reflows everything after it and so changes which page later markers land
	// on. That also makes this the expensive part of paged mode, hence the
	// slicing across frames and the debounce on resize.

	// Content blocks that take part in pagination — everything except the
	// hidden end-of-book notes body, which has no geometry to measure.
	private contentBlocks(): HTMLElement[] {
		return this.getScrollBlocks().filter((b) => !b.closest(".fb2-notes"));
	}

	private noteRefs(): HTMLElement[] {
		if (!this.bookEl) return [];
		// Only markers in the book text proper. A note's own text can carry
		// markers too — in the hidden notes body they have no geometry and
		// pageOfElement puts them on a junk page; in an already placed
		// page-foot block they would breed notes for notes on every pass.
		return Array.from(
			this.bookEl.querySelectorAll<HTMLElement>(".fb2-note-ref[data-fb2-note]")
		).filter((r) => !r.closest(".fb2-notes, .fb2-page-notes"));
	}

	private clearFootnotes() {
		if (!this.bookEl) return;
		for (const el of Array.from(
			this.bookEl.querySelectorAll(".fb2-page-notes, .fb2-note-spacer")
		)) {
			// A spacer sits in the middle of a paragraph, between the two
			// halves of a text node it was inserted into; normalize joins them
			// back so repeated layouts do not shred the text into fragments.
			const parent = el.parentElement;
			el.remove();
			parent?.normalize();
		}
	}

	// Rebuilds every page-foot note block from scratch, in frame-sized slices,
	// keeping the reader on the block their page opens with as it goes. Without
	// `onDone` that is where they are left; with it, the caller decides.
	private layoutFootnotes(onDone?: () => void) {
		const book = this.bookEl;
		if (!book) {
			this.endReflow();
			return;
		}
		const pass = ++this.notesPass; // cancels a layout still in flight
		// A book still opening has its saved position waiting on the end of this
		// layout. Bumping the pass above just cancelled that layout, so whatever
		// cancelled it inherits the restore rather than leaving the reader at the
		// front of the book.
		const done = onDone ?? this.pendingRestore ?? undefined;
		this.clearFootnotes();
		if (!this.isPaged() || !this.noteSources.size) {
			done?.();
			this.endReflow();
			return;
		}
		// Neither list changes while the layout runs — a spacer and a note block
		// match neither selector — so they are built once here rather than being
		// re-queried, with a closest() per block, on every frame slice.
		this.pumpFootnotes(
			pass,
			{ refs: this.noteRefs(), blocks: this.contentBlocks() },
			0,
			0,
			done
		);
	}

	// Walks the markers in document order, one page per step, in ~12 ms slices
	// so a book with hundreds of notes never freezes the UI.
	private pumpFootnotes(
		pass: number,
		lists: { refs: HTMLElement[]; blocks: HTMLElement[] },
		from: number,
		retries: number,
		onDone?: () => void
	) {
		if (pass !== this.notesPass || !this.bookEl) return;
		const deadline = performance.now() + 12;
		const { refs, blocks } = lists;
		let i = from;
		let retried = retries;
		while (i < refs.length) {
			const next = this.placeNotesForPage(refs, blocks, i, retried);
			// placeNotesForPage returns the same index when the markers it was
			// about to serve got pushed onto the next page: their notes follow
			// them there. The retry counter guards against a pathological book
			// making no progress at all.
			retried = next === i ? retried + 1 : 0;
			i = next;
			if (performance.now() > deadline) {
				// This runs with the reader watching, so it has to follow them.
				// Spacers going in on earlier pages push the block their page opens
				// with onto later pages, and the text would slide out from under
				// them while the rest of the book is laid out. pageAnchor is that
				// block and goToAnchor refreshes it, so a page turn in the middle of
				// all this is picked up rather than fought.
				this.goToAnchor(this.pageAnchor);
				const win = this.contentEl.win;
				const at = i;
				const left = retried;
				win.requestAnimationFrame(() =>
					this.pumpFootnotes(pass, lists, at, left, onDone)
				);
				return;
			}
		}
		// The spacers changed the page count; recompute it and settle the reader
		// on the page their block ended up on.
		this.recomputePagination(-1);
		if (onDone) onDone();
		else this.goToAnchor(this.pageAnchor);
		this.endReflow();
	}

	// Put the reader back on the block a reflow was anchored to.
	private goToAnchor(anchor: number) {
		const el = this.getScrollBlocks()[anchor];
		if (el) this.goToPage(this.pageOfElement(el), false);
	}

	// Prints the notes of the markers that sit on one page and reserves room
	// for them. Returns the index of the first marker left to handle.
	private placeNotesForPage(
		refs: HTMLElement[],
		blocks: HTMLElement[],
		from: number,
		retries: number
	): number {
		const book = this.bookEl;
		const height = book?.clientHeight ?? 0;
		if (!book || height <= 0 || this.pageWidth() <= 0) return refs.length;
		const page = this.pageOfElement(refs[from]);
		let to = from;
		while (to < refs.length && this.pageOfElement(refs[to]) === page) to++;

		let group = refs.slice(from, to);
		// Two passes: the first reserves room, the second re-checks that doing
		// so did not carry a marker off the page. Whatever the second pass
		// produces is accepted — a page is never left half-done.
		for (let attempt = 0; ; attempt++) {
			const block = this.buildNoteBlock(group, page);
			if (!block) return to; // none of these ids resolves to any text
			const spacer = this.reserveSpace(blocks, page, block.offsetHeight);
			const kept = group.filter((r) => this.pageOfElement(r) === page);
			if (kept.length === group.length || attempt > 0 || retries >= 4) {
				return to;
			}
			block.remove();
			if (!kept.length) {
				// Every marker moved to the next page, so its note belongs
				// there too — this page is handled again from the same marker.
				// The spacer stays: removing it would only bring the markers
				// back and spin forever. The page ends a little early, which
				// is what a printed book does when a note will not fit.
				return from;
			}
			spacer?.remove();
			group = kept;
		}
	}

	// Builds the note block for one page and parks it over that page. Returns
	// null if none of the markers resolves to note text.
	private buildNoteBlock(group: HTMLElement[], page: number): HTMLElement | null {
		const book = this.bookEl;
		if (!book) return null;
		const block = book.createDiv({ cls: "fb2-page-notes" });
		let any = false;
		for (const ref of group) {
			const src = this.noteSources.get(ref.getAttribute("data-fb2-note") ?? "");
			if (!src) continue;
			const item = block.createDiv({ cls: "fb2-note" });
			const marker = ref.textContent?.trim();
			if (marker) item.createEl("sup", { text: marker, cls: "fb2-note-num" });
			this.renderNoteBody(src, item);
			any = true;
		}
		if (!any) {
			block.remove();
			return null;
		}
		// The block layer is one page-text wide, so the page's own left edge is
		// simply its index times the page step.
		block.setCssStyles({ left: `${page * this.pageWidth()}px` });
		return block;
	}

	// Renders the text of one note. Notes are plain prose, so this deliberately
	// bypasses the block renderer (and its render queue and TOC collection) and
	// treats every child as a paragraph. The <title> is skipped: it usually
	// holds nothing but the note's own number, which is printed as the marker.
	private renderNoteBody(section: Element, container: HTMLElement) {
		for (const child of Array.from(section.children)) {
			const tag = child.localName;
			if (tag === "title" || tag === "empty-line") continue;
			if (tag === "section") {
				this.renderNoteBody(child, container);
				continue;
			}
			this.renderInlineChildren(child, container.createEl("p", {
				cls: "fb2-note-p",
			}));
		}
	}

	// Where an element sits vertically on one given page, in pixels from the
	// top of the page. A block that continues onto the next page is split into
	// fragments, and getBoundingClientRect then reports the union of them —
	// top 0, bottom the full page height — which says nothing about where the
	// block actually starts. getClientRects returns the fragments separately,
	// so the one standing on this page is picked out by its column.
	private fragmentOnPage(
		el: HTMLElement,
		page: number
	): { top: number; bottom: number } | null {
		const book = this.bookEl;
		const w = this.pageWidth();
		if (!book || w <= 0) return null;
		const origin = book.getBoundingClientRect();
		for (const r of Array.from(el.getClientRects())) {
			if (Math.floor((r.left - origin.left + 1) / w) !== page) continue;
			return { top: r.top - origin.top, bottom: r.bottom - origin.top };
		}
		return null;
	}

	// Clears the bottom `height` pixels of a page for the note block: finds
	// where the text first reaches into that band and inserts a spacer filling
	// the rest of the column, so everything from there on breaks to the next
	// page. The spacer goes inside the paragraph, at the line the text has to
	// stop at, so a long paragraph loses only the lines that are in the way.
	// Returns null when the page already has the room the note needs, or when
	// nothing can be moved — in which case the note covers the last lines.
	private reserveSpace(
		blocks: HTMLElement[],
		page: number,
		height: number
	): HTMLElement | null {
		const book = this.bookEl;
		if (!book) return null;
		const pageHeight = book.clientHeight;
		const limit = pageHeight - height; // text has to end above this
		const first = this.firstBlockOnPage(blocks, page);
		// Start one block early: the block before the first one of this page
		// may flow in from the previous page and reach into the note band all
		// the same. When no block starts on this page at all, the page is the
		// middle of one long block, and that block is the only candidate.
		const start =
			first >= 0
				? Math.max(0, first - 1)
				: this.lastBlockBeforePage(blocks, page);
		if (start < 0) return null;
		// One pixel short of the column bottom: an exact fit is at the mercy of
		// sub-pixel rounding, and a spacer a hair too tall spills onto the next
		// page as a band of blank lines.
		const spacerTo = (from: number) => {
			const spacer = createDiv({ cls: "fb2-note-spacer" });
			spacer.setCssStyles({ height: `${Math.max(1, pageHeight - from - 1)}px` });
			return spacer;
		};

		for (let i = start; i < blocks.length; i++) {
			if (this.pageOfElement(blocks[i]) > page) break;
			const box = this.fragmentOnPage(blocks[i], page);
			// The box of a block continuing onto the next page runs to the
			// bottom of the column whatever its text does, so a block is only
			// really in the way once breakPointInBlock says so.
			if (!box || box.bottom <= limit) continue;
			// A chapter heading is never broken mid-line; pushing it whole
			// (the null path below) reads far better.
			const at = blocks[i].hasClass("fb2-title")
				? null
				: this.breakPointInBlock(blocks[i], page, limit);
			if (at === "clear") continue; // its text stops above the note

			// Break the paragraph at the last line that still fits and put the
			// spacer there, so only the lines in the way move to the next page.
			// Pushing the whole paragraph instead would cost up to a page of
			// blank space for the long paragraphs a novel is made of.
			if (at) {
				const spacer = spacerTo(at.top);
				at.range.insertNode(spacer);
				return spacer;
			}

			// No usable break point (an image, or a break at the very start of
			// the block): push the whole block — unless it flows in from the
			// previous page, where a spacer in front of it would reshape a page
			// that is already done.
			if (this.pageOfElement(blocks[i]) !== page) continue;
			// A block whose own top already sits inside the reserved band
			// leaves too little room, so step back until the note fits.
			let victim = i;
			let top = box.top;
			while (victim > first && pageHeight - top < height) {
				const prev = this.fragmentOnPage(blocks[victim - 1], page);
				if (!prev) break;
				victim--;
				top = prev.top;
			}
			const spacer = spacerTo(top);
			blocks[victim].parentElement?.insertBefore(spacer, blocks[victim]);
			return spacer;
		}
		return null; // the page already has all the room the note needs
	}

	// The point inside a block where its text has to stop for the note to fit:
	// the start of the first line on this page reaching below `limit`, as a
	// collapsed range together with that line's top. Answers "clear" when the
	// block's text already stops above the note, and null when there is no
	// line to break at — no text at all (an image), or the break would land at
	// the very start of the block — so the caller pushes the block instead.
	//
	// The line is found by bisecting the block's text, measuring the rect of
	// one character at a time. Not a collapsed caret: at a line wrap a caret
	// rect is ambiguous between the end of one line and the start of the next,
	// and picking the wrong one strands a lone character above the spacer and
	// spills a band of blank lines onto the next page. Position only ever
	// grows along the text, so a dozen measurements are enough however long
	// the paragraph is.
	private breakPointInBlock(
		el: HTMLElement,
		page: number,
		limit: number
	): { range: Range; top: number } | "clear" | null {
		const book = this.bookEl;
		const w = this.pageWidth();
		if (!book || w <= 0) return null;
		const origin = book.getBoundingClientRect();
		const doc = el.ownerDocument;
		const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const texts: Text[] = [];
		let total = 0;
		for (let n = walker.nextNode(); n; n = walker.nextNode()) {
			const t = n as Text;
			if (!t.length) continue;
			texts.push(t);
			total += t.length;
		}
		if (!total) return null;
		const flat = texts.map((t) => t.data).join("");

		const range = doc.createRange();
		// The rect of the single character at a text-wide offset.
		const charRect = (offset: number) => {
			let rest = offset;
			for (const t of texts) {
				if (rest < t.length) {
					range.setStart(t, rest);
					range.setEnd(t, rest + 1);
					break;
				}
				rest -= t.length;
			}
			const r = range.getBoundingClientRect();
			return {
				empty: r.width === 0 && r.height === 0,
				page: Math.floor((r.left - origin.left + 1) / w),
				top: r.top - origin.top,
				bottom: r.bottom - origin.top,
			};
		};
		// Has the text reached past the room the note needs by this character?
		// A space collapsed away at a line wrap has no rect of its own; it
		// reaches exactly as far as the first drawn character after it.
		const past = (offset: number) => {
			for (let i = offset; i < total; i++) {
				const m = charRect(i);
				if (m.empty) continue;
				return m.page > page || (m.page === page && m.bottom > limit);
			}
			return false;
		};
		if (!past(total - 1)) return "clear"; // the text never reaches that far

		let lo = 0;
		let hi = total - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (past(mid)) hi = mid;
			else lo = mid + 1;
		}
		// The first drawn character at or after `lo` starts the first line
		// that has to move.
		let c = lo;
		let m = charRect(c);
		while (m.empty && c + 1 < total) m = charRect(++c);
		// It may sit on the next page already, in which case nothing this
		// block puts on this page is in the note's way.
		if (m.page !== page) return "clear";
		// Don't split a word: a line that starts mid-word (a hyphenation
		// break) re-wraps once its tail is cut away, and the measured geometry
		// no longer holds. Step back to the space in front of the word so the
		// whole word moves. A word too long to be worth moving (40+ chars —
		// likely a URL) is split at the wrap after all: cutting an unbreakable
		// word at its own wrap point re-wraps nothing.
		let at = c;
		while (at > 0 && at > c - 40 && !/\s/.test(flat[at - 1])) at--;
		if (at > 0 && !/\s/.test(flat[at - 1])) at = c;
		if (at === 0) return null; // nothing would be left above the break
		let rest = at;
		for (const t of texts) {
			if (rest <= t.length) {
				range.setStart(t, rest);
				range.setEnd(t, rest);
				break;
			}
			rest -= t.length;
		}
		return { range: range.cloneRange(), top: m.top };
	}

	// Index of the first block on a page. Blocks are in document order and
	// pages only ever grow along it, so a binary search finds it in a dozen
	// reads instead of walking the whole book for every page.
	private firstBlockOnPage(blocks: HTMLElement[], page: number): number {
		let lo = 0;
		let hi = blocks.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.pageOfElement(blocks[mid]) >= page) {
				if (this.pageOfElement(blocks[mid]) === page) found = mid;
				hi = mid - 1;
			} else {
				lo = mid + 1;
			}
		}
		return found;
	}

	// Index of the last block starting before a page — the block that a page
	// no block starts on is the middle of. Same bisection as above.
	private lastBlockBeforePage(blocks: HTMLElement[], page: number): number {
		let lo = 0;
		let hi = blocks.length - 1;
		let found = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (this.pageOfElement(blocks[mid]) < page) {
				found = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return found;
	}

	private nextPage() {
		this.goToPage(this.pageIndex + 1, true);
	}

	private prevPage() {
		this.goToPage(this.pageIndex - 1, true);
	}

	// Index of the block the current page OPENS with — the first one that starts
	// on it, not the first one visible on it. The distinction is the whole point:
	// a page normally opens in the middle of a paragraph carried over from the
	// page before, and pageOfElement answers for that paragraph with the page it
	// starts on, which is the previous one. Anchoring a reflow on the first
	// visible block therefore walked the reader a page backwards every time, and
	// an orientation change reflows several times over. Anchoring on the block
	// the page starts with is a fixed point: the page it reports is the page it
	// opens, so repeated reflows land in the same place.
	//
	// Page math rather than viewport geometry, because pageOfElement compares two
	// rects that carry the same transform: the answer holds even while a page
	// turn is still animating, where reading the viewport would give the page
	// being slid away from.
	//
	// Answers -1 when the page has no block to hold on to, which callers read as
	// "stay on the page number you are on".
	private pageAnchorIndex(): number {
		const all = this.getScrollBlocks();
		// The hidden end-of-book notes body has no geometry and would report
		// nonsense pages, so the search runs over the blocks actually laid out;
		// the answer is mapped back to an index into the full list, which is what
		// a stored reading position is expressed in.
		const laid = all.filter((b) => !b.closest(".fb2-notes"));
		if (!laid.length) return -1;
		const first = this.firstBlockOnPage(laid, this.pageIndex);
		// No block starts on this page. Either it is the middle of one long block,
		// which is then the only anchor there is, or nothing has started yet at all
		// — a front page carrying just the cover, where the page number has to do.
		const at =
			first >= 0 ? first : this.lastBlockBeforePage(laid, this.pageIndex);
		if (at < 0) return -1;
		return Math.max(0, all.indexOf(laid[at]));
	}

	private savePagedPosition(file = this.file) {
		if (!file) return;
		// Page 0 before the restore is just the book still loading.
		if (this.pageIndex <= 0 && !this.positionRestored) return;
		// No anchor means nothing has started on this page or before it, so the
		// reader is on the cover pages at the very front: record the beginning.
		const idx = Math.max(0, this.pageAnchor);
		if (idx > 0 || this.positionRestored) this.plugin.setPosition(file.path, idx);
	}

	private updateCounter() {
		this.counterEl?.setText(`${this.pageIndex + 1} / ${this.pageCount}`);
	}

	// Reveal an element (TOC entry or cross-reference target) in either mode.
	revealElement(el: HTMLElement) {
		if (!this.isPaged()) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
			return;
		}
		const target = this.pagedTarget(el);
		if (target) this.goToPage(this.pageOfElement(target), true);
	}

	// Where to land for a target in paged mode. Paged mode hides the
	// end-of-book notes body, and a hidden element has no geometry, so
	// pageOfElement would answer with a junk page for anything inside it. A link
	// into a note is redirected to the marker referring to it, which sits on the
	// page the note is printed under; a note nothing refers to has nowhere to go.
	private pagedTarget(el: HTMLElement): HTMLElement | null {
		if (!el.closest(".fb2-notes")) return el;
		const id = el.closest("[data-fb2-id]")?.getAttribute("data-fb2-id");
		if (!id || !this.bookEl) return null;
		const refs = this.bookEl.querySelectorAll<HTMLElement>(
			`.fb2-note-ref[data-fb2-note="${CSS.escape(id)}"]`
		);
		return (
			Array.from(refs).find(
				(r) => !r.closest(".fb2-notes, .fb2-page-notes")
			) ?? null
		);
	}

	// Called by the plugin after any settings change: switch layout if the
	// reading mode flipped, and re-paginate (metrics may have changed).
	onSettingsChanged() {
		if (!this.bookEl) return;
		const wasPaged = this.contentEl.hasClass("fb2-paged");
		const anchor = wasPaged ? this.pageAnchor : this.firstVisibleScrollIndex();
		this.applyModeClass();
		this.contentEl.win.requestAnimationFrame(() => {
			const blocks = this.getScrollBlocks();
			const el = blocks[Math.min(anchor, blocks.length - 1)];
			if (this.isPaged()) {
				// Same as a resize: cover the one reflow that repositions the
				// reader, then fill the notes back in behind them.
				this.beginReflow();
				this.notesPass++;
				this.clearFootnotes();
				this.recomputePagination(-1);
				this.goToPage(el ? this.pageOfElement(el) : 0, false);
				this.endReflow();
				// Font or spacing changes move every marker, so the page-foot
				// notes have to be laid out again from scratch.
				this.layoutFootnotes();
			} else {
				el?.scrollIntoView({ block: "start" });
			}
		});
	}

	// --- Paged mode: input ---

	private onKeyDown(e: KeyboardEvent) {
		if (!this.isPaged()) return;
		if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
			e.preventDefault();
			this.nextPage();
		} else if (e.key === "ArrowLeft" || e.key === "PageUp") {
			e.preventDefault();
			this.prevPage();
		}
	}

	private onViewClick(e: MouseEvent) {
		if (!this.isPaged()) return;
		// Don't turn while selecting text or when a link was clicked.
		const sel = this.contentEl.win.getSelection();
		if (sel && !sel.isCollapsed) return;
		if ((e.target as HTMLElement).closest("a")) return;
		this.contentEl.focus({ preventScroll: true }); // enable keyboard paging
		const rect = this.contentEl.getBoundingClientRect();
		if (e.clientX - rect.left < rect.width / 2) this.prevPage();
		else this.nextPage();
	}

	// --- Rendering ---

	// FB2 images live at the end of the file in <binary> tags as base64 text.
	// Each one is decoded into a Blob and exposed as an object URL — far
	// lighter than data URLs, which keep the full base64 string in memory
	// (and in every <img> src). The URLs are revoked in clearBinaries when
	// the file closes; forgetting that would leak the blobs for the whole
	// session.
	private collectBinaries(doc: Document) {
		this.clearBinaries();
		for (const bin of Array.from(doc.getElementsByTagName("binary"))) {
			const id = bin.getAttribute("id");
			if (!id) continue; // an image without an id cannot be referenced
			const type = bin.getAttribute("content-type") || "image/jpeg";
			const data = (bin.textContent || "").replace(/\s+/g, ""); // strip line breaks
			try {
				const blob = new Blob([base64ToArrayBuffer(data)], { type });
				this.binaries.set(id, URL.createObjectURL(blob));
			} catch {
				// broken base64 — skip this image
			}
		}
	}

	// Revokes every object URL created for the current book.
	private clearBinaries() {
		for (const url of this.binaries.values()) URL.revokeObjectURL(url);
		this.binaries.clear();
	}

	// Top level of rendering: title page, then every <body>
	// (the main text and, as a separate block, the footnotes).
	// Bodies are not rendered here directly — their blocks are queued and
	// rendered in per-frame slices by pumpRenderQueue.
	private renderBook(doc: Document, root: HTMLElement) {
		this.renderQueue = [];
		const pass = ++this.renderPass;

		const titleInfo = doc.querySelector("description > title-info");
		this.collectToc = false;
		if (titleInfo) this.renderTitleInfo(titleInfo, root);

		this.noteSources.clear();
		for (const body of Array.from(doc.querySelectorAll("FictionBook > body"))) {
			// <body name="notes"> holds footnotes; keep their headings out of the TOC.
			const isNotes = body.getAttribute("name") === "notes";
			// Index the notes by id so paged mode can print each one at the foot
			// of the page its marker landed on.
			if (isNotes) {
				for (const section of Array.from(body.querySelectorAll("section"))) {
					const id = section.getAttribute("id");
					if (id) this.noteSources.set(id, section);
				}
			}
			const bodyEl = root.createDiv({
				cls: isNotes ? "fb2-body fb2-notes" : "fb2-body",
			});
			if (isNotes) bodyEl.createEl("hr"); // divider before the footnotes
			this.renderQueue.push(...this.childJobs(body, bodyEl, 1, !isNotes));
		}

		// A single click handler for the whole book serves internal
		// cross-references: find the element with the matching data-fb2-id and
		// smooth-scroll to it. Footnote references and their back links are not
		// rendered as links (they navigated poorly), so they never reach here.
		root.addEventListener("click", (evt) => {
			const clicked = evt.target as HTMLElement;
			const link = clicked.closest("a[data-fb2-target]");
			if (!link) return;
			evt.preventDefault();
			const target = link.getAttribute("data-fb2-target");
			const dest = root.querySelector(
				`[data-fb2-id="${CSS.escape(target ?? "")}"]`
			);
			if (!(dest instanceof HTMLElement)) return;
			this.revealElement(dest);
		});

		this.pumpRenderQueue(pass);
	}

	// Turns the children of an FB2 element into render jobs.
	private childJobs(
		el: Element,
		parent: HTMLElement,
		depth: number,
		toc: boolean
	): RenderJob[] {
		return Array.from(el.children).map((child) => ({
			el: child,
			parent,
			depth,
			toc,
		}));
	}

	// Renders queued blocks in ~12 ms slices, yielding to the browser between
	// slices, so even a huge book never freezes the UI. Once the queue drains,
	// refreshes the TOC panel and restores the reading position.
	private pumpRenderQueue(pass: number) {
		const deadline = performance.now() + 12;
		while (this.renderQueue.length) {
			if (performance.now() > deadline) {
				// contentEl.win: schedule on the window owning this view,
				// which matters when the reader lives in a popout window.
				this.contentEl.win.requestAnimationFrame(() => {
					// A new render (or file close) may have started meanwhile.
					if (pass === this.renderPass) this.pumpRenderQueue(pass);
				});
				return;
			}
			const job = this.renderQueue.shift() as RenderJob;
			this.collectToc = job.toc;
			this.renderBlock(job.el, job.parent, job.depth);
		}
		this.collectToc = false;
		const blocks = this.contentBlocks();
		this.lastContentBlock = blocks[blocks.length - 1] ?? null;
		this.plugin.updateToc(this);
		const restore = () => {
			this.pendingRestore = null;
			if (this.file) this.restoreReadingPosition(this.file.path);
		};
		if (!this.isPaged()) {
			restore();
			return;
		}
		this.pendingRestore = restore;
		this.recomputePagination(-1);
		// The saved position is restored only once the notes have taken their
		// room: they shift every page after them along.
		this.layoutFootnotes(restore);
	}

	// Title page: cover, title, authors, annotation.
	private renderTitleInfo(info: Element, root: HTMLElement) {
		const header = root.createDiv({ cls: "fb2-title-page" });

		const coverImage = info.querySelector("coverpage > image");
		if (coverImage) this.renderImage(coverImage, header, "fb2-cover");

		const title = info.querySelector("book-title")?.textContent?.trim();
		if (title) {
			this.bookTitle = title;
			header.createEl("h1", { text: title, cls: "fb2-book-title" });
		}

		// For each <author>, join first/middle/last name with spaces,
		// skipping missing parts; drop authors that end up empty.
		const authors = Array.from(info.querySelectorAll(":scope > author"))
			.map((a) =>
				["first-name", "middle-name", "last-name"]
					.map((tag) => a.querySelector(tag)?.textContent?.trim())
					.filter(Boolean)
					.join(" ")
			)
			.filter(Boolean);
		if (authors.length) {
			header.createEl("p", { text: authors.join(", "), cls: "fb2-authors" });
		}

		const annotation = info.querySelector("annotation");
		if (annotation) {
			// Queued (not rendered inline): the queue is still empty at this
			// point, so the annotation is rendered in the very first slice.
			this.renderQueue.push(
				...this.childJobs(
					annotation,
					header.createDiv({ cls: "fb2-annotation" }),
					1,
					false
				)
			);
		}
	}

	// The heart of the reader: turns one FB2 block tag into HTML.
	// Leaf blocks (paragraphs, tables...) are rendered immediately; container
	// blocks create their wrapper and queue their children to the FRONT of the
	// render queue, which keeps depth-first document order while letting
	// pumpRenderQueue slice the work across frames.
	private renderBlock(el: Element, parent: HTMLElement, depth: number) {
		const tag = el.localName; // tag name without prefixes, e.g. "section"

		// Case 1: a container tag from BLOCK_CONTAINERS.
		const container = BLOCK_CONTAINERS[tag];
		if (container) {
			const box = parent.createEl(container.tag, { cls: container.cls });
			copyId(el, box);
			this.renderQueue.unshift(
				...this.childJobs(
					el,
					box,
					tag === "section" ? depth + 1 : depth,
					this.collectToc
				)
			);
			return;
		}

		// Case 2: a paragraph tag from BLOCK_PARAGRAPHS.
		const paragraphCls = BLOCK_PARAGRAPHS[tag];
		if (paragraphCls) {
			const p = parent.createEl("p", { cls: paragraphCls });
			copyId(el, p);
			this.renderInlineChildren(el, p);
			return;
		}

		// Case 3: special tags that need their own logic.
		switch (tag) {
			case "title": {
				// Chapter heading. The level (h2, h3...) depends on the section
				// nesting depth; HTML has nothing deeper than h6.
				const level = Math.min(depth + 1, 6);
				const heading = parent.createEl(
					`h${level}` as keyof HTMLElementTagNameMap,
					{ cls: "fb2-title" }
				);
				// An FB2 heading may consist of several <p> elements —
				// render each on its own line (separated by <br>).
				const tocText: string[] = [];
				for (const child of Array.from(el.children)) {
					if (child.localName !== "p") continue;
					if (heading.childNodes.length) heading.createEl("br");
					this.renderInlineChildren(child, heading);
					// TOC text, without the footnote markers a heading may
					// carry — their bare numbers would read as part of it.
					const clone = child.cloneNode(true) as Element;
					for (const note of Array.from(
						clone.querySelectorAll('a[type="note"]')
					)) {
						note.remove();
					}
					const text = clone.textContent?.trim();
					if (text) tocText.push(text);
				}
				// Also add a TOC entry (except inside the footnotes body).
				if (this.collectToc) {
					this.tocItems.push({ text: tocText.join(" "), depth, el: heading });
				}
				break;
			}
			case "empty-line":
				parent.createDiv({ cls: "fb2-empty-line" }); // vertical gap
				break;
			case "image":
				this.renderImage(el, parent, "fb2-image-block");
				break;
			case "table": {
				// Copy <tr> rows and <td>/<th> cells over as they are.
				const table = parent.createEl("table", { cls: "fb2-table" });
				// Avoid splitting a table across a page break in paged mode.
				table.setCssStyles({ breakInside: "avoid" });
				for (const tr of Array.from(el.querySelectorAll("tr"))) {
					const rowEl = table.createEl("tr");
					for (const cell of Array.from(tr.children)) {
						const cellTag = cell.localName === "th" ? "th" : "td";
						this.renderInlineChildren(cell, rowEl.createEl(cellTag));
					}
				}
				break;
			}
			default:
				// Unknown tag: don't render it itself, but keep its content.
				// A tag with element children is walked recursively; a tag
				// holding only text (e.g. <date> inside a poem) degrades to
				// a paragraph so the text isn't silently dropped.
				if (el.children.length) {
					this.renderQueue.unshift(
						...this.childJobs(el, parent, depth, this.collectToc)
					);
				} else {
					const text = el.textContent?.trim();
					if (text) parent.createEl("p", { cls: "fb2-p", text });
				}
		}
	}

	// Renders all content of the element (both tags and text nodes) inline.
	private renderInlineChildren(el: Element, parent: HTMLElement) {
		for (const node of Array.from(el.childNodes)) {
			this.renderInline(node, parent);
		}
	}

	// Renders inline content: text, emphasis, links, footnotes...
	private renderInline(node: Node, parent: HTMLElement) {
		// Plain text between tags — append as is.
		if (node.nodeType === Node.TEXT_NODE) {
			parent.appendText(node.textContent ?? "");
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return; // skip comments etc.
		const el = node as Element;
		const tag = el.localName;

		// Simple tags from INLINE_TAGS: <emphasis> → <em> and so on.
		const htmlTag = INLINE_TAGS[tag];
		if (htmlTag) {
			this.renderInlineChildren(el, parent.createEl(htmlTag));
			return;
		}

		switch (tag) {
			case "image":
				this.renderImage(el, parent, "fb2-image-inline");
				break;
			case "a": {
				const href = getHref(el) ?? "";
				// A footnote (type="note") renders as a plain superscript
				// number with no link: the in-text reference and its back link
				// navigated poorly, so footnotes are no longer clickable. Only
				// the number is kept (any label like "note" is dropped), and it
				// hugs the preceding word with no separating space.
				if (el.getAttribute("type") === "note") {
					const raw = (el.textContent ?? "").trim();
					const marker = raw.match(/\d+/)?.[0] ?? raw;
					// Trim a trailing space left by the preceding text so the
					// superscript sits directly on the previous word.
					const prev = parent.lastChild;
					if (prev && prev.nodeType === Node.TEXT_NODE) {
						prev.textContent = (prev.textContent ?? "").replace(/\s+$/, "");
					}
					const sup = parent.createEl("sup", {
						text: marker,
						cls: "fb2-note-ref",
					});
					// The target id is kept so paged mode can find the note text
					// and print it at the foot of the page (see layoutFootnotes).
					if (href.startsWith("#")) {
						sup.setAttribute("data-fb2-note", href.slice(1));
					}
					break;
				}
				const anchor = parent.createEl("a", { cls: "fb2-link" });
				if (href.startsWith("#")) {
					// Internal cross-reference (e.g. chapter): store the target
					// in data-fb2-target — clicks are handled in renderBook.
					anchor.setAttribute("data-fb2-target", href.slice(1));
					anchor.setAttribute("href", "#");
				} else if (/^https?:\/\//i.test(href)) {
					// External link: http(s) only. A malicious file could carry
					// a javascript: or other scheme URL — clicking it would run
					// code in the renderer, so anything else stays inert
					// (the <a> keeps its text but gets no href).
					anchor.setAttribute("href", href);
				}
				this.renderInlineChildren(el, anchor);
				break;
			}
			default:
				// Unknown inline tag — at least render its content.
				this.renderInlineChildren(el, parent);
		}
	}

	// Inserts an image: resolves the "#id" reference to an object URL
	// in the binaries map and creates an <img> element. loading="lazy" defers
	// fetching/decoding until the image approaches the viewport.
	private renderImage(el: Element, parent: HTMLElement, cls: string) {
		const href = getHref(el);
		if (!href || !href.startsWith("#")) return;
		const src = this.binaries.get(href.slice(1));
		if (!src) return;
		const img = parent.createEl("img", { cls });
		img.loading = "lazy";
		img.decoding = "async";
		img.src = src;
		const alt = el.getAttribute("alt");
		if (alt) img.alt = alt;
		// Block images shouldn't be split across a page break in paged mode.
		if (cls === "fb2-image-block") img.setCssStyles({ breakInside: "avoid" });
	}
}

// ---------------------------------------------------------------------------
// Fb2TocView — the table-of-contents side panel
//
// Computes nothing itself: it displays the tocItems list collected
// by the reader view.
// ---------------------------------------------------------------------------

class Fb2TocView extends ItemView {
	// The reader whose TOC is currently shown (null — none).
	private source: Fb2View | null = null;

	getViewType(): string {
		return VIEW_TYPE_TOC;
	}

	getDisplayText(): string {
		return "FB2 table of contents";
	}

	getIcon(): string {
		return "book-open"; // match the reader view's book icon
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	// Is this panel showing the TOC of the given reader?
	sourceIs(view: Fb2View): boolean {
		return this.source === view;
	}

	// Called by the plugin when the active book changes; re-renders the panel.
	setSource(view: Fb2View | null) {
		this.source = view;
		this.render();
	}

	private render() {
		const el = this.contentEl;
		el.empty();
		el.addClass("fb2-toc");

		if (!this.source || !this.source.tocItems.length) {
			el.createEl("p", {
				text: "Open an FB2 file to see its table of contents.",
				cls: "fb2-toc-empty",
			});
			return;
		}

		// Book title on top, then one row per heading.
		el.createDiv({ cls: "fb2-toc-book", text: this.source.getDisplayText() });
		for (const item of this.source.tocItems) {
			// The row is a button in everything but tag name, so it says so and
			// takes focus: a bare div with a click handler cannot be reached by
			// keyboard and is announced as nothing at all.
			const row = el.createDiv({
				cls: "fb2-toc-item",
				text: item.text || "(untitled)",
				attr: { role: "button", tabindex: "0" },
			});
			// Indentation grows with depth to show chapter nesting.
			row.setCssStyles({ paddingLeft: `${(item.depth - 1) * 14 + 6}px` });
			// Reveal the book tab and scroll to the chapter.
			const open = () => {
				const src = this.source;
				if (!src) return;
				void this.app.workspace.revealLeaf(src.leaf);
				src.revealElement(item.el);
			};
			row.addEventListener("click", open);
			row.addEventListener("keydown", (e) => {
				if (e.key !== "Enter" && e.key !== " ") return;
				e.preventDefault(); // Space would scroll the panel
				open();
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Fb2ReaderPlugin — the main plugin class
//
// Ties everything together: registers the views, stores and persists
// settings and reading positions, and manages the TOC panel.
// ---------------------------------------------------------------------------

export default class Fb2ReaderPlugin extends Plugin {
	// Settings, persisted to data.json.
	private data: Fb2Data = { settings: { ...DEFAULT_SETTINGS } };
	// Reading positions (file path → position), held in memory and mirrored to
	// localStorage. Never written to data.json — see POSITIONS_KEY.
	private positions: Record<string, ReadingPosition> = {};
	// Deferred saving: write to disk at most once per 2 seconds.
	private saveDataDebounced = debounce(() => this.saveData(this.data), 2000, true);
	// Same for positions, which change on every scroll.
	private savePositionsDebounced = debounce(() => this.savePositions(), 2000, true);

	async onload() {
		// Load persisted data (data.json). Object.assign layers the stored
		// settings over the defaults, so fields added in a plugin update
		// still get values.
		const stored = ((await this.loadData()) ?? {}) as LegacyFb2Data;
		this.data = {
			settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings),
			tocPanelCreated: stored.tocPanelCreated === true,
		};
		this.loadPositions(stored);
		this.applySettings();

		// Tell Obsidian how to create our views...
		this.registerView(VIEW_TYPE_FB2, (leaf) => new Fb2View(leaf, this));
		this.registerView(VIEW_TYPE_TOC, (leaf) => new Fb2TocView(leaf));
		// ...and that .fb2 files open in the reader.
		this.registerExtensions(["fb2"], VIEW_TYPE_FB2);
		this.addSettingTab(new Fb2SettingTab(this.app, this));

		// Ribbon button that opens the plugin settings.
		this.addRibbonIcon("book-open-text", "FB2 Reader settings", () => {
			// app.setting is an undocumented part of the Obsidian API,
			// so its type has to be spelled out manually.
			const appSetting = (
				this.app as App & {
					setting: { open(): void; openTabById(id: string): void };
				}
			).setting;
			appSetting.open();
			appSetting.openTabById(this.manifest.id);
		});

		// Command palette entry: open the table of contents.
		this.addCommand({
			id: "open-toc",
			name: "Open table of contents",
			callback: () => this.activateTocLeaf(),
		});

		// When the active tab changes to a reader, show its TOC in the panel.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof Fb2View) this.updateToc(leaf.view);
			})
		);

		// A popout window starts with a fresh <body> that has none of our CSS
		// variables or theme classes; re-apply the settings when a window opens
		// and when leaves move between windows. applySettings is idempotent
		// and cheap, so firing it on every layout change costs nothing.
		this.registerEvent(
			this.app.workspace.on("window-open", () => this.applySettings())
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.applySettings())
		);

		// Positions are keyed by file path, so a renamed or moved book has to take
		// its entry along or it reopens at page one.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) =>
				this.movePositions(file.path, oldPath)
			)
		);
	}

	// Called when the plugin is disabled: save data and remove every trace
	// of our settings from <body> (CSS variables and theme classes).
	onunload() {
		// Cancel before saving by hand: a debounced write landing after the plugin
		// is gone would overwrite what we are about to put on disk.
		this.saveDataDebounced.cancel();
		void this.saveData(this.data);
		this.savePositionsDebounced.cancel();
		this.savePositions();
		for (const body of this.readerBodies()) {
			body.style.removeProperty("--fb2-font-family");
			body.style.removeProperty("--fb2-font-size");
			body.style.removeProperty("--fb2-line-height");
			body.style.removeProperty("--fb2-text-color");
			body.removeClass(
				"fb2-theme-dark",
				"fb2-theme-light",
				"fb2-theme-sepia",
				"fb2-theme-solarized-dark"
			);
		}
	}

	// --- Settings ---

	get fb2Settings(): Fb2Settings {
		return this.data.settings;
	}

	// Applies the settings to the page by writing them into CSS variables
	// on <body>; styles.css reads them and styles the book. This keeps the
	// code and the styling decoupled. A reader may live in a popout window,
	// whose document has its own <body> — write to every one of them.
	applySettings() {
		for (const body of this.readerBodies()) this.applySettingsTo(body);
	}

	// The <body> of the main window plus of every window holding a reader.
	private readerBodies(): HTMLElement[] {
		const bodies = new Set<HTMLElement>([document.body]);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FB2)) {
			bodies.add(leaf.view.containerEl.doc.body);
		}
		return Array.from(bodies);
	}

	private applySettingsTo(body: HTMLElement) {
		const s = this.data.settings;
		if (s.fontFamily) body.style.setProperty("--fb2-font-family", s.fontFamily);
		else body.style.removeProperty("--fb2-font-family");
		body.style.setProperty("--fb2-font-size", `${s.fontSize}px`);
		body.style.setProperty("--fb2-line-height", `${s.lineHeight}`);
		body.toggleClass("fb2-theme-dark", s.theme === "dark");
		body.toggleClass("fb2-theme-light", s.theme === "light");
		body.toggleClass("fb2-theme-sepia", s.theme === "sepia");
		body.toggleClass("fb2-theme-solarized-dark", s.theme === "solarized-dark");
		if (s.textColor) body.style.setProperty("--fb2-text-color", s.textColor);
		else body.style.removeProperty("--fb2-text-color");
	}

	// Apply and (deferred) save — called from the settings tab.
	saveSettings() {
		this.applySettings();
		this.refreshReaders();
		this.saveDataDebounced();
	}

	// Let every open reader react to a settings change: the reading mode may
	// have flipped, or a metric (font, size, line height, theme) that affects
	// where pages break may have changed.
	private refreshReaders() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_FB2)) {
			if (leaf.view instanceof Fb2View) leaf.view.onSettingsChanged();
		}
	}

	// --- Reading positions ---

	getPosition(path: string): ReadingPosition | undefined {
		return this.positions[path];
	}

	setPosition(path: string, index: number) {
		this.positions[path] = { index, ts: Date.now() };
		this.prunePositions();
		this.savePositionsDebounced();
	}

	// Follows a rename: moves the entry of the file itself, and — since a folder
	// rename is reported as one event for the folder — the entries of every book
	// underneath it, which are matched by path prefix.
	private movePositions(path: string, oldPath: string) {
		const prefix = `${oldPath}/`;
		const moved: Record<string, ReadingPosition> = {};
		let changed = false;
		for (const [key, pos] of Object.entries(this.positions)) {
			if (key === oldPath) {
				moved[path] = pos;
				changed = true;
			} else if (key.startsWith(prefix)) {
				moved[path + key.slice(oldPath.length)] = pos;
				changed = true;
			} else {
				moved[key] = pos;
			}
		}
		if (!changed) return;
		this.positions = moved;
		this.savePositionsDebounced();
	}

	// Reads the positions saved on this device. Versions up to 0.2.0 kept them
	// in data.json; if such entries are still there they are moved over once
	// and stripped from the file, so an update does not lose reading progress.
	private loadPositions(stored: LegacyFb2Data) {
		const local = this.app.loadLocalStorage(POSITIONS_KEY) as
			| Record<string, ReadingPosition>
			| null;
		this.positions = local ?? {};
		if (!stored.positions) return;
		// Local entries win: they are this device's own, newer history.
		this.positions = Object.assign({}, stored.positions, this.positions);
		this.prunePositions();
		this.savePositions();
		void this.saveData(this.data); // rewrites data.json without positions
	}

	private savePositions() {
		this.app.saveLocalStorage(POSITIONS_KEY, this.positions);
	}

	// Keep positions for the 300 most recent books only, so the stored table
	// does not grow forever; the oldest entries are dropped.
	private prunePositions() {
		const entries = Object.entries(this.positions);
		if (entries.length <= 300) return;
		entries.sort((a, b) => b[1].ts - a[1].ts); // newest first
		this.positions = Object.fromEntries(entries.slice(0, 300));
	}

	// --- TOC panel ---

	// Called by the reader when it has opened a book: put the TOC panel in the
	// right sidebar the first time round, then refresh it.
	onFb2Opened(view: Fb2View) {
		this.app.workspace.onLayoutReady(async () => {
			await this.ensureTocPanelOnce();
			this.updateToc(view);
		});
	}

	// Adds the TOC panel to the right sidebar the first time a book is opened,
	// and never again. Reopening it on every book undid the user's decision to
	// close it; the ribbon and the "Open table of contents" command are the way
	// back, and an existing panel is simply noted as done.
	private async ensureTocPanelOnce() {
		if (this.data.tocPanelCreated) return;
		if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC).length) {
			const leaf = this.app.workspace.getRightLeaf(false);
			if (!leaf) return; // no sidebar to put it in; try again next time
			await leaf.setViewState({ type: VIEW_TYPE_TOC, active: false });
		}
		this.data.tocPanelCreated = true;
		this.saveDataDebounced();
	}

	// Shows the given reader's TOC in every TOC panel.
	updateToc(view: Fb2View | null) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
			if (leaf.view instanceof Fb2TocView) leaf.view.setSource(view);
		}
	}

	// When a book closes, clear the panels that were showing its TOC.
	clearTocFor(view: Fb2View) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
			if (leaf.view instanceof Fb2TocView && leaf.view.sourceIs(view)) {
				leaf.view.setSource(null);
			}
		}
	}

	// "Open table of contents" command: find (or create) the TOC panel,
	// reveal it and fill it with the active book's contents.
	private async activateTocLeaf() {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: VIEW_TYPE_TOC, active: true });
			leaf = right;
		}
		await this.app.workspace.revealLeaf(leaf);
		const active = this.app.workspace.getActiveViewOfType(Fb2View);
		if (active) this.updateToc(active);
	}
}

// ---------------------------------------------------------------------------
// Fb2SettingTab — the settings tab
//
// On Obsidian 1.13+ the tab is rendered declaratively from
// getSettingDefinitions(), which also feeds the settings search. The
// imperative display()/render() pair below is the fallback for older
// versions and is not called when definitions are provided.
// ---------------------------------------------------------------------------

class Fb2SettingTab extends PluginSettingTab {
	private plugin: Fb2ReaderPlugin;
	// Render counter — guards against a race (see the comment in render).
	private renderToken = 0;
	// The system font list is fetched once, asynchronously; the tab
	// re-renders when it arrives (see fontDefinition).
	private fontsRequested = false;

	constructor(app: App, plugin: Fb2ReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	// --- Declarative settings (Obsidian 1.13+) ---

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Theme",
				desc: "Color scheme for the reading area.",
				control: {
					type: "dropdown",
					key: "theme",
					defaultValue: "",
					options: {
						"": "Same as Obsidian",
						light: "Light",
						dark: "Dark",
						sepia: "Sepia",
						"solarized-dark": "Solarized dark",
					},
				},
			},
			{
				name: "Reading mode",
				desc: "Continuous scroll, or turn one page at a time.",
				control: {
					type: "dropdown",
					key: "readingMode",
					defaultValue: "scroll",
					options: {
						scroll: "Scroll (infinite page)",
						paged: "Paged",
					},
				},
			},
			{
				name: "Text color",
				desc: "Color of the main book text. Default follows the theme.",
				control: {
					type: "dropdown",
					key: "textColor",
					defaultValue: "",
					options: this.textColorOptions(),
				},
			},
			this.fontDefinition(),
			{
				name: "Font size",
				desc: "Book text size in pixels (8–72).",
				control: {
					type: "number",
					key: "fontSize",
					defaultValue: DEFAULT_SETTINGS.fontSize,
					min: 8,
					max: 72,
					step: 1,
					validate: (v) =>
						Number.isFinite(v) && v >= 8 && v <= 72
							? undefined
							: "Enter a number between 8 and 72.",
				},
			},
			{
				name: "Line height",
				desc: "Line spacing multiplier (1–3), e.g. 1.5.",
				control: {
					type: "number",
					key: "lineHeight",
					defaultValue: DEFAULT_SETTINGS.lineHeight,
					min: 1,
					max: 3,
					step: 0.05,
					validate: (v) =>
						Number.isFinite(v) && v >= 1 && v <= 3
							? undefined
							: "Enter a number between 1 and 3.",
				},
			},
			{
				name: "Reset to defaults",
				action: () => {
					Object.assign(this.plugin.fb2Settings, DEFAULT_SETTINGS);
					this.plugin.saveSettings();
					this.refreshTab(); // re-render with the restored values
				},
			},
		];
	}

	// Re-render the tab. SettingTab.update() exists only on Obsidian 1.13+
	// (above our minAppVersion), so it is looked up at runtime; older
	// versions re-render through display().
	private refreshTab(): void {
		const tab = this as unknown as { update?: () => void };
		if (typeof tab.update === "function") tab.update();
		else this.display();
	}

	getControlValue(key: string): unknown {
		return this.plugin.fb2Settings[key as keyof Fb2Settings];
	}

	setControlValue(key: string, value: unknown): void {
		if (typeof value === "string") value = value.trim();
		(this.plugin.fb2Settings as unknown as Record<string, unknown>)[key] =
			value;
		this.plugin.saveSettings();
	}

	// Text color presets, plus the saved color as an extra option when it is
	// not in the list (e.g. hand-edited in data.json), so the selection
	// doesn't get lost.
	private textColorOptions(): Record<string, string> {
		const options: Record<string, string> = {};
		const current = this.plugin.fb2Settings.textColor;
		if (current && !(current in TEXT_COLORS)) options[current] = current;
		return Object.assign(options, TEXT_COLORS);
	}

	// Font: a dropdown when the system font list is available, otherwise
	// (no permission, unsupported platform) a plain text field.
	// getSettingDefinitions is synchronous, so the first call kicks off the
	// async font query and re-renders the tab once the list arrives.
	private fontDefinition(): SettingDefinitionItem {
		const fonts = cachedSystemFonts;
		if (!fonts) {
			// iOS/iPadOS can't enumerate fonts: offer the standard system
			// fonts as suggestions while still allowing a custom name.
			if (Platform.isIosApp) {
				return {
					name: "Font",
					desc: IOS_FONT_DESC,
					render: (setting) =>
						this.addFontSuggestInput(setting, IOS_SYSTEM_FONTS),
				};
			}
			if (!this.fontsRequested) {
				this.fontsRequested = true;
				void getSystemFonts().then((families) => {
					if (families.length) this.refreshTab();
				});
			}
			return {
				name: "Font",
				desc:
					"Font family for book text. " +
					"Leave empty to use the Obsidian theme font.",
				control: {
					type: "text",
					key: "fontFamily",
					placeholder: "Same as Obsidian",
				},
			};
		}
		const options: Record<string, string> = { "": "Same as Obsidian" };
		const current = this.plugin.fb2Settings.fontFamily;
		if (current && !fonts.includes(current)) options[current] = current;
		for (const family of fonts) options[family] = family;
		return {
			name: "Font",
			desc: "Font used for book text.",
			control: {
				type: "dropdown",
				key: "fontFamily",
				defaultValue: "",
				options,
			},
		};
	}

	// Font input backed by a <datalist>: a dropdown of the given suggestions
	// that still accepts any typed value. Used on iOS/iPadOS, where the
	// installed fonts can't be queried.
	private addFontSuggestInput(setting: Setting, suggestions: string[]): void {
		setting.addText((text) => {
			text
				.setPlaceholder("Same as Obsidian")
				.setValue(this.plugin.fb2Settings.fontFamily)
				.onChange((value) => {
					this.plugin.fb2Settings.fontFamily = value.trim();
					this.plugin.saveSettings();
				});
			const input = text.inputEl;
			const host = input.parentElement;
			if (!host) return;
			const datalist = host.createEl("datalist", {
				attr: { id: "fb2-font-suggestions" },
			});
			for (const family of suggestions) {
				datalist.createEl("option").value = family;
			}
			input.setAttribute("list", datalist.id);
		});
	}

	// --- Imperative fallback for Obsidian older than 1.13 ---

	display(): void {
		// render is async (it awaits the font list); fire and forget.
		void this.render();
	}

	// Helper: a numeric field accepting only values within [min, max].
	// Used twice — for font size and line height.
	private addNumberSetting(
		name: string,
		desc: string,
		min: number,
		max: number,
		step: string,
		getValue: () => number,
		setValue: (n: number) => void
	) {
		new Setting(this.containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(min);
				text.inputEl.max = String(max);
				text.inputEl.step = step;
				text.setValue(String(getValue())).onChange((value) => {
					const n = Number(value);
					// Not a number or out of range — simply don't save.
					if (!Number.isFinite(n) || n < min || n > max) return;
					setValue(n);
					this.plugin.saveSettings();
				});
			});
	}

	private async render(): Promise<void> {
		const token = ++this.renderToken;
		const fonts = await getSystemFonts();
		// While we were awaiting the font list the user may have closed and
		// reopened the settings, starting a newer render. If our token is
		// no longer the latest, quietly yield to the newer one.
		if (token !== this.renderToken) return;

		const { containerEl } = this;
		containerEl.empty();

		// Reader color theme.
		new Setting(containerEl)
			.setName("Theme")
			.setDesc("Color scheme for the reading area.")
			.addDropdown((dd) =>
				dd
					.addOption("", "Same as Obsidian")
					.addOption("light", "Light")
					.addOption("dark", "Dark")
					.addOption("sepia", "Sepia")
					.addOption("solarized-dark", "Solarized dark")
					.setValue(this.plugin.fb2Settings.theme)
					.onChange((value) => {
						this.plugin.fb2Settings.theme = value as Fb2Theme;
						this.plugin.saveSettings();
					})
			);

		// Reading layout: continuous scroll or page-by-page.
		new Setting(containerEl)
			.setName("Reading mode")
			.setDesc("Continuous scroll, or turn one page at a time.")
			.addDropdown((dd) =>
				dd
					.addOption("scroll", "Scroll (infinite page)")
					.addOption("paged", "Paged")
					.setValue(this.plugin.fb2Settings.readingMode)
					.onChange((value) => {
						this.plugin.fb2Settings.readingMode = value as ReadingMode;
						this.plugin.saveSettings();
					})
			);

		// Text color: presets from TEXT_COLORS. If the saved color is not in
		// the list (e.g. hand-edited in data.json), add it as an extra option
		// so the selection doesn't get lost.
		new Setting(containerEl)
			.setName("Text color")
			.setDesc("Color of the main book text. Default follows the theme.")
			.addDropdown((dd) => {
				const current = this.plugin.fb2Settings.textColor;
				if (current && !(current in TEXT_COLORS)) {
					dd.addOption(current, current);
				}
				for (const [value, label] of Object.entries(TEXT_COLORS)) {
					dd.addOption(value, label);
				}
				dd.setValue(current).onChange((value) => {
					this.plugin.fb2Settings.textColor = value;
					this.plugin.saveSettings();
				});
			});

		// Font: a dropdown when the system font list is available; on
		// iOS/iPadOS a text field with a datalist of standard system fonts;
		// otherwise (no permission, unsupported platform) a plain text field.
		const fontSetting = new Setting(containerEl).setName("Font");
		if (fonts.length) {
			fontSetting.setDesc("Font used for book text.").addDropdown((dd) => {
				dd.addOption("", "Same as Obsidian");
				const current = this.plugin.fb2Settings.fontFamily;
				if (current && !fonts.includes(current)) {
					dd.addOption(current, current);
				}
				for (const family of fonts) dd.addOption(family, family);
				dd.setValue(current).onChange((value) => {
					this.plugin.fb2Settings.fontFamily = value;
					this.plugin.saveSettings();
				});
			});
		} else if (Platform.isIosApp) {
			// iOS/iPadOS can't enumerate fonts: offer the standard system
			// fonts as suggestions while still allowing a custom name.
			fontSetting.setDesc(IOS_FONT_DESC);
			this.addFontSuggestInput(fontSetting, IOS_SYSTEM_FONTS);
		} else {
			fontSetting
				.setDesc(
					"System font list is unavailable; type a font family name. " +
						"Leave empty to use the Obsidian theme font."
				)
				.addText((text) =>
					text
						.setPlaceholder("Same as Obsidian")
						.setValue(this.plugin.fb2Settings.fontFamily)
						.onChange((value) => {
							this.plugin.fb2Settings.fontFamily = value.trim();
							this.plugin.saveSettings();
						})
				);
		}

		this.addNumberSetting(
			"Font size",
			"Book text size in pixels (8–72).",
			8,
			72,
			"1",
			() => this.plugin.fb2Settings.fontSize,
			(n) => (this.plugin.fb2Settings.fontSize = n)
		);

		this.addNumberSetting(
			"Line height",
			"Line spacing multiplier (1–3), e.g. 1.5.",
			1,
			3,
			"0.05",
			() => this.plugin.fb2Settings.lineHeight,
			(n) => (this.plugin.fb2Settings.lineHeight = n)
		);

		// Reset button: restore defaults and re-render the tab so the
		// controls show the new values.
		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Reset to defaults").onClick(() => {
				Object.assign(this.plugin.fb2Settings, DEFAULT_SETTINGS);
				this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
