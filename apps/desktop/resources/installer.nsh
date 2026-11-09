; Cadsense NSIS customizations. electron-builder includes this file (nsis.include
; in scripts/build-desktop-artifact.ts) ahead of its templates, so the macros
; below replace the stock ones in both the installer and the uninstaller.
;
; customCheckAppRunning replaces electron-builder's "is the app running" check.
; The stock check starts PowerShell three times (an availability probe, an
; execution-policy probe, then a Win32_Process path scan) even when nothing is
; running. The installer runs it, then the previous version's uninstaller runs
; it again: about 5.8s of a 10s Windows upgrade on a fast machine
; (scripts/windows-upgrade-timing.ps1).
;
; This check asks the question that matters instead: does a running process
; still map a Cadsense executable? Windows refuses write access to a running
; image, so a failed FileOpen means "still running". Backend children run as the
; main exe, so its lock covers them. During an update we poll while the quitting
; app exits, and hand over to the stock check (which finds and kills processes,
; and prompts the user) only if a lock remains.

; The stock check needs these; electron-builder skips them once
; customCheckAppRunning is defined.
!include "getProcessInfo.nsh"
Var pid

Var cadsenseLockedFile
Var cadsenseFileHandle
Var cadsenseLockPolls

; Sets $cadsenseLockedFile to FILE when it exists and a process holds it open
; as a running image. Leaves an earlier hit in place.
!macro cadsenseTestLock FILE
  ${if} $cadsenseLockedFile == ""
  ${andIf} ${FileExists} "${FILE}"
    ClearErrors
    ; Append mode opens for writing without truncating or touching the file.
    FileOpen $cadsenseFileHandle "${FILE}" a
    ${if} ${Errors}
      StrCpy $cadsenseLockedFile "${FILE}"
    ${else}
      FileClose $cadsenseFileHandle
    ${endIf}
  ${endIf}
!macroend

; Sets $cadsenseLockedFile to the first locked Cadsense executable, or "".
!macro cadsenseFindLockedExecutable
  StrCpy $cadsenseLockedFile ""
  !insertmacro cadsenseTestLock "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  !insertmacro cadsenseTestLock "$INSTDIR\resources\resource-monitor\cadsense-resource-monitor.exe"
!macroend

!macro customCheckAppRunning
  !insertmacro cadsenseFindLockedExecutable
  ${if} ${isUpdated}
    ; electron-updater starts the installer just before the app quits. Give the
    ; app up to 5s to exit before falling back to the stock kill path.
    StrCpy $cadsenseLockPolls 0
    ${while} $cadsenseLockedFile != ""
      ${if} $cadsenseLockPolls >= 50
        ${break}
      ${endIf}
      Sleep 100
      IntOp $cadsenseLockPolls $cadsenseLockPolls + 1
      !insertmacro cadsenseFindLockedExecutable
    ${endWhile}
  ${endIf}
  ${if} $cadsenseLockedFile != ""
    DetailPrint `"$cadsenseLockedFile" is in use; using the full running-app check.`
    !insertmacro IS_POWERSHELL_AVAILABLE
    !insertmacro _CHECK_APP_RUNNING
  ${endIf}
!macroend
