Add-Type @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class WorkstationMonitor {
    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public uint cbSize;
        public uint dwTime;
    }

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    [DllImport("kernel32.dll")]
    public static extern uint GetTickCount();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public static uint GetIdleSeconds() {
        LASTINPUTINFO lii = new LASTINPUTINFO();
        lii.cbSize = (uint)Marshal.SizeOf(lii);
        if (GetLastInputInfo(ref lii)) {
            return (GetTickCount() - lii.dwTime) / 1000;
        }
        return 0;
    }

    public static string Sample() {
        uint idle = GetIdleSeconds();
        IntPtr hwnd = GetForegroundWindow();
        string procName = "unknown";
        string cleanTitle = "";

        if (hwnd != IntPtr.Zero) {
            StringBuilder sb = new StringBuilder(512);
            GetWindowText(hwnd, sb, 512);
            cleanTitle = sb.ToString().Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");

            uint pid = 0;
            GetWindowThreadProcessId(hwnd, out pid);
            if (pid > 0) {
                try {
                    Process p = Process.GetProcessById((int)pid);
                    procName = p.ProcessName;
                } catch {}
            }
        }

        return "{\"idle\":" + idle + ",\"process\":\"" + procName + "\",\"title\":\"" + cleanTitle + "\"}";
    }
}
'@ -ErrorAction SilentlyContinue

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

while ($true) {
    try {
        $json = [WorkstationMonitor]::Sample()
        # Fallback if GetForegroundWindow returned unknown
        if ($json -match '"process":"unknown"') {
            try {
                $top = (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1)
                if ($top) {
                    $idle = [WorkstationMonitor]::GetIdleSeconds()
                    $t = $top.MainWindowTitle.Replace('"', '\"').Replace("`r", "").Replace("`n", " ")
                    $json = "{`"idle`":$idle,`"process`":`"$($top.ProcessName)`",`"title`":`"$t`"}"
                }
            } catch {}
        }
        [Console]::WriteLine($json)
    } catch {}
    Start-Sleep -Milliseconds 1000
}
