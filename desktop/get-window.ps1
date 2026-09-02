Add-Type @'
using System;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;

public class ActiveWindowTracker {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    public static string GetActiveInfo() {
        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero) return "{\"process\":\"unknown\",\"title\":\"\"}";

        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hwnd, sb, 512);
        string title = sb.ToString();

        uint pid = 0;
        GetWindowThreadProcessId(hwnd, out pid);
        string procName = "unknown";
        if (pid > 0) {
            try {
                Process p = Process.GetProcessById((int)pid);
                procName = p.ProcessName;
            } catch {}
        }

        string cleanTitle = title.Replace("\"", "\\\"").Replace("\r", "").Replace("\n", " ");
        return "{\"process\":\"" + procName + "\",\"title\":\"" + cleanTitle + "\"}";
    }
}
'@ -ErrorAction SilentlyContinue

[ActiveWindowTracker]::GetActiveInfo()
