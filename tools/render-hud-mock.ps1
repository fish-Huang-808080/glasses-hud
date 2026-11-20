$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$json = Get-Content -Path (Join-Path $root ".state\hud-mock.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$outPath = Join-Path $root "docs\assets\hud-mock.png"
New-Item -ItemType Directory -Force -Path (Split-Path $outPath) | Out-Null

$W = 1200; $H = 600
$bmp = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::FromArgb(255, 4, 6, 5))

# radial glow (waveguide)
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(170, 130, 880, 360)
$pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
$pgb.CenterColor = [System.Drawing.Color]::FromArgb(70, 40, 200, 110)
$pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
$g.FillPath($pgb, $path)
$pgb.Dispose(); $path.Dispose()

$font = [System.Drawing.Font]::new("NSimSun", 30, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$text = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 82, 255, 158))
$glow = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(55, 60, 255, 140))
$leftX = 150
$rightX = 850

function Draw-Pair($left, $right, $y) {
    if ($left)  { $g.DrawString($left,  $font, $glow, ($leftX - 1), ($y + 1)) }
    if ($right) { $rw = $g.MeasureString($right, $font).Width; $g.DrawString($right, $font, $glow, ($rightX - $rw - 1), ($y + 1)) }
    if ($left)  { $g.DrawString($left,  $font, $text, $leftX, $y) }
    if ($right) { $rw = $g.MeasureString($right, $font).Width; $g.DrawString($right, $font, $text, ($rightX - $rw), $y) }
}

Draw-Pair $json.line1[0] $json.line1[1] 200
Draw-Pair $json.line2[0] $json.line2[1] 252
Draw-Pair $json.line3[0] $json.line3[1] 304

# progress bar: draw each cell
$bar = [string]$json.bar
$cellW = $g.MeasureString("X", $font).Width
$filled = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 82, 255, 158))
$empty = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(90, 82, 255, 158))
$fullChar = [string][char]0x2588
$emptyChar = [string][char]0x2591
$x = $leftX
foreach ($ch in $bar.ToCharArray()) {
    $brush = $empty
    $glyph = $emptyChar
    if ([int][char]$ch -eq 0x2588) { $brush = $filled; $glyph = $fullChar }
    $g.DrawString($glyph, $font, $brush, $x, 356)
    $x += $cellW
}
$filled.Dispose(); $empty.Dispose()

$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("saved: " + $outPath)
