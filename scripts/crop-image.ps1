param(
  [Parameter(Mandatory=$true)][string]$InPath,
  [Parameter(Mandatory=$true)][string]$OutPath,
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 0,
  [int]$H = 0
)

# Crop an image region with System.Drawing and save as PNG. Used by the plugin's
# `region` option on get_window_state so long documents don't ship a full-window
# screenshot at full token cost. Reads any format GDI+ can open (jpg/png/...).

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
$img = [System.Drawing.Image]::FromFile($InPath)
try {
  $x = [Math]::Max(0, [Math]::Min($X, $img.Width - 1))
  $y = [Math]::Max(0, [Math]::Min($Y, $img.Height - 1))
  $w = if ($W -le 0) { $img.Width - $x } else { [Math]::Min($W, $img.Width - $x) }
  $h = if ($H -le 0) { $img.Height - $y } else { [Math]::Min($H, $img.Height - $y) }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  try {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $w, $h), (New-Object System.Drawing.Rectangle $x, $y, $w, $h), [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $g.Dispose() }
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bmp.Dispose() }
} finally { $img.Dispose() }
Write-Output 'ok'
