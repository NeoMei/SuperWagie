# electron-builder inserts this file at the top of the NSIS installer and
# uninstaller scripts. The build.nsis.include option in package.json points
# here.
#
# An executable that declares no DPI awareness is scaled by Windows as a
# bitmap, so the installer and the uninstaller look blurred at a display scale
# factor above 100 percent. NSIS scales its own dialogs when the manifest
# declares DPI awareness.
!macro customHeader
  ManifestDPIAware true
!macroend

# Keep the scope selected from the existing installation or per-user default.
!macro customInstallMode
  !ifndef BUILD_UNINSTALLER
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  !endif
!macroend

# Existing clients pass --updated --force-run. Skip every wizard page during
# updates so the recorded directory is kept and the new app starts afterwards.
!macro customInit
  ${if} ${isUpdated}
    SetSilent silent
  ${endif}
!macroend
