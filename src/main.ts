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
 *   7. Fb2ReaderPlugin — the conductor: registers the views,
 *      stores settings and reading positions.
 *   8. Fb2SettingTab — the plugin settings tab.
 */

import {
	App,
	base64ToArrayBuffer,
	debounce,
	FileView,
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from "obsidian";

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
type Fb2Theme = "" | "light" | "dark" | "sepia";

// All user-facing plugin settings.
interface Fb2Settings {
	fontFamily: string; // font ("" = same as Obsidian)
	fontSize: number; // font size in pixels
	lineHeight: number; // line spacing multiplier
	theme: Fb2Theme; // reader color theme
	textColor: string; // text color ("" = follow the theme)
	dropCaps: boolean; // large initial letter at chapter openings
}

// Everything the plugin persists to disk (Obsidian stores it in data.json).
interface Fb2Data {
	positions: Record<string, ReadingPosition>; // file path → reading position
	settings: Fb2Settings;
}

// Defaults used on first run and by the "Reset to defaults" button.
const DEFAULT_SETTINGS: Fb2Settings = {
	fontFamily: "",
	fontSize: 17,
	lineHeight: 1.65,
	theme: "",
	textColor: "",
	dropCaps: false,
};

// Text color presets for the settings dropdown: "color code → label".
const TEXT_COLORS: Record<string, string> = {
	"": "Default (theme)",
	"#000000": "Black",
	"#333333": "Charcoal",
	"#555555": "Dark gray",
	"#707070": "Medium gray",
	"#8a8a8a": "Gray",
	"#a6a6a6": "Silver gray",
	"#c4c4c4": "Light gray",
	"#e2e2e2": "Off-white",
	"#5b4636": "Sepia brown",
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
	private jumpOrigin: HTMLElement | null = null; // link that started the last footnote jump
	private renderQueue: RenderJob[] = []; // blocks still waiting to be rendered
	private renderPass = 0; // bumping this cancels an in-flight render
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
		const container = this.contentEl;
		container.empty();
		container.addClass("fb2-reader"); // CSS class the styles target
		this.tocItems = [];

		// Step 1: read the file from the vault as bytes.
		const buf = await this.app.vault.readBinary(file);

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
		this.renderBook(doc, container.createDiv({ cls: "fb2-book" }));
		this.plugin.onFb2Opened(this);
	}

	// Called when the file is closed: save the position and clean up
	// so a large book is not kept in memory.
	async onUnloadFile(file: TFile): Promise<void> {
		this.renderPass++; // cancel a render that may still be in flight
		this.renderQueue = [];
		this.saveReadingPosition(file);
		this.plugin.clearTocFor(this);
		this.clearBinaries();
		this.tocItems = [];
		this.bookTitle = "";
		this.jumpOrigin = null;
		this.contentEl.empty();
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

	// Save the position: find the first block visible on screen (its bottom
	// edge below the top of the viewport) and remember its index.
	private saveReadingPosition(file = this.file) {
		if (!file) return;
		const scroller = this.contentEl;
		if (scroller.scrollTop <= 0) return; // at the very beginning — nothing to save
		const top = scroller.getBoundingClientRect().top;
		const index = this.getScrollBlocks().findIndex(
			(b) => b.getBoundingClientRect().bottom > top
		);
		if (index >= 0) this.plugin.setPosition(file.path, index);
	}

	// Restore the position: scroll to the block with the saved index.
	private restoreReadingPosition(path: string) {
		const pos = this.plugin.getPosition(path);
		if (!pos || pos.index <= 0) return;
		// By the next animation frame the browser has laid out all elements.
		requestAnimationFrame(() => {
			const blocks = this.getScrollBlocks();
			const target = blocks[Math.min(pos.index, blocks.length - 1)];
			target?.scrollIntoView({ block: "start" });
		});
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

		for (const body of Array.from(doc.querySelectorAll("FictionBook > body"))) {
			// <body name="notes"> holds footnotes; keep their headings out of the TOC.
			const isNotes = body.getAttribute("name") === "notes";
			const bodyEl = root.createDiv({
				cls: isNotes ? "fb2-body fb2-notes" : "fb2-body",
			});
			if (isNotes) bodyEl.createEl("hr"); // divider before the footnotes
			this.renderQueue.push(...this.childJobs(body, bodyEl, 1, !isNotes));
		}

		// A single click handler for the whole book serves internal links
		// (footnotes and cross-references): find the element with the matching
		// data-fb2-id and smooth-scroll to it. The jump leaves a "↩" back link
		// at the destination so the reader can return to where they were.
		root.addEventListener("click", (evt) => {
			const clicked = evt.target as HTMLElement;

			const back = clicked.closest(".fb2-backref");
			if (back) {
				evt.preventDefault();
				this.jumpOrigin?.scrollIntoView({ behavior: "smooth", block: "center" });
				this.jumpOrigin = null;
				back.remove();
				return;
			}

			const link = clicked.closest("a[data-fb2-target]");
			if (!link) return;
			evt.preventDefault();
			const target = link.getAttribute("data-fb2-target");
			const dest = root.querySelector(
				`[data-fb2-id="${CSS.escape(target ?? "")}"]`
			);
			if (!(dest instanceof HTMLElement)) return;
			root.querySelector(".fb2-backref")?.remove(); // only one back link at a time
			this.jumpOrigin = link as HTMLElement;
			dest.createEl("a", {
				cls: "fb2-backref",
				text: "↩",
				attr: { href: "#", "aria-label": "Back to text" },
			});
			dest.scrollIntoView({ behavior: "smooth", block: "start" });
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
				requestAnimationFrame(() => {
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
		this.plugin.updateToc(this);
		if (this.file) this.restoreReadingPosition(this.file.path);
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
					const text = child.textContent?.trim();
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
				// A footnote (type="note") is wrapped in <sup> so its number
				// renders as a small superscript.
				const isNote = el.getAttribute("type") === "note";
				const host = isNote ? parent.createEl("sup") : parent;
				const anchor = host.createEl("a", { cls: "fb2-link" });
				if (href.startsWith("#")) {
					// Internal link (footnote or chapter): store the target in
					// data-fb2-target — clicks are handled in renderBook.
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
		return "list";
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
			const row = el.createDiv({
				cls: "fb2-toc-item",
				text: item.text || "(untitled)",
			});
			// Indentation grows with depth to show chapter nesting.
			row.style.paddingLeft = `${(item.depth - 1) * 14 + 6}px`;
			// Click: reveal the book tab and scroll to the chapter.
			row.addEventListener("click", () => {
				const src = this.source;
				if (!src) return;
				void this.app.workspace.revealLeaf(src.leaf);
				item.el.scrollIntoView({ behavior: "smooth", block: "start" });
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
	// All plugin data (settings + reading positions).
	private data: Fb2Data = { positions: {}, settings: { ...DEFAULT_SETTINGS } };
	// Deferred saving: write to disk at most once per 2 seconds.
	private saveDataDebounced = debounce(() => this.saveData(this.data), 2000, true);

	async onload() {
		// Load persisted data (data.json). Object.assign layers the stored
		// settings over the defaults, so fields added in a plugin update
		// still get values.
		const stored = (await this.loadData()) ?? {};
		this.data = {
			positions: stored.positions ?? {},
			settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings),
		};
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
	}

	// Called when the plugin is disabled: save data and remove every trace
	// of our settings from <body> (CSS variables and theme classes).
	onunload() {
		void this.saveData(this.data);
		const body = document.body;
		body.style.removeProperty("--fb2-font-family");
		body.style.removeProperty("--fb2-font-size");
		body.style.removeProperty("--fb2-line-height");
		body.style.removeProperty("--fb2-text-color");
		body.removeClass(
			"fb2-theme-dark",
			"fb2-theme-light",
			"fb2-theme-sepia",
			"fb2-dropcaps"
		);
	}

	// --- Settings ---

	get fb2Settings(): Fb2Settings {
		return this.data.settings;
	}

	// Applies the settings to the page by writing them into CSS variables
	// on <body>; styles.css reads them and styles the book. This keeps the
	// code and the styling decoupled.
	applySettings() {
		const s = this.data.settings;
		const body = document.body;
		if (s.fontFamily) body.style.setProperty("--fb2-font-family", s.fontFamily);
		else body.style.removeProperty("--fb2-font-family");
		body.style.setProperty("--fb2-font-size", `${s.fontSize}px`);
		body.style.setProperty("--fb2-line-height", `${s.lineHeight}`);
		body.toggleClass("fb2-theme-dark", s.theme === "dark");
		body.toggleClass("fb2-theme-light", s.theme === "light");
		body.toggleClass("fb2-theme-sepia", s.theme === "sepia");
		body.toggleClass("fb2-dropcaps", s.dropCaps);
		if (s.textColor) body.style.setProperty("--fb2-text-color", s.textColor);
		else body.style.removeProperty("--fb2-text-color");
	}

	// Apply and (deferred) save — called from the settings tab.
	saveSettings() {
		this.applySettings();
		this.saveDataDebounced();
	}

	// --- Reading positions ---

	getPosition(path: string): ReadingPosition | undefined {
		return this.data.positions[path];
	}

	setPosition(path: string, index: number) {
		this.data.positions[path] = { index, ts: Date.now() };
		this.prunePositions();
		this.saveDataDebounced();
	}

	// Keep positions for the 300 most recent books only, so data.json
	// does not grow forever; the oldest entries are dropped.
	private prunePositions() {
		const entries = Object.entries(this.data.positions);
		if (entries.length <= 300) return;
		entries.sort((a, b) => b[1].ts - a[1].ts); // newest first
		this.data.positions = Object.fromEntries(entries.slice(0, 300));
	}

	// --- TOC panel ---

	// Called by the reader when it has opened a book: create the TOC panel
	// in the right sidebar if it does not exist yet, then refresh it.
	onFb2Opened(view: Fb2View) {
		this.app.workspace.onLayoutReady(async () => {
			if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC).length) {
				const leaf = this.app.workspace.getRightLeaf(false);
				await leaf?.setViewState({ type: VIEW_TYPE_TOC, active: false });
			}
			this.updateToc(view);
		});
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
// Obsidian calls display() every time the user opens the plugin settings.
// Each control's onChange updates plugin.fb2Settings and calls
// plugin.saveSettings(), so changes apply immediately.
// ---------------------------------------------------------------------------

class Fb2SettingTab extends PluginSettingTab {
	private plugin: Fb2ReaderPlugin;
	// Render counter — guards against a race (see the comment in render).
	private renderToken = 0;

	constructor(app: App, plugin: Fb2ReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

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
					.setValue(this.plugin.fb2Settings.theme)
					.onChange((value) => {
						this.plugin.fb2Settings.theme = value as Fb2Theme;
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

		// Font: a dropdown when the system font list is available, otherwise
		// (no permission, unsupported platform) a plain text field.
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
			"Line spacing multiplier (1–3), e.g. 1.65.",
			1,
			3,
			"0.05",
			() => this.plugin.fb2Settings.lineHeight,
			(n) => (this.plugin.fb2Settings.lineHeight = n)
		);

		new Setting(containerEl)
			.setName("Drop caps")
			.setDesc("Large initial letter at the first paragraph of each chapter.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.fb2Settings.dropCaps)
					.onChange((value) => {
						this.plugin.fb2Settings.dropCaps = value;
						this.plugin.saveSettings();
					})
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
