$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "docs\assets\hud-photo.jpg"
$tmp = Join-Path $root "docs\assets\hud-photo.tmp.jpg"
$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap $img
$img.Dispose()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters 1
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 88
$bmp.Save($tmp, $codec, $params)
$bmp.Dispose()
Move-Item -Force $tmp $src
Write-Output ("stripped: " + (Get-Item $src).Length + " bytes")
