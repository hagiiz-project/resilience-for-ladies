#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Word原稿(.docx) → knowledge.json 変換スクリプト

使い方:
    pip install python-docx
    python tools/build_knowledge_from_docx.py 原稿.docx knowledge.json

Word原稿の書式は docs/02-content-guide.md を参照。
行頭のラベルで判定するため、見出しスタイルは問いません。
"""
import sys, json, re
from datetime import date

try:
    from docx import Document
except ImportError:
    sys.exit("python-docx が必要です:  pip install python-docx")

# 既定の連絡先（原稿側で上書きしたい場合はガイド参照）
DEFAULT_CONTACTS = {
    "police": {"label": "身の危険",        "number": "110",          "tel": "110"},
    "ss":     {"label": "性暴力被害",      "number": "#8891",        "tel": "8891"},
    "dv":     {"label": "DV相談",          "number": "#8008",        "tel": "8008"},
    "yori":   {"label": "よりそいホットライン", "number": "0120-279-338", "tel": "0120279338"},
}

def slug(title, used):
    base = re.sub(r'[^a-z0-9]+', '-', title.lower()).strip('-') or "topic"
    s, i = base, 2
    while s in used:
        s = f"{base}-{i}"; i += 1
    used.add(s)
    return s

def parse(paras):
    # paras は (テキスト, 見出しか否か) のタプル列
    chunks, cur, used = [], None, set()
    def flush():
        if cur:
            # 空のempathyを補完（3種そろわない場合の保険）
            emp = cur["empathy"]
            for k in ("soft", "plain", "together"):
                emp.setdefault(k, emp.get("soft") or emp.get("plain") or emp.get("together") or "")
            chunks.append(cur)
    for raw, is_head in paras:
        line = raw.strip()
        if not line:
            continue
        # テーマの開始：行頭「■」または「# 」で判定（見出しスタイルの有無は問わない）
        m = re.match(r'^[■#]\s*(.+)$', line)
        if m:
            flush()
            title = m.group(1).strip()
            cur = {"id": slug(title, used), "section": "", "title": title,
                   "keywords": [], "urgent": False, "empathy": {},
                   "steps": [], "contacts": [], "body": ""}
            continue
        if cur is None:
            continue
        m = re.match(r'^(分類|緊急|キーワード|共感-そっと|共感-はっきり|共感-一緒に|行動|窓口|説明)\s*[:：]\s*(.*)$', line)
        if not m:
            # ラベルなしの続き行は body に追記
            cur["body"] = (cur["body"] + " " + line).strip()
            continue
        label, val = m.group(1), m.group(2).strip()
        if label == "分類":     cur["section"] = val
        elif label == "緊急":   cur["urgent"] = val in ("はい", "yes", "true", "True", "○", "◯")
        elif label == "キーワード":
            cur["keywords"] += [w.strip() for w in re.split(r'[,、，]', val) if w.strip()]
        elif label == "共感-そっと":   cur["empathy"]["soft"] = val
        elif label == "共感-はっきり": cur["empathy"]["plain"] = val
        elif label == "共感-一緒に":   cur["empathy"]["together"] = val
        elif label == "行動":
            if val: cur["steps"].append(val)
        elif label == "窓口":
            cur["contacts"] += [w.strip() for w in re.split(r'[,、，]', val) if w.strip()]
        elif label == "説明":
            cur["body"] = (cur["body"] + " " + val).strip()
    flush()
    return chunks

def main():
    if len(sys.argv) < 3:
        sys.exit("使い方: python build_knowledge_from_docx.py 原稿.docx knowledge.json")
    src, out = sys.argv[1], sys.argv[2]
    doc = Document(src)
    paras = [(p.text, False) for p in doc.paragraphs]
    chunks = parse(paras)
    if not chunks:
        sys.exit("テーマが見つかりませんでした。原稿に「# テーマ名」の行があるか確認してください。")
    data = {
        "version": str(date.today()),
        "source": f"{src} から自動生成",
        "note": "tools/build_knowledge_from_docx.py により生成。文面は監修済み原稿を反映。",
        "contacts": DEFAULT_CONTACTS,
        "chunks": chunks,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    print(f"✅ {len(chunks)} 件のテーマを {out} に書き出しました。")
    for c in chunks:
        warn = " ⚠emptyキーワード" if not c["keywords"] else ""
        print(f"   - {c['id']:14s} {c['title']}{warn}")

if __name__ == "__main__":
    main()
