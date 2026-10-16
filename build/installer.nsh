; Retext PDF NSIS 설치 프로그램 추가 스크립트 (electron-builder nsis.include)
;
; v6.1: Markdown(.md·.markdown)·텍스트(.txt)·그림(.png·.jpg·.jpeg·.webp·.gif·.bmp)을 Windows "연결 프로그램" 목록에만 올린다.
; package.json build.fileAssociations(.pdf)는 electron-builder의 APP_ASSOCIATE를 쓰는데, 그 매크로는
;   HKCU\Software\Classes\.<확장자>(기본값) = ProgID
; 를 써서 다른 기본 앱이 없으면 기본 앱 자리를 가져가고, 지울 때 그 기본값을 되돌리지 않는다(templates/nsis/include/FileAssociation.nsh).
; 메모장·사진 앱이 쓰는 확장자를 그렇게 건드리지 않도록, 여기서는 확장자 키의 기본값은 그대로 두고
;   HKCU\Software\Classes\.<확장자>\OpenWithProgids  값 RetextPDF.Text / RetextPDF.Image (REG_NONE)
; 만 더한다 — 탐색기 "연결 프로그램"에 Retext PDF가 보이고, 기본 앱은 사용자가 고르기 전까지 바뀌지 않는다.
; 지울 때(customUnInstall)는 우리가 더한 값과 ProgID 키만 지운다.
; (SHELL_CONTEXT = 설치 범위: 사용자별 설치면 HKCU, 모든 사용자 설치면 HKLM — electron-builder와 같다)

!macro retextOpenWith EXT PROGID
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro retextProgId PROGID DESCRIPTION
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open" "" "Retext PDF로 열기"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro retextUnOpenWith EXT PROGID
  ; 값 하나만 지운다 — 키는 남긴다(DeleteRegKey /ifempty는 값이 있어도 하위 키만 없으면 지워 다른 앱의 등록까지 날린다)
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro customInstall
  !insertmacro retextProgId "RetextPDF.Text" "텍스트 문서 (Retext PDF)"
  !insertmacro retextProgId "RetextPDF.Image" "그림 (Retext PDF에서 PDF로 열기)"
  !insertmacro retextOpenWith "md" "RetextPDF.Text"
  !insertmacro retextOpenWith "markdown" "RetextPDF.Text"
  !insertmacro retextOpenWith "txt" "RetextPDF.Text"
  !insertmacro retextOpenWith "png" "RetextPDF.Image"
  !insertmacro retextOpenWith "jpg" "RetextPDF.Image"
  !insertmacro retextOpenWith "jpeg" "RetextPDF.Image"
  !insertmacro retextOpenWith "webp" "RetextPDF.Image"
  !insertmacro retextOpenWith "gif" "RetextPDF.Image"
  !insertmacro retextOpenWith "bmp" "RetextPDF.Image"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  !insertmacro retextUnOpenWith "md" "RetextPDF.Text"
  !insertmacro retextUnOpenWith "markdown" "RetextPDF.Text"
  !insertmacro retextUnOpenWith "txt" "RetextPDF.Text"
  !insertmacro retextUnOpenWith "png" "RetextPDF.Image"
  !insertmacro retextUnOpenWith "jpg" "RetextPDF.Image"
  !insertmacro retextUnOpenWith "jpeg" "RetextPDF.Image"
  !insertmacro retextUnOpenWith "webp" "RetextPDF.Image"
  !insertmacro retextUnOpenWith "gif" "RetextPDF.Image"
  !insertmacro retextUnOpenWith "bmp" "RetextPDF.Image"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\RetextPDF.Text"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\RetextPDF.Image"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
