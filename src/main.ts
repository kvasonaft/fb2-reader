import {
	App,
	debounce,
	FileView,
	ItemView,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	WorkspaceLeaf,
} from "obsidian";
import { unzipSync } from "fflate";

const VIEW_TYPE_FB2 = "fb2-reader-view";
const VIEW_TYPE_TOC = "fb2-reader-toc";
const XLINK_NS = "http://www.w3.org/1999/xlink";

// ---------------------------------------------------------------------------
// Types and defaults
// ---------------------------------------------------------------------------

interface TocItem {
	text: string;
	depth: number;
	el: HTMLElement;
}

interface ReadingPosition {
	index: number;
	ts: number;
}

type Fb2Theme = "" | "light" | "dark" | "sepia";

interface Fb2Settings {
	fontFamily: string;
	fontSize: number;
	lineHeight: number;
	theme: Fb2Theme;
	textColor: string;
}

interface Fb2Data {
	positions: Record<string, ReadingPosition>;
	settings: Fb2Settings;
}

const DEFAULT_SETTINGS: Fb2Settings = {
	fontFamily: "",
	fontSize: 17,
	lineHeight: 1.65,
	theme: "",
	textColor: "",
};

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
// FB2 tag → HTML mapping tables
// ---------------------------------------------------------------------------

// Block-level FB2 tags that become a plain container; children are rendered
// inside it as blocks. Only <section> increases the nesting depth.
const BLOCK_CONTAINERS: Record<string, { tag: "div" | "blockquote"; cls: string }> = {
	section: { tag: "div", cls: "fb2-section" },
	epigraph: { tag: "div", cls: "fb2-epigraph" },
	poem: { tag: "div", cls: "fb2-poem" },
	stanza: { tag: "div", cls: "fb2-stanza" },
	annotation: { tag: "div", cls: "fb2-annotation" },
	cite: { tag: "blockquote", cls: "fb2-cite" },
};

// Block-level FB2 tags that become a paragraph with inline content.
const BLOCK_PARAGRAPHS: Record<string, string> = {
	p: "fb2-p",
	subtitle: "fb2-subtitle",
	v: "fb2-verse",
	"text-author": "fb2-text-author",
};

// Inline FB2 tags that map directly to an HTML tag.
const INLINE_TAGS: Record<string, keyof HTMLElementTagNameMap> = {
	strong: "strong",
	emphasis: "em",
	strikethrough: "s",
	sub: "sub",
	sup: "sup",
	code: "code",
};

// ---------------------------------------------------------------------------
// File decoding helpers
// ---------------------------------------------------------------------------

function detectEncoding(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf.slice(0, 4));
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	const head = new TextDecoder("latin1").decode(buf.slice(0, 512));
	const m = head.match(/encoding=["']([\w-]+)["']/i);
	return m ? m[1].toLowerCase() : "utf-8";
}

function decodeFb2(buf: ArrayBuffer): string {
	try {
		return new TextDecoder(detectEncoding(buf)).decode(buf);
	} catch {
		return new TextDecoder("utf-8").decode(buf);
	}
}

function extractFb2FromZip(buf: ArrayBuffer): ArrayBuffer | null {
	let entries: Record<string, Uint8Array>;
	try {
		entries = unzipSync(new Uint8Array(buf), {
			filter: (f) => f.name.toLowerCase().endsWith(".fb2"),
		});
	} catch {
		return null;
	}
	const name = Object.keys(entries)[0];
	if (!name) return null;
	const data = entries[name];
	return data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength
	) as ArrayBuffer;
}

let cachedSystemFonts: string[] | null = null;

async function getSystemFonts(): Promise<string[]> {
	if (cachedSystemFonts) return cachedSystemFonts;
	const queryLocalFonts = (
		window as { queryLocalFonts?: () => Promise<{ family: string }[]> }
	).queryLocalFonts;
	if (!queryLocalFonts) return [];
	try {
		const fonts: { family: string }[] = await queryLocalFonts.call(window);
		const families = Array.from(new Set(fonts.map((f) => f.family))).sort(
			(a, b) => a.localeCompare(b)
		);
		if (families.length) cachedSystemFonts = families;
		return families;
	} catch {
		return [];
	}
}

function getHref(el: Element): string | null {
	return (
		el.getAttributeNS(XLINK_NS, "href") ??
		el.getAttribute("l:href") ??
		el.getAttribute("xlink:href") ??
		el.getAttribute("href")
	);
}

// Copy the FB2 "id" attribute so internal links can find this element later.
function copyId(from: Element, to: HTMLElement) {
	const id = from.getAttribute("id");
	if (id) to.setAttribute("data-fb2-id", id);
}

// ---------------------------------------------------------------------------
// The reader view: renders one FB2 book
// ---------------------------------------------------------------------------

class Fb2View extends FileView {
	tocItems: TocItem[] = [];

	private plugin: Fb2ReaderPlugin;
	private bookTitle = "";
	private binaries = new Map<string, string>();
	private collectToc = false;
	private savePositionDebounced = debounce(
		() => this.saveReadingPosition(),
		800,
		true
	);

	constructor(leaf: WorkspaceLeaf, plugin: Fb2ReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.navigation = true;
	}

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
		return this.bookTitle || this.file?.basename || "FB2";
	}

	getIcon(): string {
		return "book-open";
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "fb2" || extension === "zip";
	}

	async onLoadFile(file: TFile): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("fb2-reader");
		this.tocItems = [];

		let buf = await this.app.vault.readBinary(file);
		if (file.extension === "zip") {
			const extracted = extractFb2FromZip(buf);
			if (!extracted) {
				container.createEl("p", {
					text: "No .fb2 file found in this archive.",
					cls: "fb2-error",
				});
				this.plugin.onFb2Opened(this);
				return;
			}
			buf = extracted;
		}

		const xml = decodeFb2(buf);
		const doc = new DOMParser().parseFromString(xml, "application/xml");

		if (doc.querySelector("parsererror")) {
			container.createEl("p", {
				text: "Failed to parse the file: invalid XML.",
				cls: "fb2-error",
			});
			return;
		}

		this.collectBinaries(doc);
		this.renderBook(doc, container.createDiv({ cls: "fb2-book" }));
		this.plugin.onFb2Opened(this);
		this.restoreReadingPosition(file.path);
	}

	async onUnloadFile(file: TFile): Promise<void> {
		this.saveReadingPosition(file);
		this.plugin.clearTocFor(this);
		this.binaries.clear();
		this.tocItems = [];
		this.bookTitle = "";
		this.contentEl.empty();
	}

	// --- reading position ---

	private getScrollBlocks(): HTMLElement[] {
		return Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(
				".fb2-p, .fb2-title, .fb2-subtitle, .fb2-verse, .fb2-image-block"
			)
		);
	}

	private saveReadingPosition(file = this.file) {
		if (!file) return;
		const scroller = this.contentEl;
		if (scroller.scrollTop <= 0) return;
		const top = scroller.getBoundingClientRect().top;
		const index = this.getScrollBlocks().findIndex(
			(b) => b.getBoundingClientRect().bottom > top
		);
		if (index >= 0) this.plugin.setPosition(file.path, index);
	}

	private restoreReadingPosition(path: string) {
		const pos = this.plugin.getPosition(path);
		if (!pos || pos.index <= 0) return;
		requestAnimationFrame(() => {
			const blocks = this.getScrollBlocks();
			const target = blocks[Math.min(pos.index, blocks.length - 1)];
			target?.scrollIntoView({ block: "start" });
		});
	}

	// --- rendering ---

	private collectBinaries(doc: Document) {
		this.binaries.clear();
		for (const bin of Array.from(doc.getElementsByTagName("binary"))) {
			const id = bin.getAttribute("id");
			if (!id) continue;
			const type = bin.getAttribute("content-type") || "image/jpeg";
			const data = (bin.textContent || "").replace(/\s+/g, "");
			this.binaries.set(id, `data:${type};base64,${data}`);
		}
	}

	private renderBook(doc: Document, root: HTMLElement) {
		const titleInfo = doc.querySelector("description > title-info");
		this.collectToc = false;
		if (titleInfo) this.renderTitleInfo(titleInfo, root);

		for (const body of Array.from(doc.querySelectorAll("FictionBook > body"))) {
			const isNotes = body.getAttribute("name") === "notes";
			this.collectToc = !isNotes;
			const bodyEl = root.createDiv({
				cls: isNotes ? "fb2-body fb2-notes" : "fb2-body",
			});
			if (isNotes) bodyEl.createEl("hr");
			this.renderBlockChildren(body, bodyEl, 1);
		}
		this.collectToc = false;

		// One click handler for all internal links (notes, cross-references).
		root.addEventListener("click", (evt) => {
			const link = (evt.target as HTMLElement).closest("a[data-fb2-target]");
			if (!link) return;
			evt.preventDefault();
			const target = link.getAttribute("data-fb2-target");
			const dest = root.querySelector(
				`[data-fb2-id="${CSS.escape(target ?? "")}"]`
			);
			dest?.scrollIntoView({ behavior: "smooth", block: "start" });
		});
	}

	private renderTitleInfo(info: Element, root: HTMLElement) {
		const header = root.createDiv({ cls: "fb2-title-page" });

		const coverImage = info.querySelector("coverpage > image");
		if (coverImage) this.renderImage(coverImage, header, "fb2-cover");

		const title = info.querySelector("book-title")?.textContent?.trim();
		if (title) {
			this.bookTitle = title;
			header.createEl("h1", { text: title, cls: "fb2-book-title" });
		}

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
			this.renderBlockChildren(
				annotation,
				header.createDiv({ cls: "fb2-annotation" }),
				1
			);
		}
	}

	private renderBlockChildren(el: Element, parent: HTMLElement, depth: number) {
		for (const child of Array.from(el.children)) {
			this.renderBlock(child, parent, depth);
		}
	}

	private renderBlock(el: Element, parent: HTMLElement, depth: number) {
		const tag = el.localName;

		const container = BLOCK_CONTAINERS[tag];
		if (container) {
			const box = parent.createEl(container.tag, { cls: container.cls });
			copyId(el, box);
			this.renderBlockChildren(
				el,
				box,
				tag === "section" ? depth + 1 : depth
			);
			return;
		}

		const paragraphCls = BLOCK_PARAGRAPHS[tag];
		if (paragraphCls) {
			const p = parent.createEl("p", { cls: paragraphCls });
			copyId(el, p);
			this.renderInlineChildren(el, p);
			return;
		}

		switch (tag) {
			case "title": {
				const level = Math.min(depth + 1, 6);
				const heading = parent.createEl(
					`h${level}` as keyof HTMLElementTagNameMap,
					{ cls: "fb2-title" }
				);
				const tocText: string[] = [];
				for (const child of Array.from(el.children)) {
					if (child.localName !== "p") continue;
					if (heading.childNodes.length) heading.createEl("br");
					this.renderInlineChildren(child, heading);
					const text = child.textContent?.trim();
					if (text) tocText.push(text);
				}
				if (this.collectToc) {
					this.tocItems.push({ text: tocText.join(" "), depth, el: heading });
				}
				break;
			}
			case "empty-line":
				parent.createDiv({ cls: "fb2-empty-line" });
				break;
			case "image":
				this.renderImage(el, parent, "fb2-image-block");
				break;
			case "table": {
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
				// Unknown container: recurse so nested known blocks still render.
				this.renderBlockChildren(el, parent, depth);
		}
	}

	private renderInlineChildren(el: Element, parent: HTMLElement) {
		for (const node of Array.from(el.childNodes)) {
			this.renderInline(node, parent);
		}
	}

	private renderInline(node: Node, parent: HTMLElement) {
		if (node.nodeType === Node.TEXT_NODE) {
			parent.appendText(node.textContent ?? "");
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as Element;
		const tag = el.localName;

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
				const isNote = el.getAttribute("type") === "note";
				const host = isNote ? parent.createEl("sup") : parent;
				const anchor = host.createEl("a", { cls: "fb2-link" });
				if (href.startsWith("#")) {
					anchor.setAttribute("data-fb2-target", href.slice(1));
					anchor.setAttribute("href", "#");
				} else {
					anchor.setAttribute("href", href);
				}
				this.renderInlineChildren(el, anchor);
				break;
			}
			default:
				this.renderInlineChildren(el, parent);
		}
	}

	private renderImage(el: Element, parent: HTMLElement, cls: string) {
		const href = getHref(el);
		if (!href || !href.startsWith("#")) return;
		const src = this.binaries.get(href.slice(1));
		if (!src) return;
		const img = parent.createEl("img", { cls });
		img.src = src;
		const alt = el.getAttribute("alt");
		if (alt) img.alt = alt;
	}
}

// ---------------------------------------------------------------------------
// The table-of-contents side panel
// ---------------------------------------------------------------------------

class Fb2TocView extends ItemView {
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

	sourceIs(view: Fb2View): boolean {
		return this.source === view;
	}

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

		el.createDiv({ cls: "fb2-toc-book", text: this.source.getDisplayText() });
		for (const item of this.source.tocItems) {
			const row = el.createDiv({
				cls: "fb2-toc-item",
				text: item.text || "(untitled)",
			});
			row.style.paddingLeft = `${(item.depth - 1) * 14 + 6}px`;
			row.addEventListener("click", () => {
				const src = this.source;
				if (!src) return;
				this.app.workspace.revealLeaf(src.leaf);
				item.el.scrollIntoView({ behavior: "smooth", block: "start" });
			});
		}
	}
}

// ---------------------------------------------------------------------------
// The plugin: wires everything together, stores settings and positions
// ---------------------------------------------------------------------------

export default class Fb2ReaderPlugin extends Plugin {
	private data: Fb2Data = { positions: {}, settings: { ...DEFAULT_SETTINGS } };
	private saveDataDebounced = debounce(() => this.saveData(this.data), 2000, true);

	async onload() {
		const stored = (await this.loadData()) ?? {};
		this.data = {
			positions: stored.positions ?? {},
			settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings),
		};
		this.applySettings();

		this.registerView(VIEW_TYPE_FB2, (leaf) => new Fb2View(leaf, this));
		this.registerView(VIEW_TYPE_TOC, (leaf) => new Fb2TocView(leaf));
		this.registerExtensions(["fb2", "zip"], VIEW_TYPE_FB2);
		this.addSettingTab(new Fb2SettingTab(this.app, this));

		this.addRibbonIcon("book-open-text", "FB2 Reader settings", () => {
			// "setting" is an undocumented part of the Obsidian API, so the
			// App type has to be widened by hand.
			const appSetting = (
				this.app as App & {
					setting: { open(): void; openTabById(id: string): void };
				}
			).setting;
			appSetting.open();
			appSetting.openTabById(this.manifest.id);
		});

		this.addCommand({
			id: "open-toc",
			name: "Open table of contents",
			callback: () => this.activateTocLeaf(),
		});

		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof Fb2View) this.updateToc(leaf.view);
			})
		);
	}

	onunload() {
		void this.saveData(this.data);
		const body = document.body;
		body.style.removeProperty("--fb2-font-family");
		body.style.removeProperty("--fb2-font-size");
		body.style.removeProperty("--fb2-line-height");
		body.style.removeProperty("--fb2-text-color");
		body.removeClass("fb2-theme-dark", "fb2-theme-light", "fb2-theme-sepia");
	}

	// --- settings ---

	get fb2Settings(): Fb2Settings {
		return this.data.settings;
	}

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
		if (s.textColor) body.style.setProperty("--fb2-text-color", s.textColor);
		else body.style.removeProperty("--fb2-text-color");
	}

	saveSettings() {
		this.applySettings();
		this.saveDataDebounced();
	}

	// --- reading positions ---

	getPosition(path: string): ReadingPosition | undefined {
		return this.data.positions[path];
	}

	setPosition(path: string, index: number) {
		this.data.positions[path] = { index, ts: Date.now() };
		this.prunePositions();
		this.saveDataDebounced();
	}

	private prunePositions() {
		const entries = Object.entries(this.data.positions);
		if (entries.length <= 300) return;
		entries.sort((a, b) => b[1].ts - a[1].ts);
		this.data.positions = Object.fromEntries(entries.slice(0, 300));
	}

	// --- table of contents ---

	onFb2Opened(view: Fb2View) {
		this.app.workspace.onLayoutReady(async () => {
			if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC).length) {
				const leaf = this.app.workspace.getRightLeaf(false);
				await leaf?.setViewState({ type: VIEW_TYPE_TOC, active: false });
			}
			this.updateToc(view);
		});
	}

	updateToc(view: Fb2View | null) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
			if (leaf.view instanceof Fb2TocView) leaf.view.setSource(view);
		}
	}

	clearTocFor(view: Fb2View) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
			if (leaf.view instanceof Fb2TocView && leaf.view.sourceIs(view)) {
				leaf.view.setSource(null);
			}
		}
	}

	private async activateTocLeaf() {
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: VIEW_TYPE_TOC, active: true });
			leaf = right;
		}
		this.app.workspace.revealLeaf(leaf);
		const active = this.app.workspace.getActiveViewOfType(Fb2View);
		if (active) this.updateToc(active);
	}
}

// ---------------------------------------------------------------------------
// The settings tab
// ---------------------------------------------------------------------------

class Fb2SettingTab extends PluginSettingTab {
	private plugin: Fb2ReaderPlugin;
	private renderToken = 0;

	constructor(app: App, plugin: Fb2ReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		void this.render();
	}

	// Adds a numeric text field that only saves values inside [min, max].
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
					if (!Number.isFinite(n) || n < min || n > max) return;
					setValue(n);
					this.plugin.saveSettings();
				});
			});
	}

	private async render(): Promise<void> {
		const token = ++this.renderToken;
		const fonts = await getSystemFonts();
		// A newer render started while fonts were loading; let it win.
		if (token !== this.renderToken) return;

		const { containerEl } = this;
		containerEl.empty();

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

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Reset to defaults").onClick(() => {
				Object.assign(this.plugin.fb2Settings, DEFAULT_SETTINGS);
				this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
