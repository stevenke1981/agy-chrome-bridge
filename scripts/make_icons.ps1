# Regenerates extension/icons/icon{16,32,48,128}.png. Windows PowerShell or pwsh on Windows.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force -Path $out | Out-Null

function New-RoundedRect([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $p = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

# Master drawing at 512 px; every size is a high-quality downscale of it.
$S = 512
$master = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($master)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

# Tile: deep violet to teal diagonal gradient.
$tile = New-RoundedRect 16 16 480 480 112
$grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush ([System.Drawing.Point]::new(0, 0)), ([System.Drawing.Point]::new($S, $S)), ([System.Drawing.Color]::FromArgb(255, 76, 50, 214)), ([System.Drawing.Color]::FromArgb(255, 14, 170, 190))
$g.FillPath($grad, $tile)

# Solid arch-bridge silhouette: a deck block with a semicircular opening.
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$bridge = New-Object System.Drawing.Region (New-RoundedRect 84 214 344 168 30)
$hole = New-Object System.Drawing.Drawing2D.GraphicsPath
$hole.AddEllipse(150, 286, 212, 212)
$bridge.Exclude($hole)
$g.FillRegion($white, $bridge)
# Signal dot above the deck (the agent "spark").
$spark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 214, 102))
$g.FillEllipse($spark, 212, 96, 88, 88)
$g.Dispose()

foreach ($size in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $sg = [System.Drawing.Graphics]::FromImage($bmp)
    $sg.InterpolationMode = 'HighQualityBicubic'
    $sg.PixelOffsetMode = 'HighQuality'
    $sg.SmoothingMode = 'AntiAlias'
    $sg.DrawImage($master, 0, 0, $size, $size)
    $sg.Dispose()
    $bmp.Save((Join-Path $out "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
$master.Dispose()
Write-Output "Icons written to $out"
