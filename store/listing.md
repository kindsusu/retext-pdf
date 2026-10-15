# Microsoft Store 제출서 문안 (Partner Center에 붙여 넣을 내용)

작성 2026-10-02(2026-10-03 AI 기능 제거·앱 이름 변경 반영, 2026-10-14 5.0.0 기능 반영, 2026-10-15 5.1.0 기능 반영) · 기준 버전 5.1.0 · 언어: 한국어(ko-KR), 영어(en-US)

## 기본 정보

| 항목 | 값 |
|---|---|
| 앱 이름(예약) | Retext PDF |
| 가격 | 무료 |
| 범주 | 생산성(Productivity) |
| 개인정보 처리방침 URL | https://github.com/kindsusu/retext-pdf/blob/main/PRIVACY.md |
| 웹 사이트 | https://github.com/kindsusu/retext-pdf |
| 지원 연락처 | https://github.com/kindsusu/retext-pdf/issues |
| 스크린샷 | `store/screenshot-1-pdf.png`, `-2-edit.png`, `-3-redact.png`, `-4-markdown.png` (1366×768, 가상 문서만 표시) |
| 앱 타일 아이콘 | 패키지에 포함(`build/appx/`). 목록용 300×300 로고가 따로 필요하면 `build/icon.png` 사용 |

## 제한된 기능(runFullTrust) 사용 사유

Partner Center가 묻는 "이 기능을 사용하는 이유"에 넣는다. 영어로 쓴다(심사자용).

> Retext PDF is an Electron desktop app. runFullTrust is required to read and write the user's local PDF and Markdown files, to run its built-in local HTTP server bound to 127.0.0.1 that renders and edits PDFs. The app does not send documents or any other data off the user's PC.

## 연령 등급(IARC 설문) 권장 답

- 앱 유형: 유틸리티·생산성(게임 아님)
- 폭력·성적 내용·약물·도박·욕설: 없음
- 사용자 간 소통·콘텐츠 공유: 없음(앱 안에서 다른 사용자와 연결되지 않음)
- 위치 공유·개인정보 공유: 없음
- 디지털 상품 구매: 없음
- 무제한 인터넷 접근(웹 브라우저 기능): 없음. 링크는 기본 브라우저로 넘긴다
- 예상 등급: 전체 이용가(3+)

## 추가 라이선스 조항

Partner Center → 속성 → "추가 라이선스 조항"에 넣는다. 저장소 `LICENSE`의 요지다.

**한국어**

> 개인이 비상업적 목적으로 사용하는 것은 무료입니다. 회사·기관·단체가 업무에 쓰거나 상업적으로 사용하려면 저작권자(kindsusu)의 사전 서면 승인이 필요합니다. 승인 문의: https://github.com/kindsusu/retext-pdf/issues. 전체 조항: https://github.com/kindsusu/retext-pdf/blob/main/LICENSE. 이 소프트웨어는 "있는 그대로" 제공되며, 중요한 문서는 사본으로 작업하고 결과를 직접 확인하십시오.

**English**

> Free for personal, non-commercial use. Use by companies, institutions or organizations for their work, or any commercial use, requires prior written approval from the copyright holder (kindsusu). Requests: https://github.com/kindsusu/retext-pdf/issues. Full terms: https://github.com/kindsusu/retext-pdf/blob/main/LICENSE. Provided "as is"; work on copies of important documents and verify results yourself.

---

## 한국어 목록(ko-KR)

### 짧은 설명

PDF 글자를 직접 고치고, 개인정보를 실제로 지워서 가리는 PC용 PDF·Markdown 편집기.

### 설명

Retext PDF는 PDF를 그림처럼 덮어쓰는 대신 문서 안의 글자를 직접 고치는 PC용 편집기입니다.

글줄을 누르면 그 줄 전체가 편집 창에 들어옵니다. 고친 글자는 원래 글꼴로 다시 그립니다. 원래 글꼴에 없는 글자는 맑은 고딕으로 그리며 [폰트 맞추기]로 다른 글꼴을 지정할 수 있습니다. 줄이 넘치면 줄바꿈하거나 글자를 줄여 폭에 맞춥니다.

가리기는 글자를 검은 상자로 덮기만 하지 않습니다. PDF에서 글자를 실제로 지우고, 페이지 텍스트를 다시 읽어 지워졌는지 확인합니다. 사각형으로 가리면 그 아래 글자와 그림 픽셀, 겹치는 주석까지 지웁니다. 이메일·전화번호·주민등록번호·사업자등록번호·카드번호를 찾아 한꺼번에 가리고, 문서 정보·메타데이터·첨부 파일·스크립트 같은 숨은 데이터도 지울 수 있습니다.

형광펜·밑줄·취소선·메모·도형·펜 주석을 달 수 있고, 다른 PDF 뷰어에서도 그대로 보입니다. 워터마크, 머리말·꼬리말, 목차(책갈피)와 문서 정보도 고칠 수 있습니다. 쪽 정리·회전·순서 바꾸기·분할·병합, 이미지로 내보내기, 이미지 삽입, 용량 줄이기를 한 화면에서 할 수 있습니다. 쪽 번호 넣기, 도장·서명 보관함, 글 상자, 인쇄도 지원합니다. 암호가 걸린 PDF를 열 수 있고, 암호를 걸어 저장할 수도 있습니다(AES-256). 긴 작업은 진행 창에서 취소할 수 있고, 거의 모든 편집은 실행 취소할 수 있습니다.

Markdown 문서는 왼쪽에서 고치고 오른쪽에서 바로 결과를 봅니다.

문서는 PC 안에서만 처리하며 PC 밖으로 보내지 않습니다. 계정이나 인터넷 연결 없이 모든 기능을 쓸 수 있고, 개발자는 어떤 데이터도 수집하지 않습니다.

개인의 비상업적 사용은 무료입니다. 회사·기관의 업무 사용은 사전 승인이 필요합니다(추가 라이선스 조항 참고).

### 주요 기능 (최대 20개, 각 200자)

1. PDF 글자를 줄·문단 단위로 직접 고치기 — 원래 글꼴과 굵게·기울임·색 유지
2. 실제로 지우는 가리기 — 글자를 PDF에서 제거하고 다시 추출해 확인, 사각형 가리기는 아래 그림 픽셀과 주석까지 지움
3. 개인정보 찾아 가리기 — 이메일·전화번호·주민등록번호·사업자등록번호·카드번호·정규식
4. 숨은 데이터 제거 — 문서 정보·메타데이터·첨부 파일·스크립트
5. 주석 — 형광펜·밑줄·취소선·메모·사각형·원·선·펜, 주석 목록과 모두 고정
6. 워터마크(글자·그림)와 머리말·꼬리말(쪽 번호·날짜·파일 이름 표시)
7. 목차(책갈피)와 문서 정보 고치기
8. 폰트 맞추기와 폭 맞춤 — 설치 글꼴이나 TTF로 비슷한 글꼴 지정, 넘치는 줄은 줄바꿈 또는 글자 크기 줄이기
9. 여러 쪽 골라 끌어 옮기기, 회전, 추출, 빈 쪽·쪽 복제·PDF 끼워 넣기
10. PDF 분할과 여러 파일 병합
11. 페이지를 PNG·JPEG 이미지로 내보내기, 이미지 PDF로 저장
12. 이미지 삽입, 드래그 이동, 크기 조절
13. 용량 줄이기 — 목표 용량 지정, 여러 파일 한 번에
14. 문서 안 검색과 강조
15. Markdown 편집과 실시간 미리보기
16. 긴 작업 진행 표시와 취소, 실행 취소·다시 실행
17. 문서는 PC 안에서만 처리, 데이터 수집 없음
18. 암호 PDF 열기와 암호 걸어 저장(AES-256, 인쇄·복사·수정 제한 선택)
19. 쪽 번호(모양 4가지, 위치 5곳), 글 상자, 도장·서명 보관함(투명 PNG 그대로)
20. 인쇄 — 저장하지 않은 수정도 반영, 고른 쪽만 인쇄

### 이 버전의 새로운 기능 (5.1.0)

보안 수정: 4.0.1~5.0.0의 사각형 [가리기]는 덮개만 그려 그 아래 글자와 그림이 파일에 남아 있었습니다. 5.1.0은 상자 아래 글자를 지우고 그림 픽셀을 칠하며 겹치는 주석도 지웁니다. 이전 버전에서 사각형 가리기를 쓴 파일은 다시 열어 같은 자리를 가려 주세요. 줄 편집 창의 [선택 글자 가리기]·[줄 전체 가리기]는 원래부터 글자를 실제로 지웠습니다.
새 화면: 홈·주석·쪽·문서·보안 탭으로 나눈 리본, 왼쪽 패널 파일·쪽·주석·목차 탭, 여러 쪽 끌어 옮기기 개선.
새 기능: 주석(형광펜·밑줄·취소선·메모·도형·선·펜, 목록, 모두 고정), 워터마크, 머리말·꼬리말, 목차·문서 정보 고치기, 이미지 PDF로 저장, 개인정보 찾아 가리기, 같은 영역 여러 쪽 가리기, 숨은 데이터 제거.
개선: 줄 묶기(양식 칸, 위첨자·아래첨자, 회전한 글자, 양쪽 맞춤, 표와 2단), 굵게·색이 섞인 줄도 모양을 지키며 고치기, 두 번 클릭으로 문단 고치기.

### 검색어 (최대 7개)

PDF 편집기, PDF 수정, PDF 가리기, 개인정보 가리기, PDF 병합, PDF 분할, 마크다운

---

## English listing (en-US)

### Short description

A desktop PDF and Markdown editor that edits the real text in PDFs and redacts by actually removing it.

### Description

Retext PDF edits the text inside a PDF instead of painting over it.

Click a line and the whole line opens in the editor. Edited text is redrawn in the original font. Characters the original font lacks are drawn in Malgun Gothic, and Match Font lets you pick another font. Lines that grow too long are wrapped or shrunk to fit.

Redaction does more than draw a black box. It removes the characters from the PDF and re-extracts the page text to confirm they are gone. A rectangle redaction also removes the text, image pixels and overlapping annotations under the box. Find email addresses, phone numbers, ID numbers, business registration numbers and card numbers and redact them in one go, and remove hidden data such as document info, metadata, attachments and scripts.

Add highlight, underline, strikeout, note, shape and pen annotations that other PDF viewers show too. Add watermarks, headers and footers, and edit the outline (bookmarks) and document info. Extract, delete, rotate and reorder pages, split and merge PDFs, export pages as images, insert images and reduce file size, all in one window. Add page numbers, keep a stamp and signature library, add text boxes and print. Open password-protected PDFs and save copies with a password (AES-256). Long operations show progress and can be cancelled, and almost every edit can be undone.

Markdown documents are edited on the left with a live preview on the right.

Documents are processed only on your PC and never leave it. Every feature works without an account or an internet connection, and the developer collects no data.

Free for personal, non-commercial use. Work use by companies or institutions requires prior approval (see additional license terms).

### Product features (up to 20, 200 characters each)

1. Edit PDF text by line or paragraph, keeping the original font, bold, italic and color
2. True redaction: text is removed from the PDF and re-extracted to verify, and rectangle redaction also clears image pixels and annotations under the box
3. Find and redact personal data: email, phone, ID, business registration and card numbers, or your own pattern
4. Remove hidden data: document info, metadata, attachments and scripts
5. Annotations: highlight, underline, strikeout, note, rectangle, ellipse, line and pen, with a list and flatten all
6. Text or image watermarks, and headers and footers with page number, date and file name
7. Edit the outline (bookmarks) and document info
8. Match fonts using an installed font or a TTF file, and fit long lines by wrapping or shrinking
9. Drag several pages to reorder, rotate, extract, add blank pages, duplicate pages or add pages from another PDF
10. Split PDFs and merge multiple files
11. Export pages as PNG or JPEG images, or save an image-only PDF
12. Insert, move and resize images
13. Reduce file size to a target, for many files at once
14. Search within documents with highlights
15. Markdown editing with live preview
16. Progress and cancel for long operations, undo and redo
17. Documents stay on your PC, no data collection
18. Open password-protected PDFs and save copies with a password (AES-256, optional print, copy and edit limits)
19. Page numbers in 4 styles and 5 positions, text boxes, and a stamp and signature library
20. Print, including unsaved edits or only the selected pages

### What's new in this version (5.1.0)

Security fix: in 4.0.1 to 5.0.0 the rectangle redact tool only drew a cover box, and the text and images under it stayed in the file. 5.1.0 removes the text under the box, paints over the image pixels and removes overlapping annotations. If you used rectangle redaction in an earlier version, open those files again and redact the same areas. Line-based redaction in the line editor always removed the text.
New look: a ribbon with Home, Annotate, Pages, Document and Security tabs, a left panel with Files, Pages, Annotations and Outline tabs, and improved multi-page dragging.
New: annotations (highlight, underline, strikeout, note, shapes, line, pen, list, flatten all), watermarks, headers and footers, outline and document info editing, image-only PDF, find and redact personal data, the same area on several pages, and hidden data removal.
Improved: text grouping (form fields, superscripts and subscripts, rotated text, justified lines, tables and two columns), editing lines with mixed bold or color keeps each style, and double-click to edit a paragraph.

### Search terms (up to 7)

PDF editor, edit PDF text, PDF redaction, redact, merge PDF, split PDF, Markdown
