try {
    Add-Type -ReferencedAssemblies 'System.Drawing', 'System.Windows.Forms' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public class NativeScreenCapture {
    [DllImport("user32.dll")]
    public static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    public static extern bool BitBlt(IntPtr hObject, int nXDest, int nYDest, int nWidth, int nHeight, IntPtr hObjectSource, int nXSrc, int nYSrc, int dwRop);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    private const int SRCCOPY = 0x00CC0020;
    private const int SM_CXSCREEN = 0;
    private const int SM_CYSCREEN = 1;

    public static string CaptureBase64(int maxDim, int quality) {
        try { SetProcessDPIAware(); } catch {}
        int w = GetSystemMetrics(SM_CXSCREEN);
        int h = GetSystemMetrics(SM_CYSCREEN);
        if (w <= 0 || h <= 0) {
            w = 1280;
            h = 720;
        }

        Bitmap srcBmp = null;
        IntPtr hDesk = GetDesktopWindow();
        IntPtr hSrcDC = GetDC(hDesk);

        if (hSrcDC != IntPtr.Zero) {
            try {
                srcBmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(srcBmp)) {
                    IntPtr hDestDC = g.GetHdc();
                    try {
                        BitBlt(hDestDC, 0, 0, w, h, hSrcDC, 0, 0, SRCCOPY);
                    } finally {
                        g.ReleaseHdc(hDestDC);
                    }
                }
            } catch {
                if (srcBmp != null) {
                    srcBmp.Dispose();
                    srcBmp = null;
                }
            } finally {
                ReleaseDC(hDesk, hSrcDC);
            }
        }

        // Fallback: CopyFromScreen
        if (srcBmp == null) {
            try {
                srcBmp = new Bitmap(w, h);
                using (Graphics g = Graphics.FromImage(srcBmp)) {
                    g.CopyFromScreen(0, 0, 0, 0, new Size(w, h));
                }
            } catch {
                if (srcBmp != null) {
                    srcBmp.Dispose();
                    srcBmp = null;
                }
            }
        }

        if (srcBmp == null) {
            return string.Empty;
        }

        // Downscale to maxDim
        int targetW = w;
        int targetH = h;
        if (w > maxDim || h > maxDim) {
            if (w >= h) {
                targetW = maxDim;
                targetH = (int)((long)h * maxDim / w);
            } else {
                targetH = maxDim;
                targetW = (int)((long)w * maxDim / h);
            }
        }

        Bitmap scaledBmp = new Bitmap(targetW, targetH);
        using (Graphics gScaled = Graphics.FromImage(scaledBmp)) {
            gScaled.InterpolationMode = InterpolationMode.Bilinear;
            gScaled.CompositingQuality = CompositingQuality.HighSpeed;
            gScaled.SmoothingMode = SmoothingMode.None;
            gScaled.DrawImage(srcBmp, 0, 0, targetW, targetH);
        }
        srcBmp.Dispose();

        // Encode as JPEG with specified quality
        ImageCodecInfo jpgEncoder = null;
        foreach (var codec in ImageCodecInfo.GetImageEncoders()) {
            if (codec.FormatID == ImageFormat.Jpeg.Guid) {
                jpgEncoder = codec;
                break;
            }
        }

        if (jpgEncoder == null) {
            scaledBmp.Dispose();
            return string.Empty;
        }

        using (EncoderParameters encParams = new EncoderParameters(1)) {
            using (EncoderParameter qParam = new EncoderParameter(Encoder.Quality, (long)quality)) {
                encParams.Param[0] = qParam;
                using (MemoryStream ms = new MemoryStream()) {
                    scaledBmp.Save(ms, jpgEncoder, encParams);
                    scaledBmp.Dispose();
                    byte[] bytes = ms.ToArray();
                    return Convert.ToBase64String(bytes);
                }
            }
        }
    }
}
'@
} catch {
    # If type is already defined in this PowerShell session, ignore error
}

$frame = [NativeScreenCapture]::CaptureBase64(800, 35)
if ($frame) {
    [Console]::WriteLine($frame)
}
