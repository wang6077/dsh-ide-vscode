# Icon extractor for dsh-ide-vscode (Windows only).
#
# Prints one line per requested extension:  <ext><TAB><base64 png>
#
# The icon comes from the shell itself (`SHGetFileInfo` with
# `SHGFI_USEFILEATTRIBUTES`, i.e. "what would Explorer draw for this kind of
# file"), so the panel shows exactly the icons the user's own system uses --
# .txt the Notepad page, .bat the gear window, .zip the compressed folder, and
# the generic blank page for anything the system does not associate.
#
# Invoked by lib/index.js with stdio redirected to temp files (the DSH sandbox
# cannot always open a pipe), so nothing may be written to stdout except the
# tab-separated lines below.

param([Parameter(Mandatory = $true)][string]$Exts)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshShellIcon
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFO
    {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hIcon);
}
'@ -ReferencedAssemblies System.Drawing

$SHGFI_ICON = 0x00000100
$SHGFI_USEFILEATTRIBUTES = 0x00000010
$SHGFI_LARGEICON = 0x00000000
$FILE_ATTRIBUTE_NORMAL = 0x00000080

foreach ($ext in $Exts.Split(',')) {
  $clean = $ext.Trim().ToLowerInvariant()
  if ($clean.Length -lt 2 -or -not $clean.StartsWith('.')) { continue }

  $info = New-Object DshShellIcon+SHFILEINFO
  $size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $flags = $SHGFI_ICON -bor $SHGFI_USEFILEATTRIBUTES -bor $SHGFI_LARGEICON
  $handle = [DshShellIcon]::SHGetFileInfo("file$clean", $FILE_ATTRIBUTE_NORMAL, [ref]$info, $size, $flags)
  if ($handle -eq [IntPtr]::Zero -or $info.hIcon -eq [IntPtr]::Zero) { continue }

  try {
    $icon = [System.Drawing.Icon]::FromHandle($info.hIcon)
    $bitmap = $icon.ToBitmap()
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    [Console]::Out.WriteLine("$clean`t" + [Convert]::ToBase64String($stream.ToArray()))
    $stream.Dispose()
    $bitmap.Dispose()
    $icon.Dispose()
  }
  finally {
    [DshShellIcon]::DestroyIcon($info.hIcon) | Out-Null
  }
}
