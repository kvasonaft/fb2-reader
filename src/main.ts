/*
 * Это ЕДИНСТВЕННЫЙ файл с кодом плагина. Всё, что делает FB2 Reader,
 * описано здесь. Подробное руководство для начинающих — в файле GUIDE.md
 * в корне репозитория: там объясняются и язык TypeScript, и устройство
 * плагинов Obsidian, и логика этого файла раздел за разделом.
 *
 * Краткая карта файла (в порядке следования):
 *   1. Импорты — подключение готовых инструментов Obsidian и библиотеки fflate.
 *   2. Типы и настройки по умолчанию.
 *   3. Таблицы соответствий «тег FB2 → элемент HTML».
 *   4. Вспомогательные функции: определение кодировки, распаковка zip и т.п.
 *   5. Класс Fb2View — сама «читалка», превращает FB2-файл в страницу.
 *   6. Класс Fb2TocView — боковая панель с оглавлением.
 *   7. Класс Fb2ReaderPlugin — «дирижёр»: регистрирует читалку в Obsidian,
 *      хранит настройки и позиции чтения.
 *   8. Класс Fb2SettingTab — вкладка настроек плагина.
 */

// «import» подключает код из других модулей. Из пакета "obsidian" мы берём
// классы и функции, которые Obsidian предоставляет всем плагинам.
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
// fflate — маленькая библиотека для распаковки zip-архивов
// (FB2-книги часто распространяются в виде .fb2.zip).
import { unzipSync } from "fflate";

// «const» объявляет константу — значение, которое нельзя изменить.
// Эти два идентификатора — внутренние имена наших видов (окон) в Obsidian.
const VIEW_TYPE_FB2 = "fb2-reader-view";
const VIEW_TYPE_TOC = "fb2-reader-toc";
// Пространство имён XML для атрибутов вида xlink:href (ссылки внутри FB2).
const XLINK_NS = "http://www.w3.org/1999/xlink";

// ---------------------------------------------------------------------------
// Типы и значения по умолчанию
//
// «interface» — это описание ФОРМЫ объекта: какие у него поля и какого они
// типа. Интерфейсы существуют только на этапе проверки кода (TypeScript)
// и помогают ловить ошибки; в готовый main.js они не попадают.
// ---------------------------------------------------------------------------

// Один пункт оглавления книги.
interface TocItem {
	text: string; // текст заголовка главы
	depth: number; // глубина вложенности (глава, подглава, ...)
	el: HTMLElement; // сам HTML-элемент заголовка на странице — чтобы уметь к нему прокрутить
}

// Сохранённая позиция чтения в конкретной книге.
interface ReadingPosition {
	index: number; // номер абзаца, с которого продолжить чтение
	ts: number; // момент сохранения (нужен, чтобы удалять самые старые записи)
}

// Тема оформления: пустая строка означает «как в Obsidian».
type Fb2Theme = "" | "light" | "dark" | "sepia";

// Все настройки плагина, которые видит пользователь.
interface Fb2Settings {
	fontFamily: string; // шрифт ("" = как в Obsidian)
	fontSize: number; // размер шрифта в пикселях
	lineHeight: number; // межстрочный интервал (множитель)
	theme: Fb2Theme; // цветовая тема читалки
	textColor: string; // цвет текста ("" = по теме)
}

// Всё, что плагин сохраняет на диск (Obsidian кладёт это в data.json).
interface Fb2Data {
	positions: Record<string, ReadingPosition>; // путь к файлу → позиция чтения
	settings: Fb2Settings;
}

// Настройки по умолчанию — используются при первом запуске
// и при нажатии кнопки "Reset to defaults".
const DEFAULT_SETTINGS: Fb2Settings = {
	fontFamily: "",
	fontSize: 17,
	lineHeight: 1.65,
	theme: "",
	textColor: "",
};

// Готовые варианты цвета текста для выпадающего списка в настройках:
// «код цвета → подпись». Record<string, string> значит «объект, где
// и ключи, и значения — строки».
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
// Таблицы соответствий «тег FB2 → элемент HTML»
//
// FB2 — это XML со своими тегами (<section>, <poem>, <emphasis>...).
// Браузер и Obsidian понимают только HTML, поэтому каждый тег FB2 надо
// «перевести». Большинство переводов тривиальны, и вместо длинной цепочки
// условий мы описываем их тремя таблицами. Чтобы узнать, как отображается
// тот или иной тег, достаточно найти его строчку здесь.
// ---------------------------------------------------------------------------

// Блочные теги-«контейнеры»: превращаются в обёртку с CSS-классом,
// а их содержимое обрабатывается дальше как блоки.
// Только <section> увеличивает глубину вложенности (важно для заголовков).
const BLOCK_CONTAINERS: Record<string, { tag: "div" | "blockquote"; cls: string }> = {
	section: { tag: "div", cls: "fb2-section" }, // глава книги
	epigraph: { tag: "div", cls: "fb2-epigraph" }, // эпиграф
	poem: { tag: "div", cls: "fb2-poem" }, // стихотворение
	stanza: { tag: "div", cls: "fb2-stanza" }, // строфа
	annotation: { tag: "div", cls: "fb2-annotation" }, // аннотация
	cite: { tag: "blockquote", cls: "fb2-cite" }, // цитата
};

// Блочные теги, которые становятся абзацем <p> с указанным CSS-классом;
// их содержимое — уже строчный текст (курсив, ссылки и т.п.).
const BLOCK_PARAGRAPHS: Record<string, string> = {
	p: "fb2-p", // обычный абзац
	subtitle: "fb2-subtitle", // подзаголовок
	v: "fb2-verse", // строка стихотворения
	"text-author": "fb2-text-author", // подпись автора под цитатой/эпиграфом
};

// Строчные теги (внутри абзаца), у которых есть прямой HTML-аналог.
const INLINE_TAGS: Record<string, keyof HTMLElementTagNameMap> = {
	strong: "strong", // жирный
	emphasis: "em", // курсив
	strikethrough: "s", // зачёркнутый
	sub: "sub", // нижний индекс
	sup: "sup", // верхний индекс
	code: "code", // моноширинный (код)
};

// ---------------------------------------------------------------------------
// Вспомогательные функции: чтение и декодирование файла
// ---------------------------------------------------------------------------

// Файл с диска приходит в виде «сырых байт» (ArrayBuffer). Чтобы превратить
// байты в текст, нужно знать кодировку. Эта функция пытается её угадать:
// сначала по первым байтам (метка BOM у UTF-16), затем по объявлению
// encoding="..." в первой строке XML. Если ничего не нашли — считаем UTF-8.
function detectEncoding(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf.slice(0, 4));
	if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
	// Читаем первые 512 байт как latin1 (это безопасно для любых байт)
	// и ищем в них слово encoding="...".
	const head = new TextDecoder("latin1").decode(buf.slice(0, 512));
	const m = head.match(/encoding=["']([\w-]+)["']/i);
	return m ? m[1].toLowerCase() : "utf-8";
}

// Превращает байты FB2-файла в текст. try/catch — «попробуй, а если
// произойдёт ошибка (например, кодировка неизвестна браузеру) — сделай
// запасной вариант»: декодируем как UTF-8.
function decodeFb2(buf: ArrayBuffer): string {
	try {
		return new TextDecoder(detectEncoding(buf)).decode(buf);
	} catch {
		return new TextDecoder("utf-8").decode(buf);
	}
}

// Если открыли .zip: распаковываем архив и достаём из него первый файл
// с расширением .fb2. Возвращаем его байты, либо null, если не нашли.
function extractFb2FromZip(buf: ArrayBuffer): ArrayBuffer | null {
	let entries: Record<string, Uint8Array>;
	try {
		// filter — распаковываем только файлы, чьё имя заканчивается на .fb2,
		// остальное содержимое архива даже не трогаем.
		entries = unzipSync(new Uint8Array(buf), {
			filter: (f) => f.name.toLowerCase().endsWith(".fb2"),
		});
	} catch {
		return null; // архив повреждён или это вовсе не zip
	}
	const name = Object.keys(entries)[0];
	if (!name) return null;
	const data = entries[name];
	// Uint8Array может «смотреть» в середину большого буфера,
	// поэтому вырезаем ровно наш кусок байт.
	return data.buffer.slice(
		data.byteOffset,
		data.byteOffset + data.byteLength
	) as ArrayBuffer;
}

// Кэш списка шрифтов: запрашивать его у системы каждый раз медленно,
// поэтому после первого успешного запроса результат запоминается.
let cachedSystemFonts: string[] | null = null;

// «async» помечает функцию как асинхронную: она умеет ждать медленные
// операции (здесь — запрос списка шрифтов у системы), не замораживая
// интерфейс. Слово «await» внутри означает «дождись результата».
async function getSystemFonts(): Promise<string[]> {
	if (cachedSystemFonts) return cachedSystemFonts;
	// window.queryLocalFonts — сравнительно новая возможность браузера,
	// которой может и не быть, поэтому описываем её тип вручную
	// и проверяем наличие.
	const queryLocalFonts = (
		window as { queryLocalFonts?: () => Promise<{ family: string }[]> }
	).queryLocalFonts;
	if (!queryLocalFonts) return [];
	try {
		const fonts: { family: string }[] = await queryLocalFonts.call(window);
		// Одно семейство шрифта встречается по несколько раз (обычный, жирный,
		// курсив...). Set оставляет только уникальные имена, sort — сортирует.
		const families = Array.from(new Set(fonts.map((f) => f.family))).sort(
			(a, b) => a.localeCompare(b)
		);
		if (families.length) cachedSystemFonts = families;
		return families;
	} catch {
		return []; // пользователь не дал разрешение — обойдёмся без списка
	}
}

// Достаёт адрес ссылки из элемента FB2. В разных книгах атрибут ссылки
// записан по-разному (xlink:href, l:href, просто href), поэтому проверяем
// все варианты по очереди. «??» означает «если слева null — попробуй справа».
function getHref(el: Element): string | null {
	return (
		el.getAttributeNS(XLINK_NS, "href") ??
		el.getAttribute("l:href") ??
		el.getAttribute("xlink:href") ??
		el.getAttribute("href")
	);
}

// Переносит атрибут id из тега FB2 на созданный HTML-элемент (под именем
// data-fb2-id), чтобы внутренние ссылки книги (сноски, перекрёстные ссылки)
// могли потом найти цель и прокрутить к ней.
function copyId(from: Element, to: HTMLElement) {
	const id = from.getAttribute("id");
	if (id) to.setAttribute("data-fb2-id", id);
}

// ---------------------------------------------------------------------------
// Fb2View — читалка
//
// «class» — это чертёж объекта: набор данных (полей) и действий (методов).
// «extends FileView» означает: наш класс наследует готовый класс Obsidian
// для окон, привязанных к файлу, и добавляет/переопределяет нужное нам.
// Obsidian сам создаёт экземпляр Fb2View, когда пользователь открывает
// .fb2-файл, и сам вызывает методы жизненного цикла (onLoadFile и др.).
// ---------------------------------------------------------------------------

class Fb2View extends FileView {
	// Пункты оглавления текущей книги; их читает панель Fb2TocView.
	tocItems: TocItem[] = [];

	// «private» — поле доступно только внутри этого класса.
	private plugin: Fb2ReaderPlugin; // ссылка на главный объект плагина
	private bookTitle = ""; // название книги (для заголовка вкладки)
	private binaries = new Map<string, string>(); // картинки книги: id → data-URL
	private collectToc = false; // собирать ли сейчас пункты оглавления
	// debounce «сглаживает» частые вызовы: при прокрутке событие scroll
	// срабатывает десятки раз в секунду, а сохранять позицию достаточно
	// один раз, спустя 800 мс после того, как прокрутка затихла.
	private savePositionDebounced = debounce(
		() => this.saveReadingPosition(),
		800,
		true
	);

	// Конструктор вызывается при создании объекта. «this» — сам объект:
	// this.plugin = plugin означает «запомни plugin в своём поле plugin».
	constructor(leaf: WorkspaceLeaf, plugin: Fb2ReaderPlugin) {
		super(leaf); // сначала даём отработать конструктору родителя (FileView)
		this.plugin = plugin;
		this.navigation = true; // вкладка участвует в истории «назад/вперёд»
	}

	// Вызывается один раз при создании вида. Подписываемся на прокрутку,
	// чтобы запоминать позицию чтения. registerDomEvent — обёртка Obsidian,
	// которая сама отпишет обработчик, когда вид закроется.
	onload(): void {
		super.onload();
		this.registerDomEvent(this.contentEl, "scroll", () =>
			this.savePositionDebounced()
		);
	}

	// Следующие четыре метода — «анкета» вида, которую спрашивает Obsidian.
	getViewType(): string {
		return VIEW_TYPE_FB2; // внутреннее имя вида
	}

	getDisplayText(): string {
		// Заголовок вкладки: название книги, иначе имя файла, иначе "FB2".
		// «||» возвращает первый «непустой» вариант слева направо.
		return this.bookTitle || this.file?.basename || "FB2";
	}

	getIcon(): string {
		return "book-open"; // имя иконки из встроенного набора Obsidian
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "fb2" || extension === "zip";
	}

	// Главный метод: Obsidian вызывает его, когда в этом виде нужно открыть
	// файл. Здесь происходит вся цепочка: байты → текст → XML → HTML.
	async onLoadFile(file: TFile): Promise<void> {
		const container = this.contentEl; // корневой HTML-элемент нашего окна
		container.empty(); // очищаем от предыдущего содержимого
		container.addClass("fb2-reader"); // CSS-класс, на который нацелены стили
		this.tocItems = [];

		// Шаг 1: читаем файл из хранилища Obsidian как байты.
		let buf = await this.app.vault.readBinary(file);

		// Шаг 2: если это zip — достаём из него .fb2.
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

		// Шаг 3: байты → текст (с угадыванием кодировки).
		const xml = decodeFb2(buf);
		// Шаг 4: текст → дерево XML. DOMParser встроен в браузер: он читает
		// разметку и строит из неё дерево объектов, по которому можно ходить.
		const doc = new DOMParser().parseFromString(xml, "application/xml");

		// При ошибке разбора DOMParser не бросает исключение, а вставляет
		// в документ специальный тег <parsererror> — проверяем его наличие.
		if (doc.querySelector("parsererror")) {
			container.createEl("p", {
				text: "Failed to parse the file: invalid XML.",
				cls: "fb2-error",
			});
			return;
		}

		// Шаг 5: собираем картинки, рисуем книгу, сообщаем плагину
		// (чтобы тот обновил оглавление) и восстанавливаем позицию чтения.
		this.collectBinaries(doc);
		this.renderBook(doc, container.createDiv({ cls: "fb2-book" }));
		this.plugin.onFb2Opened(this);
		this.restoreReadingPosition(file.path);
	}

	// Вызывается при закрытии файла: сохраняем позицию и прибираем за собой,
	// чтобы не держать в памяти большую книгу.
	async onUnloadFile(file: TFile): Promise<void> {
		this.saveReadingPosition(file);
		this.plugin.clearTocFor(this);
		this.binaries.clear();
		this.tocItems = [];
		this.bookTitle = "";
		this.contentEl.empty();
	}

	// --- Позиция чтения ---

	// Список всех «блоков текста» книги по порядку. Позицию чтения мы
	// храним как номер блока в этом списке — это надёжнее, чем количество
	// пикселей прокрутки (которое меняется при смене шрифта или окна).
	private getScrollBlocks(): HTMLElement[] {
		return Array.from(
			this.contentEl.querySelectorAll<HTMLElement>(
				".fb2-p, .fb2-title, .fb2-subtitle, .fb2-verse, .fb2-image-block"
			)
		);
	}

	// Сохраняем позицию: находим первый блок, который виден на экране
	// (его нижний край ниже верхней кромки окна), и запоминаем его номер.
	private saveReadingPosition(file = this.file) {
		if (!file) return;
		const scroller = this.contentEl;
		if (scroller.scrollTop <= 0) return; // книга в самом начале — нечего запоминать
		const top = scroller.getBoundingClientRect().top;
		const index = this.getScrollBlocks().findIndex(
			(b) => b.getBoundingClientRect().bottom > top
		);
		if (index >= 0) this.plugin.setPosition(file.path, index);
	}

	// Восстанавливаем позицию: прокручиваем к блоку с сохранённым номером.
	private restoreReadingPosition(path: string) {
		const pos = this.plugin.getPosition(path);
		if (!pos || pos.index <= 0) return;
		// requestAnimationFrame — «выполни перед следующей отрисовкой экрана»:
		// к этому моменту браузер уже рассчитает размеры всех элементов.
		requestAnimationFrame(() => {
			const blocks = this.getScrollBlocks();
			const target = blocks[Math.min(pos.index, blocks.length - 1)];
			target?.scrollIntoView({ block: "start" });
		});
	}

	// --- Отрисовка книги ---

	// Картинки в FB2 лежат в конце файла в тегах <binary> в виде текста
	// base64. Складываем их в словарь «id → data-URL»; такой URL браузер
	// может показать в <img> без всяких внешних файлов.
	private collectBinaries(doc: Document) {
		this.binaries.clear();
		for (const bin of Array.from(doc.getElementsByTagName("binary"))) {
			const id = bin.getAttribute("id");
			if (!id) continue; // без id на картинку нельзя сослаться — пропускаем
			const type = bin.getAttribute("content-type") || "image/jpeg";
			const data = (bin.textContent || "").replace(/\s+/g, ""); // убираем переносы строк
			this.binaries.set(id, `data:${type};base64,${data}`);
		}
	}

	// Верхний уровень отрисовки: титульная страница, затем все <body>
	// (основной текст и, отдельным блоком, сноски).
	private renderBook(doc: Document, root: HTMLElement) {
		const titleInfo = doc.querySelector("description > title-info");
		this.collectToc = false;
		if (titleInfo) this.renderTitleInfo(titleInfo, root);

		for (const body of Array.from(doc.querySelectorAll("FictionBook > body"))) {
			// <body name="notes"> — это сноски; их заголовки в оглавление не берём.
			const isNotes = body.getAttribute("name") === "notes";
			this.collectToc = !isNotes;
			const bodyEl = root.createDiv({
				cls: isNotes ? "fb2-body fb2-notes" : "fb2-body",
			});
			if (isNotes) bodyEl.createEl("hr"); // разделительная черта перед сносками
			this.renderBlockChildren(body, bodyEl, 1);
		}
		this.collectToc = false;

		// Один обработчик кликов на всю книгу — для внутренних ссылок
		// (сносок и перекрёстных ссылок): ищем элемент с нужным data-fb2-id
		// и плавно прокручиваем к нему.
		root.addEventListener("click", (evt) => {
			const link = (evt.target as HTMLElement).closest("a[data-fb2-target]");
			if (!link) return;
			evt.preventDefault(); // отменяем стандартный переход по ссылке
			const target = link.getAttribute("data-fb2-target");
			const dest = root.querySelector(
				`[data-fb2-id="${CSS.escape(target ?? "")}"]`
			);
			dest?.scrollIntoView({ behavior: "smooth", block: "start" });
		});
	}

	// Титульная страница: обложка, название, авторы, аннотация.
	private renderTitleInfo(info: Element, root: HTMLElement) {
		const header = root.createDiv({ cls: "fb2-title-page" });

		const coverImage = info.querySelector("coverpage > image");
		if (coverImage) this.renderImage(coverImage, header, "fb2-cover");

		// «?.» — безопасное обращение: если book-title отсутствует, вся
		// цепочка вернёт undefined вместо ошибки.
		const title = info.querySelector("book-title")?.textContent?.trim();
		if (title) {
			this.bookTitle = title;
			header.createEl("h1", { text: title, cls: "fb2-book-title" });
		}

		// Для каждого <author> склеиваем имя-отчество-фамилию через пробел,
		// пропуская отсутствующие части; пустых авторов отбрасываем.
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

	// Обходит всех детей элемента и отрисовывает каждого как блок.
	private renderBlockChildren(el: Element, parent: HTMLElement, depth: number) {
		for (const child of Array.from(el.children)) {
			this.renderBlock(child, parent, depth);
		}
	}

	// Сердце читалки: превращает один блочный тег FB2 в HTML.
	// Метод рекурсивный — для вложенных тегов он вызывает сам себя,
	// так дерево FB2 обходится целиком, на любую глубину.
	private renderBlock(el: Element, parent: HTMLElement, depth: number) {
		const tag = el.localName; // имя тега без префиксов, например "section"

		// Случай 1: тег-контейнер из таблицы BLOCK_CONTAINERS.
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

		// Случай 2: тег-абзац из таблицы BLOCK_PARAGRAPHS.
		const paragraphCls = BLOCK_PARAGRAPHS[tag];
		if (paragraphCls) {
			const p = parent.createEl("p", { cls: paragraphCls });
			copyId(el, p);
			this.renderInlineChildren(el, p);
			return;
		}

		// Случай 3: особые теги, которым нужна своя логика.
		switch (tag) {
			case "title": {
				// Заголовок главы. Уровень (h2, h3...) зависит от глубины
				// вложенности секции; глубже h6 в HTML не бывает.
				const level = Math.min(depth + 1, 6);
				const heading = parent.createEl(
					`h${level}` as keyof HTMLElementTagNameMap,
					{ cls: "fb2-title" }
				);
				// Заголовок в FB2 может состоять из нескольких <p> —
				// показываем их с новой строки (через <br>).
				const tocText: string[] = [];
				for (const child of Array.from(el.children)) {
					if (child.localName !== "p") continue;
					if (heading.childNodes.length) heading.createEl("br");
					this.renderInlineChildren(child, heading);
					const text = child.textContent?.trim();
					if (text) tocText.push(text);
				}
				// Попутно добавляем пункт в оглавление (кроме раздела сносок).
				if (this.collectToc) {
					this.tocItems.push({ text: tocText.join(" "), depth, el: heading });
				}
				break;
			}
			case "empty-line":
				parent.createDiv({ cls: "fb2-empty-line" }); // пустой отступ
				break;
			case "image":
				this.renderImage(el, parent, "fb2-image-block");
				break;
			case "table": {
				// Таблица: переносим строки <tr> и ячейки <td>/<th> как есть.
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
				// Незнакомый тег: не рисуем его сам, но обходим детей —
				// вдруг внутри есть знакомые теги, которые можно показать.
				this.renderBlockChildren(el, parent, depth);
		}
	}

	// Обходит всё содержимое элемента (и теги, и куски текста)
	// и отрисовывает как строчные элементы.
	private renderInlineChildren(el: Element, parent: HTMLElement) {
		for (const node of Array.from(el.childNodes)) {
			this.renderInline(node, parent);
		}
	}

	// Отрисовка строчного содержимого: текст, курсив, ссылки, сноски...
	private renderInline(node: Node, parent: HTMLElement) {
		// Просто текст между тегами — добавляем как есть.
		if (node.nodeType === Node.TEXT_NODE) {
			parent.appendText(node.textContent ?? "");
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return; // комментарии и пр. — пропускаем
		const el = node as Element;
		const tag = el.localName;

		// Простые теги из таблицы INLINE_TAGS: <emphasis> → <em> и т.п.
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
				// Сноска (type="note") оборачивается в <sup>, чтобы её номер
				// отображался маленькой цифрой сверху.
				const isNote = el.getAttribute("type") === "note";
				const host = isNote ? parent.createEl("sup") : parent;
				const anchor = host.createEl("a", { cls: "fb2-link" });
				if (href.startsWith("#")) {
					// Внутренняя ссылка (на сноску или главу): запоминаем цель
					// в data-fb2-target — клики ловит обработчик в renderBook.
					anchor.setAttribute("data-fb2-target", href.slice(1));
					anchor.setAttribute("href", "#");
				} else {
					anchor.setAttribute("href", href); // обычная внешняя ссылка
				}
				this.renderInlineChildren(el, anchor);
				break;
			}
			default:
				// Незнакомый строчный тег — показываем хотя бы его содержимое.
				this.renderInlineChildren(el, parent);
		}
	}

	// Вставляет картинку: по ссылке "#id" находит data-URL
	// в словаре binaries и создаёт элемент <img>.
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
// Fb2TocView — боковая панель с оглавлением
//
// Наследуется от ItemView (вид без привязки к файлу). Панель ничего не
// вычисляет сама: она показывает список tocItems, который собрала читалка.
// ---------------------------------------------------------------------------

class Fb2TocView extends ItemView {
	// Читалка, чьё оглавление показываем сейчас (null — никакой).
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

	// Вызывается Obsidian, когда панель открывается.
	async onOpen(): Promise<void> {
		this.render();
	}

	// Показывает ли панель оглавление именно этой читалки?
	sourceIs(view: Fb2View): boolean {
		return this.source === view;
	}

	// Плагин вызывает это при смене активной книги; панель перерисовывается.
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

		// Название книги сверху, затем — по строке на каждый заголовок.
		el.createDiv({ cls: "fb2-toc-book", text: this.source.getDisplayText() });
		for (const item of this.source.tocItems) {
			const row = el.createDiv({
				cls: "fb2-toc-item",
				text: item.text || "(untitled)",
			});
			// Отступ слева зависит от глубины — так видна вложенность глав.
			row.style.paddingLeft = `${(item.depth - 1) * 14 + 6}px`;
			// Клик по пункту: показать вкладку с книгой и прокрутить к главе.
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
// Fb2ReaderPlugin — главный класс плагина
//
// «export default» делает класс видимым снаружи файла: именно его Obsidian
// находит и создаёт при включении плагина. Этот класс связывает всё вместе:
// регистрирует виды, хранит и сохраняет настройки и позиции чтения,
// управляет панелью оглавления.
// ---------------------------------------------------------------------------

export default class Fb2ReaderPlugin extends Plugin {
	// Все данные плагина (настройки + позиции чтения).
	private data: Fb2Data = { positions: {}, settings: { ...DEFAULT_SETTINGS } };
	// Отложенное сохранение на диск: не чаще, чем раз в 2 секунды,
	// чтобы не писать файл при каждом чихе.
	private saveDataDebounced = debounce(() => this.saveData(this.data), 2000, true);

	// Вызывается Obsidian при включении плагина. Здесь — вся регистрация.
	async onload() {
		// Загружаем сохранённые данные (data.json). «?? {}» — если данных
		// ещё нет (первый запуск), берём пустой объект. Object.assign
		// накладывает сохранённые настройки поверх настроек по умолчанию:
		// так новые поля, появившиеся в обновлении плагина, получат значения.
		const stored = (await this.loadData()) ?? {};
		this.data = {
			positions: stored.positions ?? {},
			settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings),
		};
		this.applySettings();

		// Сообщаем Obsidian, как создавать наши виды...
		this.registerView(VIEW_TYPE_FB2, (leaf) => new Fb2View(leaf, this));
		this.registerView(VIEW_TYPE_TOC, (leaf) => new Fb2TocView(leaf));
		// ...и что файлы .fb2 и .zip должны открываться в нашей читалке.
		this.registerExtensions(["fb2", "zip"], VIEW_TYPE_FB2);
		this.addSettingTab(new Fb2SettingTab(this.app, this));

		// Кнопка на левой панели Obsidian — открывает настройки плагина.
		this.addRibbonIcon("book-open-text", "FB2 Reader settings", () => {
			// app.setting — недокументированная часть Obsidian API, поэтому
			// её тип приходится дописывать вручную (см. GUIDE.md).
			const appSetting = (
				this.app as App & {
					setting: { open(): void; openTabById(id: string): void };
				}
			).setting;
			appSetting.open();
			appSetting.openTabById(this.manifest.id);
		});

		// Команда для палитры команд (Ctrl/Cmd+P): открыть оглавление.
		this.addCommand({
			id: "open-toc",
			name: "Open table of contents",
			callback: () => this.activateTocLeaf(),
		});

		// При переключении вкладок: если активной стала читалка —
		// показываем в панели её оглавление.
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf?.view instanceof Fb2View) this.updateToc(leaf.view);
			})
		);
	}

	// Вызывается при выключении плагина: сохраняем данные и убираем
	// с <body> все следы наших настроек (CSS-переменные и классы тем).
	onunload() {
		void this.saveData(this.data);
		const body = document.body;
		body.style.removeProperty("--fb2-font-family");
		body.style.removeProperty("--fb2-font-size");
		body.style.removeProperty("--fb2-line-height");
		body.style.removeProperty("--fb2-text-color");
		body.removeClass("fb2-theme-dark", "fb2-theme-light", "fb2-theme-sepia");
	}

	// --- Настройки ---

	// «get» делает метод похожим на поле: снаружи пишут plugin.fb2Settings
	// без скобок и получают текущие настройки.
	get fb2Settings(): Fb2Settings {
		return this.data.settings;
	}

	// Применяет настройки к странице. Значения записываются в CSS-переменные
	// на <body>; файл styles.css читает их и оформляет книгу. Так код
	// и оформление общаются, не зная друг о друге лишнего.
	applySettings() {
		const s = this.data.settings;
		const body = document.body;
		if (s.fontFamily) body.style.setProperty("--fb2-font-family", s.fontFamily);
		else body.style.removeProperty("--fb2-font-family");
		body.style.setProperty("--fb2-font-size", `${s.fontSize}px`);
		body.style.setProperty("--fb2-line-height", `${s.lineHeight}`);
		// toggleClass(класс, условие): добавляет класс при true, снимает при false.
		body.toggleClass("fb2-theme-dark", s.theme === "dark");
		body.toggleClass("fb2-theme-light", s.theme === "light");
		body.toggleClass("fb2-theme-sepia", s.theme === "sepia");
		if (s.textColor) body.style.setProperty("--fb2-text-color", s.textColor);
		else body.style.removeProperty("--fb2-text-color");
	}

	// Применить и (отложенно) сохранить — вызывается из вкладки настроек.
	saveSettings() {
		this.applySettings();
		this.saveDataDebounced();
	}

	// --- Позиции чтения ---

	getPosition(path: string): ReadingPosition | undefined {
		return this.data.positions[path];
	}

	setPosition(path: string, index: number) {
		this.data.positions[path] = { index, ts: Date.now() };
		this.prunePositions();
		this.saveDataDebounced();
	}

	// Чтобы data.json не разрастался бесконечно, храним позиции только
	// для 300 последних книг; самые старые записи удаляются.
	private prunePositions() {
		const entries = Object.entries(this.data.positions);
		if (entries.length <= 300) return;
		entries.sort((a, b) => b[1].ts - a[1].ts); // сортируем по времени, новые сверху
		this.data.positions = Object.fromEntries(entries.slice(0, 300));
	}

	// --- Панель оглавления ---

	// Читалка зовёт этот метод, когда открыла книгу: если панели оглавления
	// ещё нет — создаём её в правой боковой панели, затем обновляем.
	onFb2Opened(view: Fb2View) {
		this.app.workspace.onLayoutReady(async () => {
			if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC).length) {
				const leaf = this.app.workspace.getRightLeaf(false);
				await leaf?.setViewState({ type: VIEW_TYPE_TOC, active: false });
			}
			this.updateToc(view);
		});
	}

	// Показывает во всех панелях оглавления содержание указанной читалки.
	updateToc(view: Fb2View | null) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
			if (leaf.view instanceof Fb2TocView) leaf.view.setSource(view);
		}
	}

	// Когда книга закрывается — очищаем панели, показывавшие её оглавление.
	clearTocFor(view: Fb2View) {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
			if (leaf.view instanceof Fb2TocView && leaf.view.sourceIs(view)) {
				leaf.view.setSource(null);
			}
		}
	}

	// Обработчик команды "Open table of contents": находит (или создаёт)
	// панель оглавления, показывает её и наполняет содержанием активной книги.
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
// Fb2SettingTab — вкладка настроек
//
// Наследуется от PluginSettingTab. Obsidian вызывает метод display() каждый
// раз, когда пользователь открывает настройки плагина. Каждый элемент
// интерфейса создаётся классом Setting: имя, описание и поле ввода.
// Общий приём: onChange поля меняет значение в plugin.fb2Settings
// и зовёт plugin.saveSettings() — настройка применяется сразу.
// ---------------------------------------------------------------------------

class Fb2SettingTab extends PluginSettingTab {
	private plugin: Fb2ReaderPlugin;
	// Счётчик перерисовок — защита от «гонки» (см. комментарий в render).
	private renderToken = 0;

	constructor(app: App, plugin: Fb2ReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		// render — асинхронный (ждёт список шрифтов); «void» говорит:
		// «запусти и не жди результата».
		void this.render();
	}

	// Помощник: числовое поле, принимающее только значения из [min, max].
	// Используется дважды — для размера шрифта и межстрочного интервала.
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
					// Не число или вне диапазона — просто не сохраняем.
					if (!Number.isFinite(n) || n < min || n > max) return;
					setValue(n);
					this.plugin.saveSettings();
				});
			});
	}

	private async render(): Promise<void> {
		const token = ++this.renderToken;
		const fonts = await getSystemFonts();
		// Пока мы ждали список шрифтов, пользователь мог закрыть и снова
		// открыть настройки — тогда запустился новый render. Если наш номер
		// уже не последний, тихо выходим и даём победить более новому.
		if (token !== this.renderToken) return;

		const { containerEl } = this;
		containerEl.empty();

		// Тема оформления читалки.
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

		// Цвет текста: варианты из TEXT_COLORS. Если в настройках сохранён
		// цвет не из списка (например, вписанный вручную в data.json),
		// добавляем его отдельным пунктом, чтобы выбор не «слетал».
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

		// Шрифт: если удалось получить список системных шрифтов — даём
		// выпадающий список; если нет (нет разрешения или старая система) —
		// обычное текстовое поле для ввода названия вручную.
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

		// Кнопка сброса: возвращает настройки по умолчанию
		// и перерисовывает вкладку, чтобы поля показали новые значения.
		new Setting(containerEl).addButton((btn) =>
			btn.setButtonText("Reset to defaults").onClick(() => {
				Object.assign(this.plugin.fb2Settings, DEFAULT_SETTINGS);
				this.plugin.saveSettings();
				this.display();
			})
		);
	}
}
