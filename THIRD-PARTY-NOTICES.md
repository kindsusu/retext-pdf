# Third-party notices · 제3자 구성요소

Retext PDF bundles the components below. Each remains under its own license.
Retext PDF에 들어 있는 아래 구성요소는 각자의 라이선스를 따릅니다.

## PDF engine · 글꼴 · 화면

| Component | Version | License |
|---|---|---|
| PDFium (via @embedpdf/pdfium, WebAssembly) | 2.x | Apache-2.0 (PDFium), MIT (@embedpdf/pdfium) |
| fontkit | 2.x | MIT |
| jpeg-js | 0.4.x | BSD-3-Clause |
| marked | 15.x | MIT |
| DOMPurify | 3.x | Apache-2.0 OR MPL-2.0 |
| Electron (installer only) | 44.x | MIT |

## 글자 인식(OCR) — v6

글자 인식은 앱 안에서만 돌아갑니다. 엔진(WebAssembly)과 인식 데이터는 설치 파일에 들어 있고, 실행 중에 인터넷에서 아무것도 받지 않습니다
(작업 스레드 `app/ocr-worker.js`가 네트워크 호출을 막고, 인식 데이터는 처음 쓸 때 아래 SHA-256과 맞는지 확인합니다).
OCR runs entirely on the local PC. The engine and language data ship with the app; nothing is downloaded at run time.

| Component | Version | License | Source |
|---|---|---|---|
| tesseract.js | 7.0.0 (exact) | Apache-2.0 | https://github.com/naptha/tesseract.js (npm `tesseract.js@7.0.0`) |
| tesseract.js-core (Tesseract OCR 5 + Leptonica compiled to WebAssembly) | 7.0.0 (exact) | Apache-2.0 (Tesseract, tesseract.js-core), BSD-2-Clause (Leptonica), libpng / zlib / libjpeg licenses | https://github.com/naptha/tesseract.js-core (npm `tesseract.js-core@7.0.0`) — only the three Node builds the worker loads (`tesseract-core`, `-simd`, `-relaxedsimd` .js/.wasm) are packaged |
| regenerator-runtime | 0.13.11 | MIT | npm |
| is-url | 1.2.4 | MIT | npm |
| bmp-js | 0.1.0 | MIT | npm |
| wasm-feature-detect | 1.9.0 | Apache-2.0 | npm |
| node-fetch (not used at run time: the OCR worker blocks network access) | 2.7.0 | MIT | npm |

### Tesseract language data (tessdata_fast) · 인식 데이터

Source repository: https://github.com/tesseract-ocr/tessdata_fast — commit `87416418657359cb625c412a48b6e1d6d41c29bd` (2024-08-01).
License: Apache-2.0 (copy in `app/vendor/ocr/LICENSE`, git blob `d645695673349e3947e8e5ae42332d0ac3164cd7`).
The git blob SHA-1 of each file was checked against the GitHub contents API for that commit when it was added (2026-10-15).

| File (app/vendor/ocr/) | Language | Bytes | SHA-256 | git blob SHA-1 | Download URL |
|---|---|---|---|---|---|
| kor.traineddata | 한국어 | 1,677,415 | `6b85e11d9bbf07863b97b3523b1b112844c43e713df8b66418a081fd1060b3b2` | `60986d44497689f3abace0b148199476d93292e1` | https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/kor.traineddata |
| eng.traineddata | 영어 | 4,113,088 | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` | `bbef4675053b5b468cdb477053e28b1c698ba08e` | https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/87416418657359cb625c412a48b6e1d6d41c29bd/eng.traineddata |

Not bundled: `osd.traineddata` (orientation/script detection, 10.5 MB and it needs the legacy engine). Page orientation is
instead guessed by reading a half-size image in four directions when the first pass finds almost nothing; small skew is
corrected by Tesseract's own line-angle estimate (`rotateAuto`).
tessdata_best was not used: its float models need SSE code that the WebAssembly build does not have (the worker aborts).

## 맞춤법 검사(Spell checking) — v6 Wave F

맞춤법 검사도 앱 안에서만 돌아갑니다. 엔진(WebAssembly)과 사전은 설치 파일에 들어 있고, 실행 중에 인터넷에서 아무것도 받지 않습니다
(작업 스레드 `app/spell-worker.js`가 네트워크 호출을 막고, 사전은 처음 쓸 때 아래 크기·SHA-256과 맞는지 확인합니다 — `app/spell-check.js`).
사용자가 [사전에 추가]한 낱말은 앱 데이터 폴더의 `spell-user-dict.json`에만 저장됩니다.
Spell checking runs entirely on the local PC (worker thread with network access blocked); nothing is downloaded at run time.

| Component | Version | License (choice) | Source |
|---|---|---|---|
| hunspell-wasm (Hunspell 1.7 compiled to WebAssembly + TypeScript wrapper by Rotem Dan) | 0.3.0 (exact) | MPL-1.1 / GPL-2.0 / LGPL-2.0 tri-license — used under **MPL-1.1**; license texts in `node_modules/hunspell-wasm/COPYING.MPL`, `COPYING`, `COPYING.LESSER` | https://github.com/rotemdan/hunspell-wasm (npm `hunspell-wasm@0.3.0`, integrity `sha512-D7/QLaeekJYYlE37D7KBq5v38vL4tQutTFIUBOUGBl0g9la8OUgfSd8+XbwNPV5uYMHS13umXR9MtdAxStpHJg==`); Hunspell source: https://github.com/hunspell/hunspell |
| hunspell-dict-ko (Korean Hunspell dictionary = spellcheck-ko/hunspell-dict-ko **0.6.1**, packaged for npm by OJ Kwon) | 0.1.0 (exact) | Code and the galkwi word list: MPL-1.1 / GPL-2.0 / LGPL-2.1 tri-license — used under **MPL-1.1**; other word data (dict-ko-builtins, dict-ko-galkwi-ccby): **CC-BY-4.0** (attribution: © 2008–2017 spellcheck-ko contributors). License texts in `node_modules/hunspell-dict-ko/LICENSE*` | https://github.com/spellcheck-ko/hunspell-dict-ko/releases/tag/0.6.1 · npm `hunspell-dict-ko@0.1.0` (integrity `sha512-wJ2KHP30AaXcKvz+6iOvJrfN96/JXN5LoznOY+EuP6+162Zh3GTh4Gnr1tbexmROM1b90qNzSPiD8H+TXBZTfg==`) |
| dictionary-en (en_US Hunspell dictionary from SCOWL 2020.12.07, packaged by Titus Wormer) | 4.0.0 (exact) | MIT AND BSD (SCOWL / Kevin Atkinson et al.); full text in `node_modules/dictionary-en/license` | https://github.com/wooorm/dictionaries/tree/main/dictionaries/en · http://wordlist.aspell.net (npm `dictionary-en@4.0.0`, integrity `sha512-3NHnE1uq33ZE/CIwaZ6gqxa4BnglHnxeAcTM0GJ7cmtRGcvX9InMK/IqLtYcUMFCUpUNgybH+DzkqdgAo3F1zg==`) |

The files are used unmodified. Sizes and SHA-256 checked at first use:

| File | Bytes | SHA-256 |
|---|---|---|
| hunspell-dict-ko/ko.aff | 5,786,653 | `de5c54d313dbbf781a8b521129ca3ec3e0fa128263aeefd2f31e339a85a9f53e` |
| hunspell-dict-ko/ko.dic | 11,128,599 | `7ae3b3ca5ea1b344129d2e425c46e77fc36dc353c2afe8fb0f4b5093ff92d873` |
| dictionary-en/index.aff | 3,086 | `8ae1f19d4840d957728ad90555d5a8dff6cc5c046279c95ff0c00fc0a0136c7b` |
| dictionary-en/index.dic | 551,762 | `f0b1a234bd178bdd01875b2a392a9647f888b8fe879f79c52aae62c2759b3647` |
| hunspell-wasm/wasm/hunspell.wasm | 811,567 | `72152324049c9215da17abceb12555b3ef9094c0524327e660f8145aaa9c68e0` |

Not used: the newer Korean dictionary `dictionary-ko@2.0.0` (= hunspell-dict-ko 0.7.94, with National Institute of Korean
Language word data). Its built `ko.aff`/`ko.dic` are licensed GPL-3.0 as a combined work, which does not fit this app's
license; in our test it flagged about the same words (README.ko.md: 58 vs 51 of 860 distinct words).
`nspell@2.1.5` (pure JS) was not used: with this Korean dictionary it accepted the misspellings 됬다 · 안되요 · 몇일 as correct
(it does not apply the dictionary's rules — measured 2026-10-15) and used about twice the memory.
