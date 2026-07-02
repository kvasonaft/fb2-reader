var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  default: () => Fb2ReaderPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// node_modules/fflate/esm/browser.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
};
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// src/main.ts
var VIEW_TYPE_FB2 = "fb2-reader-view";
var VIEW_TYPE_TOC = "fb2-reader-toc";
var XLINK_NS = "http://www.w3.org/1999/xlink";
var DEFAULT_SETTINGS = {
  fontFamily: "",
  fontSize: 17,
  lineHeight: 1.65,
  theme: "",
  textColor: ""
};
var TEXT_COLORS = {
  "": "Default (theme)",
  "#000000": "Black",
  "#333333": "Charcoal",
  "#555555": "Dark gray",
  "#707070": "Medium gray",
  "#8a8a8a": "Gray",
  "#a6a6a6": "Silver gray",
  "#c4c4c4": "Light gray",
  "#e2e2e2": "Off-white",
  "#5b4636": "Sepia brown"
};
function detectEncoding(buf) {
  const bytes = new Uint8Array(buf.slice(0, 4));
  if (bytes[0] === 255 && bytes[1] === 254) return "utf-16le";
  if (bytes[0] === 254 && bytes[1] === 255) return "utf-16be";
  const head = new TextDecoder("latin1").decode(buf.slice(0, 512));
  const m = head.match(/encoding=["']([\w-]+)["']/i);
  return m ? m[1].toLowerCase() : "utf-8";
}
function decodeFb2(buf) {
  const encoding = detectEncoding(buf);
  try {
    return new TextDecoder(encoding).decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}
function extractFb2FromZip(buf) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(buf), {
      filter: (f) => f.name.toLowerCase().endsWith(".fb2")
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
  );
}
var cachedSystemFonts = null;
async function getSystemFonts() {
  if (cachedSystemFonts) return cachedSystemFonts;
  try {
    const query = window.queryLocalFonts;
    if (!query) return [];
    const fonts = await query.call(window);
    const families = Array.from(new Set(fonts.map((f) => f.family))).sort(
      (a, b) => a.localeCompare(b)
    );
    if (families.length) cachedSystemFonts = families;
    return families;
  } catch {
    return [];
  }
}
function getHref(el) {
  return el.getAttributeNS(XLINK_NS, "href") ?? el.getAttribute("l:href") ?? el.getAttribute("xlink:href") ?? el.getAttribute("href");
}
var Fb2View = class extends import_obsidian.FileView {
  constructor(leaf, plugin) {
    super(leaf);
    this.tocItems = [];
    this.bookTitle = "";
    this.binaries = /* @__PURE__ */ new Map();
    this.collectToc = false;
    this.savePositionDebounced = (0, import_obsidian.debounce)(
      () => this.saveReadingPosition(),
      800,
      true
    );
    this.plugin = plugin;
    this.navigation = true;
  }
  onload() {
    super.onload();
    this.registerDomEvent(
      this.contentEl,
      "scroll",
      () => this.savePositionDebounced()
    );
  }
  getViewType() {
    return VIEW_TYPE_FB2;
  }
  getDisplayText() {
    return this.bookTitle || this.file?.basename || "FB2";
  }
  getIcon() {
    return "book-open";
  }
  canAcceptExtension(extension) {
    return extension === "fb2" || extension === "zip";
  }
  async onLoadFile(file) {
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
          cls: "fb2-error"
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
        cls: "fb2-error"
      });
      return;
    }
    this.collectBinaries(doc);
    this.renderBook(doc, container.createDiv({ cls: "fb2-book" }));
    this.plugin.onFb2Opened(this);
    this.restoreReadingPosition(file.path);
  }
  async onUnloadFile(file) {
    this.saveReadingPosition(file);
    this.plugin.clearTocFor(this);
    this.binaries.clear();
    this.tocItems = [];
    this.bookTitle = "";
    this.contentEl.empty();
  }
  // --- reading position ---
  getScrollBlocks() {
    return Array.from(
      this.contentEl.querySelectorAll(
        ".fb2-p, .fb2-title, .fb2-subtitle, .fb2-verse, .fb2-image-block"
      )
    );
  }
  saveReadingPosition(file = this.file) {
    if (!file) return;
    const scroller = this.contentEl;
    if (scroller.scrollTop <= 0) return;
    const top = scroller.getBoundingClientRect().top;
    const index = this.getScrollBlocks().findIndex(
      (b) => b.getBoundingClientRect().bottom > top
    );
    if (index >= 0) this.plugin.setPosition(file.path, index);
  }
  restoreReadingPosition(path) {
    const pos = this.plugin.getPosition(path);
    if (!pos || pos.index <= 0) return;
    requestAnimationFrame(() => {
      const blocks = this.getScrollBlocks();
      const target = blocks[Math.min(pos.index, blocks.length - 1)];
      target?.scrollIntoView({ block: "start" });
    });
  }
  // --- rendering ---
  collectBinaries(doc) {
    this.binaries.clear();
    for (const bin of Array.from(doc.getElementsByTagName("binary"))) {
      const id = bin.getAttribute("id");
      if (!id) continue;
      const type = bin.getAttribute("content-type") || "image/jpeg";
      const data = (bin.textContent || "").replace(/\s+/g, "");
      this.binaries.set(id, `data:${type};base64,${data}`);
    }
  }
  renderBook(doc, root) {
    const titleInfo = doc.querySelector("description > title-info");
    this.collectToc = false;
    if (titleInfo) this.renderTitleInfo(titleInfo, root);
    const bodies = Array.from(doc.querySelectorAll("FictionBook > body"));
    for (const body of bodies) {
      const isNotes = body.getAttribute("name") === "notes";
      this.collectToc = !isNotes;
      const bodyEl = root.createDiv({
        cls: isNotes ? "fb2-body fb2-notes" : "fb2-body"
      });
      if (isNotes) bodyEl.createEl("hr");
      for (const child of Array.from(body.children)) {
        this.renderBlock(child, bodyEl, 1);
      }
    }
    this.collectToc = false;
    root.addEventListener("click", (evt) => {
      const link = evt.target.closest("a[data-fb2-target]");
      if (!link) return;
      evt.preventDefault();
      const target = link.getAttribute("data-fb2-target");
      const dest = root.querySelector(
        `[data-fb2-id="${CSS.escape(target ?? "")}"]`
      );
      dest?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  renderTitleInfo(info, root) {
    const header = root.createDiv({ cls: "fb2-title-page" });
    const coverImage = info.querySelector("coverpage > image");
    if (coverImage) this.renderImage(coverImage, header, "fb2-cover");
    const title = info.querySelector("book-title")?.textContent?.trim();
    if (title) {
      this.bookTitle = title;
      header.createEl("h1", { text: title, cls: "fb2-book-title" });
    }
    const authors = Array.from(info.querySelectorAll(":scope > author")).map(
      (a) => ["first-name", "middle-name", "last-name"].map((tag) => a.querySelector(tag)?.textContent?.trim()).filter(Boolean).join(" ")
    ).filter(Boolean);
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
  renderBlock(el, parent, depth) {
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
        const heading = parent.createEl(`h${level}`, {
          cls: "fb2-title"
        });
        for (const child of Array.from(el.children)) {
          if (child.localName === "p") {
            if (heading.childNodes.length) heading.createEl("br");
            this.renderInlineChildren(child, heading);
          }
        }
        if (this.collectToc) {
          const text = Array.from(el.children).filter((c) => c.localName === "p").map((c) => c.textContent?.trim() ?? "").filter(Boolean).join(" ");
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
        for (const child of Array.from(el.children)) {
          this.renderBlock(child, parent, depth);
        }
      }
    }
  }
  renderInlineChildren(el, parent) {
    for (const node of Array.from(el.childNodes)) {
      this.renderInline(node, parent);
    }
  }
  renderInline(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.appendText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
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
  renderImage(el, parent, cls) {
    const href = getHref(el);
    if (!href || !href.startsWith("#")) return;
    const src = this.binaries.get(href.slice(1));
    if (!src) return;
    const img = parent.createEl("img", { cls });
    img.src = src;
    const alt = el.getAttribute("alt");
    if (alt) img.alt = alt;
  }
};
var Fb2TocView = class extends import_obsidian.ItemView {
  constructor() {
    super(...arguments);
    this.source = null;
  }
  getViewType() {
    return VIEW_TYPE_TOC;
  }
  getDisplayText() {
    return "FB2 table of contents";
  }
  getIcon() {
    return "list";
  }
  async onOpen() {
    this.render();
  }
  sourceIs(view) {
    return this.source === view;
  }
  setSource(view) {
    this.source = view;
    this.render();
  }
  render() {
    const el = this.contentEl;
    el.empty();
    el.addClass("fb2-toc");
    if (!this.source || !this.source.tocItems.length) {
      el.createEl("p", {
        text: "Open an FB2 file to see its table of contents.",
        cls: "fb2-toc-empty"
      });
      return;
    }
    el.createDiv({ cls: "fb2-toc-book", text: this.source.getDisplayText() });
    for (const item of this.source.tocItems) {
      const row = el.createDiv({
        cls: "fb2-toc-item",
        text: item.text || "(untitled)"
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
};
var Fb2ReaderPlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.data = { positions: {}, settings: { ...DEFAULT_SETTINGS } };
    this.saveDataDebounced = (0, import_obsidian.debounce)(() => this.saveData(this.data), 2e3, true);
  }
  async onload() {
    const stored = await this.loadData() ?? {};
    this.data = {
      positions: stored.positions ?? {},
      settings: Object.assign({}, DEFAULT_SETTINGS, stored.settings)
    };
    this.applySettings();
    this.registerView(VIEW_TYPE_FB2, (leaf) => new Fb2View(leaf, this));
    this.registerView(VIEW_TYPE_TOC, (leaf) => new Fb2TocView(leaf));
    this.registerExtensions(["fb2", "zip"], VIEW_TYPE_FB2);
    this.addSettingTab(new Fb2SettingTab(this.app, this));
    this.addRibbonIcon("book-open-text", "FB2 Reader settings", () => {
      const setting = this.app.setting;
      setting.open();
      setting.openTabById(this.manifest.id);
    });
    this.addCommand({
      id: "open-toc",
      name: "Open table of contents",
      callback: () => this.activateTocLeaf()
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
  get fb2Settings() {
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
  getPosition(path) {
    return this.data.positions[path];
  }
  setPosition(path, index) {
    this.data.positions[path] = { index, ts: Date.now() };
    this.prunePositions();
    this.saveDataDebounced();
  }
  prunePositions() {
    const entries = Object.entries(this.data.positions);
    if (entries.length <= 300) return;
    entries.sort((a, b) => b[1].ts - a[1].ts);
    this.data.positions = Object.fromEntries(entries.slice(0, 300));
  }
  // --- table of contents ---
  onFb2Opened(view) {
    this.app.workspace.onLayoutReady(async () => {
      if (!this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC).length) {
        const leaf = this.app.workspace.getRightLeaf(false);
        await leaf?.setViewState({ type: VIEW_TYPE_TOC, active: false });
      }
      this.updateToc(view);
    });
  }
  updateToc(view) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
      if (leaf.view instanceof Fb2TocView) leaf.view.setSource(view);
    }
  }
  clearTocFor(view) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TOC)) {
      if (leaf.view instanceof Fb2TocView && leaf.view.sourceIs(view)) {
        leaf.view.setSource(null);
      }
    }
  }
  async activateTocLeaf() {
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
};
var Fb2SettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.renderToken = 0;
    this.plugin = plugin;
  }
  display() {
    void this.render();
  }
  async render() {
    const token = ++this.renderToken;
    const fonts = await getSystemFonts();
    if (token !== this.renderToken) return;
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("Theme").setDesc("Color scheme for the reading area.").addDropdown(
      (dd) => dd.addOption("", "Same as Obsidian").addOption("light", "Light").addOption("dark", "Dark").addOption("sepia", "Sepia").setValue(this.plugin.fb2Settings.theme).onChange((value) => {
        this.plugin.fb2Settings.theme = value;
        this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("Text color").setDesc("Color of the main book text. Default follows the theme.").addDropdown((dd) => {
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
    const fontSetting = new import_obsidian.Setting(containerEl).setName("Font");
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
      fontSetting.setDesc(
        "System font list is unavailable; type a font family name. Leave empty to use the Obsidian theme font."
      ).addText(
        (text) => text.setPlaceholder("Same as Obsidian").setValue(this.plugin.fb2Settings.fontFamily).onChange((value) => {
          this.plugin.fb2Settings.fontFamily = value.trim();
          this.plugin.saveSettings();
        })
      );
    }
    new import_obsidian.Setting(containerEl).setName("Font size").setDesc("Book text size in pixels (8\u201372).").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "8";
      text.inputEl.max = "72";
      text.setValue(String(this.plugin.fb2Settings.fontSize)).onChange((value) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 8 || n > 72) return;
        this.plugin.fb2Settings.fontSize = n;
        this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Line height").setDesc("Line spacing multiplier (1\u20133), e.g. 1.65.").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "1";
      text.inputEl.max = "3";
      text.inputEl.step = "0.05";
      text.setValue(String(this.plugin.fb2Settings.lineHeight)).onChange((value) => {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 1 || n > 3) return;
        this.plugin.fb2Settings.lineHeight = n;
        this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).addButton(
      (btn) => btn.setButtonText("Reset to defaults").onClick(() => {
        Object.assign(this.plugin.fb2Settings, DEFAULT_SETTINGS);
        this.plugin.saveSettings();
        this.display();
      })
    );
  }
};
