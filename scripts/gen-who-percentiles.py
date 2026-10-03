#!/usr/bin/env python3
"""WHO Child Growth Standards の LMS 表から、0〜36ヶ月の月ごとのパーセンタイル値を計算して
public/js/who-percentiles.js を生成する。

元データ: npm パッケージ who-growth-standards@1.0.1 に含まれる WHO 公式の LMS 表
（WHO の expanded tables を転記したもの。パッケージのコードは実行せず、数表だけを読み取る）

  curl -sSL https://registry.npmjs.org/who-growth-standards/-/who-growth-standards-1.0.1.tgz | tar xz -C /tmp
  python3 scripts/gen-who-percentiles.py /tmp/package/dist/index.js
"""
import json
import math
import os
import re
import sys

DAYS_PER_MONTH = 30.4375
MAX_MONTH = 36
# 3, 10, 25, 50, 75, 90, 97 パーセンタイルの z 値
Z = [-1.880794, -1.281552, -0.674490, 0.0, 0.674490, 1.281552, 1.880794]
TABLES = {"weight": "WFA", "length": "LHFA", "head": "HCFA"}
SEXES = {"male": "BOYS", "female": "GIRLS"}


def read_table(src, name):
    m = re.search(r"var %s = \{.*?start: (\d+),\s*step: (\d+),\s*lms: \[(.*?)\]\s*\}" % name, src, re.S)
    if not m:
        raise SystemExit(f"table {name} not found")
    start, step = int(m.group(1)), int(m.group(2))
    rows = [tuple(float(v) for v in r.split(",")) for r in re.findall(r"\[([-\d.e]+, [-\d.e]+, [-\d.e]+)\]", m.group(3))]
    return start, step, rows


def value_at(l, m, s, z):
    return m * math.exp(s * z) if abs(l) < 1e-9 else m * (1 + l * s * z) ** (1 / l)


def main(path):
    src = open(path, encoding="utf-8").read()
    out = {}
    for key, prefix in TABLES.items():
        out[key] = {}
        for sex, suffix in SEXES.items():
            start, step, rows = read_table(src, f"{prefix}_{suffix}")
            series = []
            for month in range(MAX_MONTH + 1):
                day = round(month * DAYS_PER_MONTH)
                l, m, s = rows[(day - start) // step]
                series.append({"month": month, "p": [round(value_at(l, m, s, z), 2) for z in Z]})
            out[key][sex] = series
    body = (
        "// 自動生成ファイル（scripts/gen-who-percentiles.py）。手で編集しないでください。\n"
        "// 出典: WHO Child Growth Standards（https://www.who.int/tools/child-growth-standards）の LMS 表から算出\n"
        "// 0〜36ヶ月の月ごとの 3, 10, 25, 50, 75, 90, 97 パーセンタイル値。weight: kg / length: cm / head: cm\n"
        f"export const WHO_PERCENTILES = {json.dumps(out, separators=(',', ':'))};\n"
    )
    dest = os.path.join(os.path.dirname(__file__), "..", "public", "js", "who-percentiles.js")
    with open(dest, "w", encoding="utf-8") as f:
        f.write(body)
    print("wrote", os.path.normpath(dest))


if __name__ == "__main__":
    main(sys.argv[1])
