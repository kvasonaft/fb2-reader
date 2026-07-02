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

interface Fb2Data {
	positions: Record<string, ReadingPosition>;
	settings: Fb2Settings;
}

function detectEncoding(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf.slice(0, 4));
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	const head = new TextDecoder("latin1").decode(buf.slice(0, 512));
	const m = head.match(/encoding=["']([\w-]+)["']/i);
	return m ? m[1].toLowerCase() : "utf-8";
}

function decodeFb2(buf: ArrayBuffer): string {
	const encoding = detectEncoding(buf);
	try {
		return new TextDecoder(encoding).decode(buf);
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
	try {
		const query = (
			window as unknown as {
				queryLocalFonts?: () => Promise<{ family: string }[]>;
			}
		).queryLocalFonts;
		if (!query) return [];
		const fonts: { family: string }[] = await query.call(window);
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

		const bodies = Array.from(doc.querySelectorAll("FictionBook > body"));
		for (const body of bodies) {
			const isNotes = body.getAttribute("name") === "notes";
			this.collectToc = !isNotes;
			const bodyEl = root.createDiv({
				cls: isNotes ? "fb2-body fb2-notes" : "fb2-body",
			});
			if (isNotes) bodyEl.createEl("hr");
			for (const child of Array.from(body.children)) {
				this.renderBlock(child, bodyEl, 1);
			}
		}
		this.collectToc = false;

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
			const annEl = header.createDiv({ cls: "fb2-annotation" });
			for (const child of Array.from(annotation.children)) {
				this.renderBlock(child, annEl, 1);
			}
		}
	}

	private renderBlock(el: Element, parent: HTMLElement, depth: number) {
		const tag = el.localName;
		switch (tag) {
			case "section": {
				const section = parent.createDiv({ cls: "fb2-section" });
				const id = el.getAttribute("id");
				if (id) section.setAttribute("data-fb2-id", id);
				for (const child of Array.from(el.children)) {
					this.renderBlock(child, section, depth + 1);
				}
				break;
			}
			case "title": {
				const level = Math.min(depth + 1, 6);
				const heading = parent.createEl(`h${level}` as keyof HTMLElementTagNameMap, {
					cls: "fb2-title",
				});
				for (const child of Array.from(el.children)) {
					if (child.localName === "p") {
						if (heading.childNodes.length) heading.createEl("br");
						this.renderInlineChildren(child, heading);
					}
				}
				if (this.collectToc) {
					const text = Array.from(el.children)
						.filter((c) => c.localName === "p")
						.map((c) => c.textContent?.trim() ?? "")
						.filter(Boolean)
						.join(" ");
					this.tocItems.push({ text, depth, el: heading });
				}
				break;
			}
			case "p": {
				const p = parent.createEl("p", { cls: "fb2-p" });
				const id = el.getAttribute("id");
				if (id) p.setAttribute("data-fb2-id", id);
				this.renderInlineChildren(el, p);
				break;
			}
			case "empty-line":
				parent.createDiv({ cls: "fb2-empty-line" });
				break;
			case "subtitle":
				this.renderInlineChildren(
					el,
					parent.createEl("p", { cls: "fb2-subtitle" })
				);
				break;
			case "image":
				this.renderImage(el, parent, "fb2-image-block");
				break;
			case "epigraph": {
				const ep = parent.createDiv({ cls: "fb2-epigraph" });
				for (const child of Array.from(el.children)) {
					this.renderBlock(child, ep, depth);
				}
				break;
			}
			case "cite": {
				const cite = parent.createEl("blockquote", { cls: "fb2-cite" });
				for (const child of Array.from(el.children)) {
					this.renderBlock(child, cite, depth);
				}
				break;
			}
			case "poem": {
				const poem = parent.createDiv({ cls: "fb2-poem" });
				for (const child of Array.from(el.children)) {
					this.renderBlock(child, poem, depth);
				}
				break;
			}
			case "stanza": {
				const stanza = parent.createDiv({ cls: "fb2-stanza" });
				for (const child of Array.from(el.children)) {
					this.renderBlock(child, stanza, depth);
				}
				break;
			}
			case "v":
				this.renderInlineChildren(
					el,
					parent.createEl("p", { cls: "fb2-verse" })
				);
				break;
			case "text-author":
				this.renderInlineChildren(
					el,
					parent.createEl("p", { cls: "fb2-text-author" })
				);
				break;
			case "annotation": {
				const ann = parent.createDiv({ cls: "fb2-annotation" });
				for (const child of Array.from(el.children)) {
					this.renderBlock(child, ann, depth);
				}
				break;
			}
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
			default: {
				// Unknown container: recurse so nested known blocks still render.
				for (const child of Array.from(el.children)) {
					this.renderBlock(child, parent, depth);
				}
			}
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
		switch (el.localName) {
			case "strong":
				this.renderInlineChildren(el, parent.createEl("strong"));
				break;
			case "emphasis":
				this.renderInlineChildren(el, parent.createEl("em"));
				break;
			case "strikethrough":
				this.renderInlineChildren(el, parent.createEl("s"));
				break;
			case "sub":
				this.renderInlineChildren(el, parent.createEl("sub"));
				break;
			case "sup":
				this.renderInlineChildren(el, parent.createEl("sup"));
				break;
			case "code":
				this.renderInlineChildren(el, parent.createEl("code"));
				break;
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
			const setting = (
				this.app as unknown as {
					setting: { open(): void; openTabById(id: string): void };
				}
			).setting;
			setting.open();
			setting.openTabById(this.manifest.id);
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

class Fb2SettingTab extends PluginSettingTab {
	private plugin: Fb2ReaderPlugin;

	constructor(app: App, plugin: Fb2ReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private renderToken = 0;

	display(): void {
		void this.render();
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

		new Setting(containerEl)
			.setName("Font size")
			.setDesc("Book text size in pixels (8–72).")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "8";
				text.inputEl.max = "72";
				text
					.setValue(String(this.plugin.fb2Settings.fontSize))
					.onChange((value) => {
						const n = Number(value);
						if (!Number.isFinite(n) || n < 8 || n > 72) return;
						this.plugin.fb2Settings.fontSize = n;
						this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Line height")
			.setDesc("Line spacing multiplier (1–3), e.g. 1.65.")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = "1";
				text.inputEl.max = "3";
				text.inputEl.step = "0.05";
				text
					.setValue(String(this.plugin.fb2Settings.lineHeight))
					.onChange((value) => {
						const n = Number(value);
						if (!Number.isFinite(n) || n < 1 || n > 3) return;
						this.plugin.fb2Settings.lineHeight = n;
						this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Reset to defaults").onClick(() => {
				Object.assign(this.plugin.fb2Settings, DEFAULT_SETTINGS);
				this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
