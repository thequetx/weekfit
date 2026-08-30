# Turns raw screenshots into the directory listing's required shape:
# 1200x800 (3:2), PNG, well under the 5 MB cap.
#
# PNG rather than JPEG on purpose. These are UI screenshots — thin grid lines,
# small text, flat blocks of colour — and JPEG's chroma subsampling puts halos
# around exactly that. PNG of a screenshot this size lands around 200-400 KB,
# nowhere near the limit, so there is nothing to buy by lossy-compressing it.
#
# Aspect is corrected by cropping, never by squashing: an Obsidian window that
# has been stretched to fit a 3:2 box looks subtly wrong in a way people notice
# without being able to say why. The crop is centred, and the script says how
# much it removed so you can check it took nothing important.
#
#   powershell -File scripts/listing-images.ps1 -In shots -Out shots/out

param(
  [string]$In  = "shots",
  [string]$Out = "shots/out",
  [int]$Width  = 1200,
  [int]$Height = 800
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $In)) { Write-Error "No input folder: $In"; exit 1 }
New-Item -ItemType Directory -Force $Out | Out-Null

$files = Get-ChildItem $In -File | Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|bmp|webp)$' }
if (-not $files) { Write-Error "No images in $In"; exit 1 }

$targetRatio = $Width / $Height

foreach ($f in $files) {
  $src = [System.Drawing.Image]::FromFile($f.FullName)
  try {
    $ratio = $src.Width / $src.Height

    # Centre-crop to the target ratio first, so the resize never distorts.
    if ([Math]::Abs($ratio - $targetRatio) -lt 0.001) {
      $cx = 0; $cy = 0; $cw = $src.Width; $ch = $src.Height
    } elseif ($ratio -gt $targetRatio) {
      $ch = $src.Height
      $cw = [int][Math]::Round($src.Height * $targetRatio)
      $cx = [int][Math]::Round(($src.Width - $cw) / 2); $cy = 0
    } else {
      $cw = $src.Width
      $ch = [int][Math]::Round($src.Width / $targetRatio)
      $cx = 0; $cy = [int][Math]::Round(($src.Height - $ch) / 2)
    }

    $bmp = New-Object System.Drawing.Bitmap($Width, $Height)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      # Text and hairline grid rules are the whole subject here, so quality
      # settings are maxed rather than left at the defaults.
      $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $srcRect = New-Object System.Drawing.Rectangle($cx, $cy, $cw, $ch)
      $dstRect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
      $g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    } finally { $g.Dispose() }

    # Absolute: GDI+ resolves paths against the process working directory,
    # not PowerShell's, and fails a relative save with a bare
    # "A generic error occurred in GDI+" that names nothing.
    $dest = Join-Path (Resolve-Path $Out).Path ($f.BaseName + ".png")
    $bmp.Save($dest, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $size = (Get-Item $dest).Length
    $trimmed = if ($cw -eq $src.Width -and $ch -eq $src.Height) { "no crop" }
               else { "cropped {0}x{1} -> {2}x{3}" -f $src.Width, $src.Height, $cw, $ch }
    "{0,-42} {1,5}x{2}  {3,8:N0} bytes  ({4})" -f $f.Name, $Width, $Height, $size, $trimmed
  }
  finally { $src.Dispose() }
}

""
"Written to $Out. All PNG, {0}x{1}, well under the 5 MB cap." -f $Width, $Height
