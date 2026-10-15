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
