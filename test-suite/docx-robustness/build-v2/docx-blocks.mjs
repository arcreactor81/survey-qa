// ../../node_modules/fflate/esm/index.mjs
import { createRequire } from "module";
var require2 = createRequire("/");
var _a;
var Worker;
var isMarkedAsUntransferable;
try {
  _a = require2("worker_threads"), Worker = _a.Worker, isMarkedAsUntransferable = _a.isMarkedAsUntransferable;
} catch (e) {
}
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
  for (var i2 = 0; i2 < 31; ++i2) {
    b[i2] = start += 1 << eb[i2 - 1];
  }
  var r = new i32(b[30]);
  for (var i2 = 1; i2 < 30; ++i2) {
    for (var j = b[i2]; j < b[i2 + 1]; ++j) {
      r[j] = j - b[i2] << 5 | i2;
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
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i2 = 0;
  var l = new u16(mb);
  for (; i2 < s; ++i2) {
    if (cd[i2])
      ++l[cd[i2] - 1];
  }
  var le = new u16(mb);
  for (i2 = 1; i2 < mb; ++i2) {
    le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        var sv = i2 << 4 | cd[i2];
        var r_1 = mb - cd[i2];
        var v = le[cd[i2] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i2 = 0; i2 < s; ++i2) {
      if (cd[i2]) {
        co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
      }
    }
  }
  return co;
});
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
  for (var i2 = 1; i2 < a.length; ++i2) {
    if (a[i2] > m)
      m = a[i2];
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
        for (var i2 = 0; i2 < hcLen; ++i2) {
          clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i2 = 0; i2 < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i2++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i2++] = c;
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
          var i2 = sym - 257, b = fleb[i2];
          add = bits(dat, pos, (1 << b) - 1) + fl[i2];
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
  for (var r = "", i2 = 0; ; ) {
    var c = d[i2++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i2 + eb > d.length)
      return { s: r, r: slc(d, i2 - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i2++] & 63) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i2++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i2++] & 63) << 6 | d[i2++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i2 = 0; i2 < dat.length; i2 += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i2, i2 + 16384));
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
  for (var i2 = 0; i2 < c; ++i2) {
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

// ../../worker-v2/src/extract/docx-blocks.ts
var PACKAGE_RELS = "_rels/.rels";
var FLAT_WORDML_PART = "(flat WordprocessingML)";
var DOCUMENT_XML = "word/document.xml";
var FOOTNOTES_XML = "word/footnotes.xml";
var ENDNOTES_XML = "word/endnotes.xml";
var COMMENTS_XML = "word/comments.xml";
var COMMENTS_EXT_XML = "word/commentsExtended.xml";
var HEADER_FOOTER_RE = /^word\/(header|footer)\d+\.xml$/;
var MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
var MAX_PART_BYTES = 50 * 1024 * 1024;
var MAX_TAG_SCANS = 2e5;
var WML_MAIN_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main"
];
var ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#[xX][0-9a-fA-F]+);/g;
var escapeRegExp = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function buildSyntax(prefix) {
  const p = escapeRegExp(prefix);
  return {
    prefix,
    rowSrc: `<${p}tr(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}tr>`,
    cellSrc: `<${p}tc(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}tc>`,
    paragraphSrc: `<${p}p(?=[\\s/>])[^>]*\\/>|<${p}p(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}p>`,
    runTokenSrc: `<${p}t(?=[\\s/>])[^>]*\\/>|<${p}t(?=[\\s>])[^>]*>([\\s\\S]*?)<\\/${p}t>|<${p}tab(?=[\\s/>])[^>]*\\/>|<${p}(?:br|cr)(?=[\\s/>])[^>]*\\/>`
  };
}
function detectPrefix(xml) {
  const declRe = /xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = declRe.exec(xml)) !== null) {
    const uri = m[2] !== void 0 ? m[2] : m[3];
    if (uri !== void 0 && WML_MAIN_NAMESPACES.includes(uri)) {
      const prefix = m[1];
      return prefix ? `${prefix}:` : "";
    }
  }
  return null;
}
function decodeXmlEntities(text) {
  return text.replace(ENTITY_RE, (match, entity) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
        if (Number.isInteger(code) && code >= 32 && code <= 1114111) return String.fromCodePoint(code);
        return match;
      }
    }
  });
}
function decodePart(bytes) {
  let label = "utf-8";
  if (bytes.length >= 2) {
    if (bytes[0] === 255 && bytes[1] === 254) label = "utf-16le";
    else if (bytes[0] === 254 && bytes[1] === 255) label = "utf-16be";
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
var stripFallback = (xml) => xml.replace(/<mc:Fallback(?=[\s>])[\s\S]*?<\/mc:Fallback>/g, "");
function neutralizeTextBoxes(xml, s) {
  const p = escapeRegExp(s.prefix);
  const txbxRe = new RegExp(`<${p}txbxContent(?=[\\s>])[\\s\\S]*?<\\/${p}txbxContent>`, "g");
  const openRe = new RegExp(`<${p}p(?=[\\s/>])`, "g");
  const closeRe = new RegExp(`<\\/${p}p>`, "g");
  const sentinel = `${s.prefix}boxpara`;
  return xml.replace(txbxRe, (block) => block.replace(openRe, `<${sentinel}`).replace(closeRe, `</${sentinel}>`));
}
function paragraphText(body, s) {
  const parts = [];
  const tokenRe = new RegExp(s.runTokenSrc, "g");
  const tabTag = `<${s.prefix}tab`;
  const brTag = `<${s.prefix}br`;
  const crTag = `<${s.prefix}cr`;
  let token;
  while ((token = tokenRe.exec(body)) !== null) {
    const raw = token[0];
    const captured = token[1];
    if (raw.startsWith(tabTag)) parts.push("	");
    else if (raw.startsWith(brTag) || raw.startsWith(crTag)) parts.push("\n");
    else if (captured !== void 0) parts.push(decodeXmlEntities(captured));
  }
  return parts.join("");
}
function headingLevel(body, s) {
  const p = escapeRegExp(s.prefix);
  const style = new RegExp(`<${p}pStyle(?=[\\s>])[^>]*${p}val="([^"]*)"`).exec(body);
  if (style) {
    const v = style[1] ?? "";
    const m = /^Heading(\d)$/i.exec(v) ?? /^Titre(\d)$/i.exec(v);
    if (m) return Number(m[1]);
    if (/^(Title|Subtitle)$/i.test(v)) return 1;
  }
  const outline = new RegExp(`<${p}outlineLvl(?=[\\s/>])[^>]*${p}val="(\\d+)"`).exec(body);
  if (outline) return Number(outline[1]) + 1;
  return 0;
}
var hasNumbering = (body, s) => new RegExp(`<${escapeRegExp(s.prefix)}numPr(?=[\\s/>])`).test(body);
var ALREADY_NUMBERED = /^\s*(?:\(?\d+[.)]|\(?[a-z][.)]|\(?[ivxlc]+[.)]|[-–—•*·])\s/i;
var SECTION_TEXT_RE = /^(?:section\s+[a-z0-9]+\b|part\s+[a-z0-9]+\b|appendix\b|module\s+[a-z0-9]+\b|screen(?:er|ing)?\s*:|classification\b)/i;
var clean = (t) => t.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").trim();
function topLevelSpans(xml, prefix, name) {
  const p = escapeRegExp(prefix);
  const re = new RegExp(`<${p}${name}(?=[\\s/>])[^>]*?(/?)>|<\\/${p}${name}>`, "g");
  const spans = [];
  let depth = 0;
  let openAt = -1;
  let bodyAt = -1;
  let scans = 0;
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (++scans > MAX_TAG_SCANS) return null;
    const isClose = m[0].startsWith(`</`);
    const selfClosing = m[1] === "/";
    if (selfClosing) continue;
    if (!isClose) {
      if (depth === 0) {
        openAt = m.index;
        bodyAt = m.index + m[0].length;
      }
      depth += 1;
    } else {
      depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && openAt >= 0) {
        spans.push({ start: openAt, end: re.lastIndex, inner: xml.slice(bodyAt, m.index) });
        openAt = -1;
      }
    }
  }
  return depth === 0 ? spans : null;
}
function isFlatWordML(bytes) {
  if (bytes.byteLength < 8) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, 2048));
  return /^\s*(﻿)?<\?xml/.test(head) && /<[A-Za-z0-9]*:?wordDocument[\s>]/.test(head);
}
function isOle2(bytes) {
  const magic = [208, 207, 17, 224, 161, 177, 26, 225];
  return bytes.byteLength >= 8 && magic.every((b, i2) => bytes[i2] === b);
}
function resolveMainPart(entries, partNames) {
  const rels = entries[PACKAGE_RELS];
  if (rels) {
    const xml = decodePart(rels);
    const re = /<Relationship[^>]*>/g;
    for (const tag of xml.match(re) ?? []) {
      if (!/Type\s*=\s*"[^"]*\/officeDocument"/.test(tag)) continue;
      const target = /Target\s*=\s*"([^"]+)"/.exec(tag)?.[1];
      if (!target) continue;
      const normalized = target.replace(/^\.?\//, "");
      if (entries[normalized]) return normalized;
    }
  }
  if (entries[DOCUMENT_XML]) return DOCUMENT_XML;
  const candidate = partNames.find((n) => /^word\/document\d*\.xml$/.test(n) && entries[n]);
  return candidate ?? DOCUMENT_XML;
}
function parseDocxBlocks(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`parseDocxBlocks: archive is ${bytes.byteLength} bytes, above the ${MAX_ARCHIVE_BYTES} limit`);
  }
  const partNames = [];
  let entries;
  if (isFlatWordML(bytes)) {
    entries = { [DOCUMENT_XML]: bytes };
    partNames.push(FLAT_WORDML_PART);
  } else {
    try {
      entries = unzipSync(bytes, {
        filter: (info) => {
          partNames.push(info.name);
          const wanted = info.name === PACKAGE_RELS || // ANY word/*.xml, because the main part is not always named document.xml. The
          // package relationships say which one it is, and they can only be consulted
          // after the archive is open — so the filter must not have thrown the answer
          // away by then. The extra parts are small (styles, numbering, settings).
          /^word\/[^/]+\.xml$/.test(info.name) || info.name === DOCUMENT_XML || info.name === FOOTNOTES_XML || info.name === ENDNOTES_XML || info.name === COMMENTS_XML || info.name === COMMENTS_EXT_XML || HEADER_FOOTER_RE.test(info.name);
          return wanted && Math.max(info.size, info.originalSize) <= MAX_PART_BYTES;
        }
      });
    } catch (err2) {
      if (isOle2(bytes)) {
        throw new Error(
          `parseDocxBlocks: this is a legacy Word 97-2003 document (OLE2 compound file), not a .docx. Re-save it as .docx \u2014 the binary format carries none of the part structure this parser reads.`
        );
      }
      throw new Error(
        `parseDocxBlocks: input is not a readable .docx (ZIP) archive: ${err2 instanceof Error ? err2.message : String(err2)}`
      );
    }
  }
  const coverage = {
    archiveParts: partNames.length,
    partsRead: [],
    partsSkipped: [],
    images: 0,
    imagesWithAltText: 0,
    unresolvedFieldCodes: 0,
    symbolRuns: 0,
    autoNumberedParagraphs: 0,
    problems: []
  };
  const mainPart = partNames[0] === FLAT_WORDML_PART ? DOCUMENT_XML : resolveMainPart(entries, partNames);
  const documentXml = entries[mainPart];
  if (!documentXml) {
    throw new Error(
      `parseDocxBlocks: the main document part ("${mainPart}") is not in the archive. Parts present: ${partNames.slice(0, 20).join(", ")}`
    );
  }
  const xml = decodePart(documentXml);
  let syntax = buildSyntax("w:");
  let blocks = scanBody(xml, syntax, coverage, "body");
  if (blocks.length === 0) {
    const detected = detectPrefix(xml);
    if (detected !== null && detected !== "w:") {
      syntax = buildSyntax(detected);
      blocks = scanBody(xml, syntax, coverage, "body");
    }
  }
  if (blocks.length === 0) {
    throw new Error(
      `parseDocxBlocks: no paragraphs could be parsed from "${DOCUMENT_XML}" (${xml.length} chars of XML). An empty requirement set from an unparsed document would read as "the document obliges nothing".`
    );
  }
  coverage.partsRead.push(partNames[0] === FLAT_WORDML_PART ? FLAT_WORDML_PART : mainPart);
  for (const [part, label] of [
    [FOOTNOTES_XML, "footnote"],
    [ENDNOTES_XML, "endnote"]
  ]) {
    const raw = entries[part];
    if (!raw) continue;
    const partXml = decodePart(raw);
    const s = partSyntax(partXml, syntax);
    const notes = scanNotes(partXml, s, label);
    blocks.push(...notes);
    coverage.partsRead.push(part);
    if (notes.length > 0) {
      coverage.problems.push(
        `${notes.length} ${label}(s) were read from ${part} and are labelled as such \u2014 questionnaires park conditional exceptions there, so weigh them as requirements, not decoration.`
      );
    }
  }
  const seenHeaderText = /* @__PURE__ */ new Set();
  for (const part of Object.keys(entries)) {
    if (!HEADER_FOOTER_RE.test(part)) continue;
    const partXml = decodePart(entries[part]);
    const s = partSyntax(partXml, syntax);
    const label = part.includes("header") ? "header" : "footer";
    let added = 0;
    for (const d of scanBody(partXml, s, coverage, label)) {
      const key = `${label}|${clean(d.text)}`;
      if (clean(d.text).length === 0 || seenHeaderText.has(key)) continue;
      seenHeaderText.add(key);
      blocks.push({ ...d, kind: "paragraph", origin: label });
      added += 1;
    }
    coverage.partsRead.push(part);
    if (added > 0) {
      coverage.problems.push(
        `${added} line(s) came from ${part}: a document stamped "DRAFT \u2014 NOT FOR FIELD" in its header is a different document from the one it looks like.`
      );
    }
  }
  const commentsRaw = entries[COMMENTS_XML];
  if (commentsRaw) {
    const partXml = decodePart(commentsRaw);
    const s = partSyntax(partXml, syntax);
    const resolvedKnown = entries[COMMENTS_EXT_XML] !== void 0;
    const comments = scanComments(partXml, s, resolvedKnown);
    blocks.push(...comments);
    coverage.partsRead.push(COMMENTS_XML);
    if (comments.length > 0) {
      coverage.problems.push(
        `${comments.length} Word comment(s) are present. A comment is a PROPOSAL, not the specification: they are labelled "comment" and the block pass may not turn one into an obligation on its own.`
      );
    }
  }
  for (const p of [FOOTNOTES_XML, ENDNOTES_XML, COMMENTS_XML]) {
    if (partNames.includes(p) && !coverage.partsRead.includes(p)) {
      coverage.partsSkipped.push({ part: p, reason: "present in the archive but too large to inflate safely" });
    }
  }
  for (const p of partNames) {
    if (!coverage.partsRead.includes(p) && !coverage.partsSkipped.some((x2) => x2.part === p) && /^word\/.*\.xml$/.test(p) && !/^word\/(theme|styles|settings|fontTable|webSettings|numbering|people|commentsIds|commentsExtended)/.test(p)) {
      coverage.partsSkipped.push({ part: p, reason: "not a text-bearing part this parser reads" });
    }
  }
  let section = null;
  const finished = [];
  let n = 0;
  for (const b of blocks) {
    const text = clean(b.text);
    if (text.length === 0) continue;
    if (b.kind === "heading" && b.origin === "body") section = text;
    n += 1;
    finished.push({ ...b, text, blockId: `b${String(n).padStart(4, "0")}`, section });
  }
  const counts = {
    paragraphs: finished.filter((b) => b.kind === "paragraph").length,
    tableCells: finished.filter((b) => b.kind === "table-cell").length,
    footnotes: finished.filter((b) => b.kind === "footnote").length,
    headings: finished.filter((b) => b.kind === "heading").length,
    listItems: finished.filter((b) => b.kind === "list-item").length
  };
  if (coverage.images > coverage.imagesWithAltText) {
    coverage.problems.push(
      `${coverage.images - coverage.imagesWithAltText} image(s) carry no alt text; whatever they mandate is unreadable to this parser and to any browser-driving tester.`
    );
  }
  if (coverage.unresolvedFieldCodes > 0) {
    coverage.problems.push(
      `${coverage.unresolvedFieldCodes} Word field code(s) (cross-references, sequence numbers) were left unresolved; their displayed value may differ from the text captured here.`
    );
  }
  if (coverage.autoNumberedParagraphs > 0) {
    coverage.problems.push(
      `${coverage.autoNumberedParagraphs} paragraph(s) are numbered by Word itself. The number is generated from numbering.xml at render time and is NOT text anywhere in the document, so each one carries a "[#]" placeholder rather than the identifier a reader would see.`
    );
  }
  return { blocks: finished, annotatedText: annotate(finished), counts, coverage };
}
var partSyntax = (partXml, fallback) => {
  const detected = detectPrefix(partXml);
  return detected === null || detected === fallback.prefix ? fallback : buildSyntax(detected);
};
function annotate(blocks) {
  const out = [];
  let lastTable = null;
  for (const b of blocks) {
    if (b.kind === "table-cell" && b.tableId !== lastTable) {
      out.push(`--- table ${b.tableId} ---`);
      lastTable = b.tableId;
    } else if (b.kind !== "table-cell") {
      lastTable = null;
    }
    out.push(`[${b.blockId}] ${describe(b)}${b.text.replace(/\n/g, " \u23CE ")}`);
  }
  return out.join("\n");
}
function describe(b) {
  const origin = b.origin === "body" ? "" : `${b.origin} `;
  if (b.kind === "heading") return `(${origin}heading) `;
  if (b.kind === "footnote") return `(${b.origin}) `;
  if (b.kind === "list-item") return `(${origin}list) `;
  if (b.kind === "table-cell" && b.coords) {
    const rh = b.coords.rowHeader ? ` row="${b.coords.rowHeader}"` : "";
    const ch = b.coords.colHeader ? ` col="${b.coords.colHeader}"` : "";
    return `(${origin}cell r${b.coords.row}c${b.coords.col}${rh}${ch}) `;
  }
  return origin ? `(${origin}) ` : "";
}
function scanBody(xmlRaw, s, coverage, origin) {
  const xml = neutralizeTextBoxes(stripFallback(xmlRaw), s);
  const tableSpans = topLevelSpans(xml, s.prefix, "tbl");
  if (tableSpans === null) {
    coverage.problems.push(
      `${origin}: <${s.prefix}tbl> tags do not balance, so TABLE STRUCTURE WAS NOT READ in this part. Cells are still captured as paragraphs where possible, but row/column pairing \u2014 which is what makes a routing matrix mean anything \u2014 is not available.`
    );
    return scanParagraphRange(xml, s, coverage, origin);
  }
  const out = [];
  let cursor = 0;
  let tableN = 0;
  for (const span of tableSpans) {
    out.push(...scanParagraphRange(xml.slice(cursor, span.start), s, coverage, origin));
    tableN += 1;
    out.push(...scanTable(span.inner, s, `t${tableN}`, coverage, origin));
    cursor = span.end;
  }
  out.push(...scanParagraphRange(xml.slice(cursor), s, coverage, origin));
  return out;
}
function scanParagraphRange(xml, s, coverage, origin) {
  const out = [];
  const paraRe = new RegExp(s.paragraphSrc, "g");
  let m;
  while ((m = paraRe.exec(xml)) !== null) {
    const body = m[1];
    if (body === void 0) continue;
    out.push(...paragraphDrafts(body, s, coverage, origin));
  }
  return out;
}
function paragraphDrafts(body, s, coverage, origin) {
  const out = [];
  countInlineArtifacts(body, s, coverage);
  let text = paragraphText(body, s);
  const numbered = hasNumbering(body, s);
  if (numbered && clean(text).length > 0 && !ALREADY_NUMBERED.test(text)) {
    text = `[#] ${text}`;
    coverage.autoNumberedParagraphs += 1;
  }
  if (clean(text).length > 0) {
    const level = headingLevel(body, s);
    const kind = origin === "body" && (level > 0 || SECTION_TEXT_RE.test(clean(text))) ? "heading" : numbered ? "list-item" : "paragraph";
    out.push({ kind, text, section: null, coords: null, tableId: null, origin });
  }
  for (const alt of imageAlts(body)) {
    coverage.images += 1;
    if (alt !== null) coverage.imagesWithAltText += 1;
    out.push({
      kind: "paragraph",
      text: alt === null ? "[image with no alt text \u2014 content unreadable]" : `[image: ${alt}]`,
      section: null,
      coords: null,
      tableId: null,
      origin: "image-alt"
    });
  }
  return out;
}
function countInlineArtifacts(body, s, coverage) {
  const p = escapeRegExp(s.prefix);
  const fields = body.match(new RegExp(`<${p}instrText(?=[\\s>])`, "g"));
  if (fields) coverage.unresolvedFieldCodes += fields.length;
  const syms = body.match(new RegExp(`<${p}sym(?=[\\s/>])`, "g"));
  if (syms) coverage.symbolRuns += syms.length;
}
function imageAlts(body) {
  const out = [];
  const drawingRe = /<(?:w:drawing|w:pict)(?=[\s>])[\s\S]*?<\/(?:w:drawing|w:pict)>/g;
  let m;
  while ((m = drawingRe.exec(body)) !== null) {
    const chunk = m[0];
    const descr = /descr="([^"]*)"/.exec(chunk)?.[1] ?? "";
    const alt = /\salt="([^"]*)"/.exec(chunk)?.[1] ?? "";
    const name = /<wp:docPr[^>]*\sname="([^"]*)"/.exec(chunk)?.[1] ?? "";
    const text = decodeXmlEntities(descr || alt || name).trim();
    out.push(text.length > 0 ? text : null);
  }
  return out;
}
function scanTable(tableXml, s, tableId, coverage, origin) {
  const nested = topLevelSpans(tableXml, s.prefix, "tbl");
  let body = tableXml;
  const nestedDrafts = [];
  if (nested === null) {
    coverage.problems.push(`${tableId}: nested <${s.prefix}tbl> tags do not balance; this table was read as flat paragraphs.`);
    return scanParagraphRange(tableXml, s, coverage, origin);
  }
  if (nested.length > 0) {
    let sliced = "";
    let cursor = 0;
    let n = 0;
    for (const span of nested) {
      sliced += tableXml.slice(cursor, span.start);
      n += 1;
      nestedDrafts.push(...scanTable(span.inner, s, `${tableId}.${n}`, coverage, origin));
      cursor = span.end;
    }
    sliced += tableXml.slice(cursor);
    body = sliced;
    coverage.problems.push(
      `${tableId} contains ${nested.length} nested table(s); each is reported as its own table (${tableId}.1 \u2026) so the parent's rows still pair correctly.`
    );
  }
  const rows = [];
  const rowRe = new RegExp(s.rowSrc, "g");
  let rowMatch;
  while ((rowMatch = rowRe.exec(body)) !== null) {
    const cells = [];
    const cellRe = new RegExp(s.cellSrc, "g");
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1] ?? "")) !== null) {
      const parts = [];
      const paraRe = new RegExp(s.paragraphSrc, "g");
      let paraMatch;
      while ((paraMatch = paraRe.exec(cellMatch[1] ?? "")) !== null) {
        if (paraMatch[1] === void 0) continue;
        for (const d of paragraphDrafts(paraMatch[1], s, coverage, origin)) {
          if (d.origin === "image-alt") parts.push(d.text);
          else if (clean(d.text).length > 0) parts.push(clean(d.text));
        }
      }
      cells.push(parts.join("\n"));
    }
    rows.push(cells);
  }
  const headerRow = rows[0] ?? [];
  const hasColHeaders = headerRow.filter((c) => c.trim().length > 0).length > 2;
  const out = [];
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const rowHeader = row[0]?.trim() ? row[0].trim() : null;
    for (let c = 0; c < row.length; c++) {
      const text = row[c];
      if (clean(text).length === 0) continue;
      out.push({
        kind: "table-cell",
        text,
        section: null,
        tableId,
        origin,
        coords: {
          row: r + 1,
          col: c + 1,
          rowHeader: c === 0 ? null : rowHeader,
          colHeader: hasColHeaders && r > 0 ? headerRow[c]?.trim() || null : null
        }
      });
    }
  }
  return [...out, ...nestedDrafts];
}
function scanNotes(xml, s, label) {
  const p = escapeRegExp(s.prefix);
  const noteRe = new RegExp(
    `<${p}(?:footnote|endnote)(?=[\\s>])([^>]*)>([\\s\\S]*?)<\\/${p}(?:footnote|endnote)>`,
    "g"
  );
  const out = [];
  let m;
  let n = 0;
  while ((m = noteRe.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    if (/type="(separator|continuationSeparator|continuationNotice)"/.test(attrs)) continue;
    const paraRe = new RegExp(s.paragraphSrc, "g");
    const parts = [];
    let pm;
    while ((pm = paraRe.exec(m[2] ?? "")) !== null) {
      const t = paragraphText(pm[1] ?? "", s);
      if (clean(t).length > 0) parts.push(clean(t));
    }
    if (parts.length === 0) continue;
    n += 1;
    out.push({
      kind: "footnote",
      text: parts.join("\n"),
      section: null,
      coords: null,
      tableId: null,
      origin: `${label} ${n}`
    });
  }
  return out;
}
function scanComments(xml, s, resolutionKnown) {
  const p = escapeRegExp(s.prefix);
  const re = new RegExp(`<${p}comment(?=[\\s>])([^>]*)>([\\s\\S]*?)<\\/${p}comment>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] ?? "";
    const author = /author="([^"]*)"/.exec(attrs)?.[1] ?? "unknown";
    const initials = /initials="([^"]*)"/.exec(attrs)?.[1] ?? "";
    const paraRe = new RegExp(s.paragraphSrc, "g");
    const parts = [];
    let pm;
    while ((pm = paraRe.exec(m[2] ?? "")) !== null) {
      const t = paragraphText(pm[1] ?? "", s);
      if (clean(t).length > 0) parts.push(clean(t));
    }
    if (parts.length === 0) continue;
    out.push({
      kind: "paragraph",
      text: parts.join("\n"),
      section: null,
      coords: null,
      tableId: null,
      origin: `comment by ${decodeXmlEntities(author)}${initials ? ` (${initials})` : ""} \u2014 PROPOSAL, resolution ${resolutionKnown ? "recorded in the document but not read here" : "unknown"}`
    });
  }
  return out;
}
export {
  annotate,
  describe,
  parseDocxBlocks
};
